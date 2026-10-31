mod download;
mod node;
mod sidecar;
mod supervisor;
mod update;

use serde::Serialize;
use sidecar::DesktopEvent;
use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_notification::NotificationExt;
#[cfg(windows)]
use tauri_winrt_notification::Toast;

const DEFAULT_PORT: u16 = 9528;
/// 端口被占时往后顺延的尝试次数。
const PORT_FALLBACK_ATTEMPTS: u16 = 20;
const STARTUP_SLOW_AFTER_SECS: u64 = 30;
const STARTUP_TIMEOUT_SECS: u64 = 60;

struct AppState {
  sidecar: sidecar::SharedSidecar,
  port: Mutex<Option<u16>>,
  notifications_enabled: AtomicBool,
  update_channel: Mutex<update::UpdateChannel>,
  last_session: Mutex<Option<(String, String)>>,
  quitting: AtomicBool,
  update_check_requested: AtomicBool,
  /// 最近一次启动状态文字，更新流程结束后恢复。
  splash: Mutex<String>,
  startup_failed: AtomicBool,
  updating: AtomicBool,
  /// 每次启动服务加一；旧的看门狗发现代数变了就退出。
  generation: AtomicU64,
  /// 正在重启服务（看门狗、托盘、服务自己请求的重启互斥）。
  restarting: AtomicBool,
  restart_budget: Mutex<supervisor::RestartBudget>,
  /// 串行化整条启动流程：并发点「重启服务」会把同一份 Node 写两遍、还会漏掉子进程。
  backend_lock: Mutex<()>,
  /// 下载临时目录与另存为队列。
  downloads: download::DownloadState,
  /// 服务版本只比对一次：更新后还连着旧服务时提醒用户重启。
  version_checked: AtomicBool,
}

/// 可以交给系统默认程序打开、但值得拦一下的可执行扩展名（脚本宿主同样算可执行）。
const EXECUTABLE_EXTENSIONS: [&str; 21] = [
  "exe", "msi", "bat", "cmd", "com", "scr", "ps1", "vbs", "vbe", "js", "jse", "hta", "msc", "jar", "wsf", "wsh", "lnk", "reg", "cpl", "dll", "application",
];

#[derive(Clone, Serialize)]
struct OpenSessionPayload {
  #[serde(rename = "workspaceId")]
  workspace_id: String,
  #[serde(rename = "sessionId")]
  session_id: String,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let settings = load_desktop_settings();
  let notifications_enabled = settings.get("notificationsEnabled").and_then(|value| value.as_bool()).unwrap_or(true);
  let update_channel = update::UpdateChannel::from_settings(&settings);
  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      show_main(app);
    }))
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .manage(AppState {
      sidecar: Arc::default(),
      port: Mutex::new(None),
      notifications_enabled: AtomicBool::new(notifications_enabled),
      update_channel: Mutex::new(update_channel),
      last_session: Mutex::new(None),
      quitting: AtomicBool::new(false),
      update_check_requested: AtomicBool::new(false),
      splash: Mutex::new(String::new()),
      startup_failed: AtomicBool::new(false),
      updating: AtomicBool::new(false),
      generation: AtomicU64::new(0),
      restarting: AtomicBool::new(false),
      restart_budget: Mutex::new(supervisor::RestartBudget::default()),
      backend_lock: Mutex::new(()),
      downloads: download::DownloadState::default(),
      version_checked: AtomicBool::new(false),
    })
    .invoke_handler(tauri::generate_handler![set_notifications_enabled, open_external_url, open_path, reveal_file_in_folder, take_update_check, check_desktop_update, update::get_update_channel, update::set_update_channel, update::check_channel_update])
    .setup(|app| {
      app.resources_table().add(sidecar::SidecarCleanup(Arc::clone(&app.state::<AppState>().sidecar)));
      let handle = app.handle().clone();
      // 顺序要求：先建窗口（下载/导航策略挂在 builder 上），再挂关闭即隐藏，最后才启动服务。
      let window = build_main_window(&handle)?;
      let window_clone = window.clone();
      window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
          api.prevent_close();
          let _ = window_clone.hide();
        }
      });
      build_tray(&handle).unwrap_or_else(|error| {
        // 托盘建不出来不影响主流程，别因为图标问题直接 abort 掉整个客户端。
        eprintln!("托盘创建失败：{error}");
      });
      thread::spawn(download::cleanup_stale);
      thread::spawn(move || start_backend(handle));
      Ok(())
    })
    .on_menu_event(|app, event| match event.id().as_ref() {
      "show" => show_main(app),
      "quit" => quit_app(app),
      "check-update" => request_update_check(app),
      "restart-service" => manual_restart(app),
      _ => {}
    })
    .build(tauri::generate_context!())
    .expect("error while building Jarvis desktop")
    .run(|app, event| match event {
      tauri::RunEvent::ExitRequested { api, .. } => {
        if !app.state::<AppState>().quitting.load(Ordering::Relaxed) {
          api.prevent_exit();
        }
      }
      tauri::RunEvent::Exit => stop_current_sidecar(app),
      _ => {}
    });
}

#[tauri::command]
fn set_notifications_enabled(state: State<AppState>, enabled: bool) {
  state.notifications_enabled.store(enabled, Ordering::Relaxed);
  save_desktop_setting("notificationsEnabled", serde_json::Value::Bool(enabled));
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
  open_http_url(&url)
}

/// 用系统默认程序打开本地文件；不打开可执行文件，避免把壳变成任意程序启动器。
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
  let requested = PathBuf::from(&path);
  if !requested.is_file() {
    return Err("文件不存在".into());
  }
  let file = fs::canonicalize(requested).map_err(|error| error.to_string())?;
  if is_executable_path(&file) {
    return Err("不打开可执行文件".into());
  }
  open::that_detached(&file).map_err(|error| error.to_string())
}

/// 按扩展名判定能不能交给系统默认程序。取最后一段，`a.pdf.exe` 这种双扩展名会被拦下来。
fn is_executable_path(path: &Path) -> bool {
  let name = path.file_name().map(|value| value.to_string_lossy().to_lowercase()).unwrap_or_default();
  let name = name.trim_end_matches(['.', ' ']);
  let extension = name.rsplit_once('.').map(|(_, extension)| extension).unwrap_or_default();
  EXECUTABLE_EXTENSIONS.contains(&extension)
}

#[tauri::command]
fn reveal_file_in_folder(path: String, cwd: Option<String>) -> Result<(), String> {
  let requested = PathBuf::from(&path);
  let file = if requested.is_absolute() {
    requested
  } else {
    PathBuf::from(cwd.ok_or_else(|| "缺少工作区路径".to_string())?).join(requested)
  };
  if !file.is_file() {
    return Err("文件不存在".into());
  }
  let file = fs::canonicalize(file).map_err(|error| error.to_string())?;
  reveal_in_file_manager(&file)
}

#[tauri::command]
fn take_update_check(state: State<AppState>) -> bool {
  state.update_check_requested.swap(false, Ordering::Relaxed)
}

/// 启动页“检查更新”按钮：服务没起来时也能更新。
#[tauri::command]
fn check_desktop_update(app: AppHandle) {
  update::spawn_manual_check(&app);
}

fn request_update_check(app: &AppHandle) {
  show_main(app);
  if backend_ready(app) {
    // 网页界面在线：沿用它的流程（会先确认没有正在运行的会话）。
    app.state::<AppState>().update_check_requested.store(true, Ordering::Relaxed);
    let _ = app.emit("jarvis://check-update", ());
  } else {
    update::spawn_manual_check(app);
  }
}

fn backend_ready(app: &AppHandle) -> bool {
  app.state::<AppState>().port.lock().map(|slot| slot.is_some()).unwrap_or(false)
}

/// 显示启动失败；`offer_update` 时先自动检查更新，有新版本就直接提示安装。
fn report_startup_failure(app: &AppHandle, error: &str, offer_update: bool) {
  app.state::<AppState>().startup_failed.store(true, Ordering::Relaxed);
  set_splash(app, "启动失败");
  if offer_update && !error.is_empty() {
    update::offer_after_startup_failure(app, error);
  } else if !error.is_empty() {
    show_alert(app, error);
  }
}

fn open_http_url(url: &str) -> Result<(), String> {
  if !url.starts_with("https://") && !url.starts_with("http://") {
    return Err("只支持 http(s) 链接".into());
  }
  open::that_detached(url).map_err(|error| error.to_string())
}

/// 建主窗口。下载、导航、新窗口三个策略只能挂在 builder 上，所以窗口必须在 Rust 里创建。
fn build_main_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
  let download_handle = app.clone();
  let navigation_handle = app.clone();
  let new_window_handle = app.clone();
  tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
    .title("Jarvis")
    .inner_size(1280.0, 800.0)
    .min_inner_size(800.0, 560.0)
    // wry 默认会连 msPdfOOUI 一起关掉，PDF 内嵌预览就没有工具栏；下载 UI（msWebOOUI）仍然关着，由 on_download 接管。
    // 注意这串是整体替换 wry 的默认参数，不是追加，所以 autoplay 策略要自己补回来。
    .additional_browser_args("--disable-features=msWebOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required")
    .on_navigation(move |url| {
      if divert_to_system(url, backend_port(&navigation_handle)) {
        open_in_system(&navigation_handle, url);
        return false;
      }
      true
    })
    .on_new_window(move |url, _features| {
      // 一律不新开 webview（新窗口没有下载/导航策略）。站外交系统浏览器；站内请求没有
      // 窗口 UI 可落，直接不放行，页面本身不动。
      if divert_to_system(&url, backend_port(&new_window_handle)) {
        open_in_system(&new_window_handle, &url);
      }
      tauri::webview::NewWindowResponse::Deny
    })
    .on_download(move |_webview, event| download::handle_event(&download_handle, event))
    .on_permission_request(|_webview, permission| {
      use tauri::webview::{PermissionKind as Kind, PermissionResponse as Response};
      match permission {
        // 壳里真正用到的：复制图表、桌面通知、音视频播放、连续下载。
        Kind::ClipboardRead | Kind::Notifications | Kind::Autoplay | Kind::AutomaticDownloads => Response::Allow,
        // 没有使用场景的硬件权限直接拒，不弹系统授权框。
        Kind::Camera
        | Kind::Microphone
        | Kind::Geolocation
        | Kind::DisplayCapture
        | Kind::Midi
        | Kind::Sensors
        | Kind::FileSystemAccess
        | Kind::PointerLock
        | Kind::LocalFonts
        | Kind::WindowManagement
        | Kind::MediaKeySystemAccess => Response::Deny,
        // 认不出的类型交给平台默认流程，不要一律拒掉。
        _ => Response::Default,
      }
    })
    .build()
}

/// 当前后端端口；服务没起来时用配置里的默认值（`open_ui` 也就是这个端口）。
fn backend_port(app: &AppHandle) -> u16 {
  current_port(app).unwrap_or_else(desktop_port)
}

/// 站外 http(s) 与 mailto/tel 交给系统处理，绝不替换窗口里的页面。
fn divert_to_system(url: &tauri::Url, port: u16) -> bool {
  match url.scheme() {
    "http" | "https" => !is_internal_web_url(url, port),
    "mailto" | "tel" => true,
    _ => false,
  }
}

/// 本机服务与 Tauri 内部页面留在窗口内。
///
/// 域名只认 `tauri.localhost` / `localhost`，其余必须能解析成真正的回环 IP——
/// `127.0.0.1.evil.com` 这种“长得像回环”的域名必须落到系统浏览器。
/// 回环地址还要端口对得上，否则会把壳的页面导到本机别的服务上。
fn is_internal_web_url(url: &tauri::Url, port: u16) -> bool {
  if url.scheme() == "tauri" {
    return true;
  }
  let Some(host) = url.host_str() else { return false };
  let host = host.trim_start_matches('[').trim_end_matches(']');
  let name = host.trim_end_matches('.');
  if name.eq_ignore_ascii_case("tauri.localhost") {
    return true;
  }
  if name.eq_ignore_ascii_case("localhost") {
    return url.port_or_known_default() == Some(port);
  }
  match name.parse::<std::net::IpAddr>() {
    Ok(ip) => ip.is_loopback() && url.port_or_known_default() == Some(port),
    Err(_) => false,
  }
}

fn open_in_system(app: &AppHandle, url: &tauri::Url) {
  if open::that_detached(url.as_str()).is_err() && url.scheme().starts_with("http") {
    show_alert(app, &format!("无法打开系统浏览器：{url}"));
  }
}

fn reveal_in_file_manager(file: &Path) -> Result<(), String> {
  let directory = file.parent().ok_or_else(|| "无法获取文件目录".to_string())?;
  #[cfg(target_os = "windows")]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    return std::process::Command::new("explorer.exe")
      .arg(directory)
      .stdin(std::process::Stdio::null())
      .stdout(std::process::Stdio::null())
      .stderr(std::process::Stdio::null())
      .creation_flags(CREATE_NO_WINDOW)
      .spawn()
      .map(|_| ())
      .map_err(|error| error.to_string());
  }
  #[cfg(target_os = "macos")]
  return std::process::Command::new("open").arg("-R").arg(file).spawn().map(|_| ()).map_err(|error| error.to_string());
  #[cfg(target_os = "linux")]
  return std::process::Command::new("xdg-open").arg(directory).spawn().map(|_| ()).map_err(|error| error.to_string());
}

/// 下载保存完成后的提示；点击定位到文件。
fn notify_saved(app: &AppHandle, path: &Path) {
  let body = path.display().to_string();
  let body = if body.chars().count() > 140 {
    format!("{}…", body.chars().take(140).collect::<String>())
  } else {
    body
  };
  #[cfg(windows)]
  {
    let app_id = app.config().identifier.clone();
    let target = path.to_path_buf();
    let _ = Toast::new(&app_id)
      .title("已保存")
      .text1(&body)
      .on_activated(move |_| {
        let _ = reveal_in_file_manager(&target);
        Ok(())
      })
      .show();
    return;
  }
  #[cfg(not(windows))]
  {
    let _ = app.notification().builder().title("已保存").body(body).show();
  }
}

/// 下载失败时的提示；静默失败会让人以为「点了没反应」。
fn notify_failed(app: &AppHandle, body: &str) {
  #[cfg(windows)]
  {
    let app_id = app.config().identifier.clone();
    let _ = Toast::new(&app_id).title("下载失败").text1(body).show();
    return;
  }
  #[cfg(not(windows))]
  {
    let _ = app.notification().builder().title("下载失败").body(body).show();
  }
}

#[cfg(test)]
mod port_tests {
  use super::free_port_from;
  use std::net::TcpListener;

  #[test]
  fn skips_the_port_it_was_given() {
    // 占住一个大号临时端口，确认顺延找到的是别的可用端口。
    let busy = TcpListener::bind(("0.0.0.0", 0)).unwrap();
    let port = busy.local_addr().unwrap().port();
    if port >= u16::MAX - 25 {
      return;
    }
    let free = free_port_from(port).expect("应该能找到可用端口");
    assert_ne!(free, port);
    assert!(free > port);
    assert!(TcpListener::bind(("0.0.0.0", free)).is_ok());
  }

  #[test]
  fn refuses_to_wrap_past_the_top() {
    assert_eq!(free_port_from(u16::MAX), None);
  }
}

#[cfg(test)]
mod navigation_tests {
  use super::{divert_to_system, is_internal_web_url};
  use tauri::Url;

  fn url(value: &str) -> Url {
    Url::parse(value).unwrap()
  }

  #[test]
  fn keeps_the_local_service_in_app() {
    for value in ["http://127.0.0.1:9528/#/chat", "http://localhost:9528/", "http://tauri.localhost/index.html", "tauri://localhost/index.html"] {
      assert!(!divert_to_system(&url(value), 9528), "{value}");
    }
  }

  #[test]
  fn sends_external_targets_to_the_system() {
    for value in ["https://example.com/a", "http://192.168.1.5:9528/", "mailto:a@b.c", "tel:10086"] {
      assert!(divert_to_system(&url(value), 9528), "{value}");
    }
  }

  #[test]
  fn treats_lookalike_domains_as_external() {
    // 域名长得像回环，但不是回环地址：绝不能留在壳里替换界面。
    for value in ["http://127.0.0.1.evil.com/", "http://127.evil.com/", "http://localhost.evil.com/", "http://tauri.localhost.evil.com/"] {
      assert!(divert_to_system(&url(value), 9528), "{value}");
    }
  }

  #[test]
  fn leaves_in_app_schemes_alone() {
    for value in ["about:blank", "data:text/plain,1", "blob:http://127.0.0.1:9528/x"] {
      assert!(!divert_to_system(&url(value), 9528), "{value}");
    }
  }

  #[test]
  fn treats_loopback_variants_as_internal() {
    assert!(is_internal_web_url(&url("http://127.0.0.5:9528/"), 9528));
    assert!(is_internal_web_url(&url("http://[::1]:9528/"), 9528));
    assert!(is_internal_web_url(&url("http://localhost.:9528/"), 9528));
    assert!(!is_internal_web_url(&url("https://example.com/"), 9528));
  }

  #[test]
  fn only_the_backend_port_counts_as_internal() {
    // 本机别的服务（dev server、其他工具）要把页面导出去，不能顶掉壳里的界面。
    assert!(!is_internal_web_url(&url("http://127.0.0.1:5173/"), 9528));
    assert!(!is_internal_web_url(&url("http://localhost:39528/"), 9528));
    assert!(is_internal_web_url(&url("http://127.0.0.1:9529/"), 9529));
  }
}

#[cfg(test)]
mod open_path_tests {
  use super::is_executable_path;
  use std::path::Path;

  #[test]
  fn blocks_script_hosts_and_binaries() {
    for name in ["a.exe", "a.EXE", "setup.msi", "run.bat", "x.ps1", "payload.js", "x.hta", "x.msc", "x.jar", "x.lnk", "x.reg", "x.dll"] {
      assert!(is_executable_path(Path::new(name)), "{name}");
    }
  }

  #[test]
  fn allows_documents_and_previews() {
    for name in ["a.md", "a.txt", "a.pdf", "a.PDF", "a.png", "a.zip", "a.xlsx", "目录/报告.docx"] {
      assert!(!is_executable_path(Path::new(name)), "{name}");
    }
  }

  #[test]
  fn blocks_double_extensions() {
    assert!(is_executable_path(Path::new("合同.pdf.exe")));
    assert!(is_executable_path(Path::new("evil.exe.")));
  }
}

#[cfg(test)]
mod open_url_tests {
  use super::open_http_url;

  #[test]
  fn rejects_non_http() {
    assert!(open_http_url("javascript:alert(1)").is_err());
    assert!(open_http_url("file:///C:/Windows/notepad.exe").is_err());
  }
}

fn start_backend(app: AppHandle) {
  // 串行化：托盘点「重启服务」跟启动期/看门狗同时跑时，两边会写同一份 node.exe.part、
  // 还会把旧的 sidecar 覆盖成无人管的进程。
  let state = app.state::<AppState>();
  let startup_guard = state.backend_lock.lock().unwrap_or_else(|error| error.into_inner());
  app.state::<AppState>().generation.fetch_add(1, Ordering::SeqCst);
  app.state::<AppState>().startup_failed.store(false, Ordering::Relaxed);
  app.state::<AppState>().version_checked.store(false, Ordering::Relaxed);
  set_splash(&app, "正在启动");
  let mut port = desktop_port();
  if let Ok(mut slot) = app.state::<AppState>().port.lock() {
    *slot = None;
  }
  let mut notice: Option<String> = None;
  match probe_existing_jarvis(port) {
    Some(true) => {
      mark_backend_ready(&app, port);
      return;
    }
    Some(false) => {
      if port_pinned() {
        report_startup_failure(&app, &format!("端口 {port} 已被其他程序占用（由 JARVIS_PORT 指定，不顺延）"), false);
        return;
      }
      // 端口被别的程序占着就往后再找：宁可用另一个端口启动，也不要一启动就失败。
      match free_port_from(port) {
        Some(next) => {
          notice = Some(format!("端口 {port} 被占用，已改用 {next}"));
          port = next;
        }
        None => {
          report_startup_failure(&app, &format!("端口 {port} 及后来 {PORT_FALLBACK_ATTEMPTS} 个端口都被占用"), false);
          return;
        }
      }
    }
    None => {}
  }
  let root = jarvis_root(&app);
  let node = match node::resolve_node(&root) {
    Ok(path) => path,
    Err(_) => match download_runtime_node(&app) {
      Ok(path) => path,
      Err(error) => {
        // 空字符串表示用户取消了 Node 下载，不再弹窗。
        report_startup_failure(&app, &error, true);
        return;
      }
    },
  };
  set_splash(&app, notice.as_deref().unwrap_or("正在启动服务"));
  let app_for_events = app.clone();
  match sidecar::spawn_managed_sidecar(&app.state::<AppState>().sidecar, &node, &root, port, move |event| handle_event(&app_for_events, event)) {
    Ok(true) => {}
    Ok(false) => return,
    Err(error) => {
      report_startup_failure(&app, &error, true);
      return;
    }
  }
  if let Err(error) = wait_for_backend(&app, port, Duration::from_secs(STARTUP_TIMEOUT_SECS)) {
    stop_current_sidecar(&app);
    report_startup_failure(&app, &error, true);
  }
  drop(startup_guard);
}

fn handle_event(app: &AppHandle, event: DesktopEvent) {
  match event {
    DesktopEvent::Ready { port } => mark_backend_ready(app, port),
    DesktopEvent::Restart => {
      // 在单独线程里重启：当前是读服务输出的线程，优雅关闭期间还要继续读。
      let app = app.clone();
      thread::spawn(move || restart_sidecar(&app));
    }
    DesktopEvent::RunFinished {
      workspace_id,
      session_id,
      failed,
      session_name,
      text,
      error_message,
      ..
    } => {
      if let Ok(mut slot) = app.state::<AppState>().last_session.lock() {
        *slot = Some((workspace_id.clone(), session_id.clone()));
      }
      notify_run(app, &workspace_id, &session_id, failed, session_name.as_deref(), text.as_deref(), error_message.as_deref());
    }
  }
}

fn mark_backend_ready(app: &AppHandle, port: u16) {
  let newly_ready = app.state::<AppState>().port.lock().map(|mut slot| {
    let was_ready = *slot == Some(port);
    *slot = Some(port);
    !was_ready
  }).unwrap_or(true);
  if !newly_ready {
    return;
  }
  open_ui(app, port);
  spawn_watchdog(app, port);
  verify_service_version(app, port);
}

/// 服务版本和客户端不一致时提醒一次：更新后旧服务没退，接口可能对不上（如 /api/files）。
fn verify_service_version(app: &AppHandle, port: u16) {
  // 只有比对成功才记一笔：服务刚起来时偶发一次请求失败，还得有机会再试。
  if app.state::<AppState>().version_checked.load(Ordering::SeqCst) {
    return;
  }
  let app = app.clone();
  thread::spawn(move || {
    let url = format!("http://127.0.0.1:{port}/api/health");
    let Ok(response) = ureq::get(&url).timeout(Duration::from_secs(2)).call() else { return };
    let Ok(body) = response.into_json::<serde_json::Value>() else { return };
    app.state::<AppState>().version_checked.store(true, Ordering::SeqCst);
    let running = body.get("appVersion").and_then(|value| value.as_str()).unwrap_or_default();
    let expected = env!("CARGO_PKG_VERSION");
    if running.is_empty() || running == "unknown" || running == expected {
      return;
    }
    show_alert(&app, &format!("正在运行的服务是 {running}，本客户端是 {expected}。可能是更新前的旧服务还在跑：在托盘菜单里点「重启服务」。"));
  });
}

/// 看门狗：每 5 秒看一次服务进程和 /api/health。进程退出或连续 4 次没响应，就自动重启；
/// 5 分钟内最多自动重启 3 次，超过就停下来提示用户。
fn spawn_watchdog(app: &AppHandle, port: u16) {
  let generation = app.state::<AppState>().generation.load(Ordering::SeqCst);
  let app = app.clone();
  thread::spawn(move || {
    let mut missed = 0u32;
    loop {
      thread::sleep(supervisor::CHECK_INTERVAL);
      let state = app.state::<AppState>();
      if state.generation.load(Ordering::SeqCst) != generation || state.quitting.load(Ordering::Relaxed) {
        return;
      }
      // 检查/安装更新期间只暂停：没有更新或用户点了“稍后”时，还要继续看着服务。
      if state.updating.load(Ordering::Relaxed) || state.restarting.load(Ordering::SeqCst) || sidecar_closing(&app) {
        missed = 0;
        continue;
      }
      if let Some(reason) = sidecar_exit_reason(&app) {
        recover_backend(&app, &reason);
        return;
      }
      if matches!(probe_jarvis(port, supervisor::HEALTH_TIMEOUT), Some(true)) {
        missed = 0;
        continue;
      }
      missed += 1;
      if missed >= supervisor::MAX_MISSED_HEALTH {
        recover_backend(&app, &format!("Jarvis 服务连续 {missed} 次没有响应"));
        return;
      }
    }
  });
}

fn sidecar_closing(app: &AppHandle) -> bool {
  app.state::<AppState>().sidecar.lock().map(|slot| slot.closing).unwrap_or(false)
}

/// 服务进程已退出时返回原因（含最后几行输出），并清掉进程记录。
fn sidecar_exit_reason(app: &AppHandle) -> Option<String> {
  let state = app.state::<AppState>();
  let Ok(mut slot) = state.sidecar.lock() else { return None };
  let sidecar = slot.child.as_mut()?;
  let status = match sidecar.try_wait() {
    Ok(Some(status)) => status,
    _ => return None,
  };
  let diagnostics = sidecar.diagnostics();
  slot.child = None;
  Some(startup_failure(&format!("Jarvis 服务意外退出（{status}）"), &diagnostics))
}

fn recover_backend(app: &AppHandle, reason: &str) {
  if let Ok(mut slot) = app.state::<AppState>().port.lock() {
    *slot = None;
  }
  let allowed = app.state::<AppState>().restart_budget.lock().map(|mut budget| {
    if budget.try_take(Instant::now()) { Some(budget.backoff()) } else { None }
  }).unwrap_or(Some(Duration::from_secs(1)));
  let Some(backoff) = allowed else {
    show_alert(app, &format!(
      "Jarvis 服务多次异常退出，已停止自动重启。\n\n可以在托盘菜单点“重启服务”再试；设置 → 关于与更新 里可以导出诊断包。\n\n{reason}"
    ));
    return;
  };
  let _ = app.notification().builder().title("Jarvis").body("服务异常退出，正在自动重启…").show();
  thread::sleep(backoff);
  if app.state::<AppState>().quitting.load(Ordering::Relaxed) {
    return;
  }
  restart_sidecar(app);
  if backend_ready(app) {
    let _ = app.notification().builder().title("Jarvis").body("服务已自动恢复").show();
  }
}

/// 托盘“重启服务”：不依赖服务本身还活着；手动重启会清空自动重启计数。
fn manual_restart(app: &AppHandle) {
  if let Ok(mut budget) = app.state::<AppState>().restart_budget.lock() {
    budget.reset();
  }
  let app = app.clone();
  thread::spawn(move || restart_sidecar(&app));
}

fn open_ui(app: &AppHandle, port: u16) {
  let url = format!("http://127.0.0.1:{port}/");
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.eval(&format!("location.replace({url:?})"));
    let _ = window.show();
  }
}

fn notify_run(app: &AppHandle, _workspace_id: &str, _session_id: &str, failed: bool, session_name: Option<&str>, text: Option<&str>, error_message: Option<&str>) {
  let state = app.state::<AppState>();
  if !state.notifications_enabled.load(Ordering::Relaxed) {
    return;
  }
  if window_is_front(app) {
    return;
  }
  let name = match session_name {
    Some(value) if !value.is_empty() => value,
    _ => "Jarvis",
  };
  let title = if failed { format!("{name} · 运行失败") } else { format!("{name} · 已完成") };
  let body = if failed {
    error_message.or(text).unwrap_or("会话运行失败，请查看详情")
  } else {
    let trimmed = text.unwrap_or("").trim();
    if trimmed.is_empty() { "回答已完成" } else { trimmed }
  };
  let body = if body.chars().count() > 140 {
    format!("{}…", body.chars().take(140).collect::<String>())
  } else {
    body.to_string()
  };
  #[cfg(windows)]
  {
    let workspace_id = _workspace_id.to_owned();
    let session_id = _session_id.to_owned();
    let app = app.clone();
    let app_id = app.config().identifier.clone();
    let _ = Toast::new(&app_id)
      .title(&title)
      .text1(&body)
      .on_activated(move |_| {
        show_main(&app);
        let _ = app.emit("jarvis://open-session", OpenSessionPayload { workspace_id: workspace_id.clone(), session_id: session_id.clone() });
        Ok(())
      })
      .show();
    return;
  }
  #[cfg(not(windows))]
  {
    let _ = app.notification().builder().title(title).body(body).show();
  }
}

fn window_is_front(app: &AppHandle) -> bool {
  app.get_webview_window("main").is_some_and(|window| {
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    visible && focused
  })
}

fn restart_sidecar(app: &AppHandle) {
  let state = app.state::<AppState>();
  if state.restarting.swap(true, Ordering::SeqCst) {
    return;
  }
  if let Ok(mut slot) = state.port.lock() {
    *slot = None;
  }
  stop_current_sidecar(app);
  start_backend(app.clone());
  app.state::<AppState>().restarting.store(false, Ordering::SeqCst);
}

fn stop_current_sidecar(app: &AppHandle) {
  sidecar::stop_managed_sidecar(&app.state::<AppState>().sidecar, false);
}

fn wait_for_backend(app: &AppHandle, port: u16, timeout: Duration) -> Result<(), String> {
  let started_at = Instant::now();
  let deadline = started_at + timeout;
  let mut slow_notice_shown = false;
  while Instant::now() < deadline {
    if backend_is_ready(port) {
      mark_backend_ready(app, port);
      return Ok(());
    }
    if let Some(error) = sidecar_exit_error(app) {
      return Err(error);
    }
    if !slow_notice_shown && started_at.elapsed() >= Duration::from_secs(STARTUP_SLOW_AFTER_SECS) {
      set_splash(app, "启动时间较长");
      slow_notice_shown = true;
    }
    thread::sleep(Duration::from_millis(200));
  }
  if backend_is_ready(port) {
    mark_backend_ready(app, port);
    return Ok(());
  }
  if let Some(error) = sidecar_exit_error(app) {
    return Err(error);
  }
  Err(startup_failure(
    &format!("Jarvis 服务未能在 {STARTUP_TIMEOUT_SECS} 秒内启动"),
    &sidecar_diagnostics(app),
  ))
}

fn backend_is_ready(port: u16) -> bool {
  matches!(probe_jarvis(port, Duration::from_millis(500)), Some(true))
}

fn sidecar_exit_error(app: &AppHandle) -> Option<String> {
  let state = app.state::<AppState>();
  let Ok(mut slot) = state.sidecar.lock() else { return None };
  let sidecar = slot.child.as_mut()?;
  let status = match sidecar.try_wait() {
    Ok(Some(status)) => status,
    Ok(None) => return None,
    Err(error) => return Some(startup_failure(&format!("无法读取 Jarvis 服务状态：{error}"), &sidecar.diagnostics())),
  };
  thread::sleep(Duration::from_millis(100));
  let diagnostics = sidecar.diagnostics();
  slot.child = None;
  Some(startup_failure(&format!("Jarvis 服务启动后意外退出（{status}）"), &diagnostics))
}

fn sidecar_diagnostics(app: &AppHandle) -> String {
  app.state::<AppState>().sidecar.lock().ok().and_then(|slot| slot.child.as_ref().map(|sidecar| sidecar.diagnostics())).unwrap_or_default()
}

fn startup_failure(summary: &str, diagnostics: &str) -> String {
  const MAX_DIAGNOSTIC_CHARS: usize = 2_000;
  let diagnostics = diagnostics.trim();
  if diagnostics.is_empty() {
    return summary.to_string();
  }
  let detail = if diagnostics.chars().count() > MAX_DIAGNOSTIC_CHARS {
    format!("{}...", diagnostics.chars().take(MAX_DIAGNOSTIC_CHARS).collect::<String>())
  } else {
    diagnostics.to_string()
  };
  format!("{summary}\n\n最后日志：\n{detail}")
}

/// 只把窗口唤到前台：没有导航副作用（下载保存前用它，不能把界面跳走）。
fn show_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
  }
}

/// 托盘、单实例、通知点击：唤醒窗口并跳到上次跑完的会话。
fn show_main(app: &AppHandle) {
  show_main_window(app);
  if let Ok(slot) = app.state::<AppState>().last_session.lock() {
    if let Some((workspace_id, session_id)) = slot.clone() {
      let _ = app.emit("jarvis://open-session", OpenSessionPayload { workspace_id, session_id });
    }
  }
}

/// 托盘“退出”：有会话在运行时先确认；然后优雅关闭服务（最多等 8 秒）再退出。
fn quit_app(app: &AppHandle) {
  let app = app.clone();
  thread::spawn(move || {
    let running = current_port(&app).map(running_sessions).unwrap_or(0);
    if running > 0 {
      let confirmed = app
        .dialog()
        .message(format!("有 {running} 个会话正在运行，退出会中断它们（重新打开后可以点“继续”接着做）。确定退出吗？"))
        .title("Jarvis")
        .buttons(MessageDialogButtons::OkCancelCustom("退出".into(), "取消".into()))
        .blocking_show();
      if !confirmed {
        return;
      }
    }
    app.state::<AppState>().quitting.store(true, Ordering::Relaxed);
    if let Some(window) = app.get_webview_window("main") {
      let _ = window.hide();
    }
    stop_current_sidecar(&app);
    app.exit(0);
  });
}

fn current_port(app: &AppHandle) -> Option<u16> {
  app.state::<AppState>().port.lock().ok().and_then(|slot| *slot)
}

fn running_sessions(port: u16) -> u64 {
  let url = format!("http://127.0.0.1:{port}/api/health");
  ureq::get(&url)
    .timeout(Duration::from_secs(1))
    .call()
    .ok()
    .and_then(|response| response.into_json::<serde_json::Value>().ok())
    .and_then(|body| body.get("running")?.as_u64())
    .unwrap_or(0)
}

/// `None` = 没人听端口；`Some(true)` = 已有 Jarvis；`Some(false)` = 被其他程序占用。
fn probe_existing_jarvis(port: u16) -> Option<bool> {
  // 已有服务在冷启动时可能要一会儿才回话；1 秒会把它当成「没人监听」，
  // 于是新起一份、撞 EADDRINUSE 启动失败。连接被拒是立刻返回的，放宽不影响启动速度。
  probe_jarvis(port, Duration::from_secs(3))
}

fn probe_jarvis(port: u16, timeout: Duration) -> Option<bool> {
  let url = format!("http://127.0.0.1:{port}/api/health");
  match ureq::get(&url).timeout(timeout).call() {
    Ok(response) => Some(response.into_json::<serde_json::Value>().ok().and_then(|body| body.get("ok")?.as_bool()) == Some(true)),
    Err(ureq::Error::Status(_, _)) => Some(false),
    Err(_) => None,
  }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
  let show = MenuItem::with_id(app, "show", "显示", true, None::<&str>)?;
  let check_update = MenuItem::with_id(app, "check-update", "检查更新", true, None::<&str>)?;
  let restart = MenuItem::with_id(app, "restart-service", "重启服务", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[&show, &check_update, &restart, &quit])?;
  let mut builder = TrayIconBuilder::new().menu(&menu).show_menu_on_left_click(false).on_tray_icon_event(|tray, event| {
    if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
      show_main(tray.app_handle());
    }
  });
  if let Some(icon) = app.default_window_icon() {
    builder = builder.icon(icon.clone());
  }
  builder.build(app)?;
  Ok(())
}

fn download_runtime_node(app: &AppHandle) -> Result<PathBuf, String> {
  if !confirm_node_download(app) {
    return Err(String::new());
  }
  set_download_progress(app, 0, None);
  let mut last_tick: i16 = -1;
  node::download_node(|done, total| {
    let tick = match total {
      Some(size) if size > 0 => ((done.saturating_mul(100)) / size).min(100) as i16,
      _ => 101,
    };
    if tick == last_tick {
      return;
    }
    last_tick = tick;
    set_download_progress(app, done, total);
  })
}

fn confirm_node_download(app: &AppHandle) -> bool {
  app
    .dialog()
    .message("未检测到可用 Node，将下载官方运行时。")
    .title("Jarvis")
    .buttons(MessageDialogButtons::OkCancelCustom("下载".into(), "取消".into()))
    .blocking_show()
}

/// 设置启动状态并记住它；启动失败时同时显示“检查更新”按钮。
fn set_splash(app: &AppHandle, text: &str) {
  let state = app.state::<AppState>();
  if let Ok(mut slot) = state.splash.lock() {
    *slot = text.to_string();
  }
  set_splash_state(app, text, "hidden", 0, state.startup_failed.load(Ordering::Relaxed));
}

/// 恢复更新流程之前的启动状态。
fn restore_splash(app: &AppHandle) {
  let text = app.state::<AppState>().splash.lock().map(|slot| slot.clone()).unwrap_or_default();
  set_splash(app, &text);
}

/// 临时状态（检查、安装更新），不覆盖记住的启动状态。
fn show_status(app: &AppHandle, text: &str) {
  set_splash_state(app, text, "hidden", 0, false);
}

fn show_progress(app: &AppHandle, text: &str, percent: Option<u8>) {
  match percent {
    Some(value) => set_splash_state(app, text, "percent", value, false),
    None => set_splash_state(app, text, "unknown", 0, false),
  }
}

fn set_download_progress(app: &AppHandle, done: u64, total: Option<u64>) {
  match total {
    Some(size) if size > 0 => {
      let percent = ((done.saturating_mul(100)) / size).min(100) as u8;
      show_progress(app, &format!("正在下载 Node {percent}%"), Some(percent));
    }
    _ => show_progress(app, "正在下载 Node", None),
  }
}

fn set_splash_state(app: &AppHandle, text: &str, mode: &str, percent: u8, show_update: bool) {
  // 服务已就绪时窗口显示的是网页界面，不再改写启动页。
  if backend_ready(app) {
    return;
  }
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.eval(&format!(
      "(function(text,mode,percent,showUpdate){{\n        var n=document.getElementById('status');\n        if(n) n.textContent=text;\n        var update=document.getElementById('check-update');\n        if(update) update.hidden=!showUpdate;\n        var bar=document.getElementById('progress');\n        var fill=document.getElementById('progress-fill');\n        if(!bar||!fill) return;\n        if(mode==='hidden'){{\n          bar.hidden=true;\n          bar.classList.remove('unknown');\n          fill.style.width='0%';\n          return;\n        }}\n        bar.hidden=false;\n        if(mode==='unknown'){{\n          bar.classList.add('unknown');\n          fill.style.width='32%';\n          return;\n        }}\n        bar.classList.remove('unknown');\n        fill.style.width=Math.max(0,Math.min(100,percent))+'%';\n      }})({text:?},{mode:?},{percent},{show_update})"
    ));
  }
}

fn jarvis_root(app: &AppHandle) -> PathBuf {
  let root = if cfg!(debug_assertions) {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
  } else {
    app.path().resource_dir().map(|dir| dir.join("jarvis")).unwrap_or_else(|_| PathBuf::from("."))
  };
  sidecar::strip_windows_verbatim(&root)
}

fn desktop_port() -> u16 {
  std::env::var("JARVIS_PORT")
    .ok()
    .and_then(|value| value.parse().ok())
    .filter(|port| *port > 0)
    .unwrap_or(DEFAULT_PORT)
}

/// 端口是用户指定的时候不顺延：指定了还换端口，手机书签和穿透配置就对不上了。
fn port_pinned() -> bool {
  std::env::var("JARVIS_PORT")
    .ok()
    .and_then(|value| value.parse::<u16>().ok())
    .map(|port| port > 0)
    .unwrap_or(false)
}

/// 从 `start` 往后找第一个能绑的端口（服务监听 0.0.0.0，就按同样地址试）。
fn free_port_from(start: u16) -> Option<u16> {
  (1..=PORT_FALLBACK_ATTEMPTS).find_map(|offset| {
    let candidate = start.checked_add(offset)?;
    let listener = TcpListener::bind(("0.0.0.0", candidate)).ok()?;
    drop(listener);
    Some(candidate)
  })
}

fn settings_path() -> PathBuf {
  dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".jarvis").join("desktop.json")
}

/// ~/.jarvis/desktop.json 里的桌面端设置；文件缺失或损坏时按空对象处理。
fn load_desktop_settings() -> serde_json::Map<String, serde_json::Value> {
  read_settings_object(&settings_path())
}

fn read_settings_object(path: &std::path::Path) -> serde_json::Map<String, serde_json::Value> {
  fs::read_to_string(path)
    .ok()
    .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    .and_then(|value| match value {
      serde_json::Value::Object(map) => Some(map),
      _ => None,
    })
    .unwrap_or_default()
}

/// 只改一个键，保留文件里的其他设置。
fn save_desktop_setting(key: &str, value: serde_json::Value) {
  write_setting(&settings_path(), key, value);
}

fn write_setting(path: &std::path::Path, key: &str, value: serde_json::Value) {
  let mut settings = read_settings_object(path);
  settings.insert(key.to_string(), value);
  if let Some(parent) = path.parent() {
    let _ = fs::create_dir_all(parent);
  }
  if let Ok(text) = serde_json::to_string_pretty(&serde_json::Value::Object(settings)) {
    // 先写临时文件再改名，断电或崩溃时不会留下半截 desktop.json。
    let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let written = fs::File::create(&temp).and_then(|mut file| {
      use std::io::Write;
      file.write_all(text.as_bytes())?;
      file.sync_all()
    });
    if written.is_err() || fs::rename(&temp, path).is_err() {
      let _ = fs::remove_file(&temp);
      let _ = fs::write(path, text);
    }
  }
}

#[cfg(test)]
mod settings_tests {
  use super::{read_settings_object, write_setting};

  #[test]
  fn writing_one_setting_keeps_the_others() {
    let dir = std::env::temp_dir().join(format!("jarvis-desktop-settings-{}", std::process::id()));
    let path = dir.join("desktop.json");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(&path, r#"{"notificationsEnabled":false}"#).unwrap();
    write_setting(&path, "updateChannel", serde_json::json!("beta"));
    let settings = read_settings_object(&path);
    assert_eq!(settings.get("notificationsEnabled"), Some(&serde_json::json!(false)));
    assert_eq!(settings.get("updateChannel"), Some(&serde_json::json!("beta")));
    std::fs::write(&path, "not json").unwrap();
    assert!(read_settings_object(&path).is_empty());
    let _ = std::fs::remove_dir_all(&dir);
  }
}

fn show_alert(app: &AppHandle, message: &str) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.eval(&format!("alert({message:?})"));
  }
}

#[cfg(test)]
mod startup_tests {
  use super::startup_failure;

  #[test]
  fn adds_diagnostics_to_startup_failure() {
    assert_eq!(startup_failure("启动失败", "error line"), "启动失败\n\n最后日志：\nerror line");
  }

  #[test]
  fn omits_empty_diagnostics() {
    assert_eq!(startup_failure("启动失败", "  \n"), "启动失败");
  }
}

