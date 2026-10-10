mod node;
mod sidecar;

use serde::Serialize;
use sidecar::DesktopEvent;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_notification::NotificationExt;

const DEFAULT_PORT: u16 = 9528;
const STARTUP_SLOW_AFTER_SECS: u64 = 30;
const STARTUP_TIMEOUT_SECS: u64 = 60;

struct AppState {
  sidecar: sidecar::SharedSidecar,
  port: Mutex<Option<u16>>,
  notifications_enabled: AtomicBool,
  last_session: Mutex<Option<(String, String)>>,
  quitting: AtomicBool,
  update_check_requested: AtomicBool,
}

#[derive(Clone, Serialize)]
struct OpenSessionPayload {
  #[serde(rename = "workspaceId")]
  workspace_id: String,
  #[serde(rename = "sessionId")]
  session_id: String,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let notifications_enabled = load_notifications_enabled();
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
      last_session: Mutex::new(None),
      quitting: AtomicBool::new(false),
      update_check_requested: AtomicBool::new(false),
    })
    .invoke_handler(tauri::generate_handler![set_notifications_enabled, open_external_url, take_update_check])
    .setup(|app| {
      app.resources_table().add(sidecar::SidecarCleanup(Arc::clone(&app.state::<AppState>().sidecar)));
      let handle = app.handle().clone();
      build_tray(&handle)?;
      if let Some(window) = handle.get_webview_window("main") {
        let window_clone = window.clone();
        window.on_window_event(move |event| {
          if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window_clone.hide();
          }
        });
      }
      thread::spawn(move || start_backend(handle));
      Ok(())
    })
    .on_menu_event(|app, event| match event.id().as_ref() {
      "show" => show_main(app),
      "quit" => quit_app(app),
      "check-update" => request_update_check(app),
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
  save_notifications_enabled(enabled);
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
  open_http_url(&url)
}

#[tauri::command]
fn take_update_check(state: State<AppState>) -> bool {
  state.update_check_requested.swap(false, Ordering::Relaxed)
}

fn request_update_check(app: &AppHandle) {
  app.state::<AppState>().update_check_requested.store(true, Ordering::Relaxed);
  show_main(app);
  let _ = app.emit("jarvis://check-update", ());
}

fn open_http_url(url: &str) -> Result<(), String> {
  if !url.starts_with("https://") && !url.starts_with("http://") {
    return Err("只支持 http(s) 链接".into());
  }
  open::that_detached(url).map_err(|error| error.to_string())
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
  set_splash(&app, "正在启动");
  let port = desktop_port();
  if let Ok(mut slot) = app.state::<AppState>().port.lock() {
    *slot = None;
  }
  match probe_existing_jarvis(port) {
    Some(true) => {
      mark_backend_ready(&app, port);
      return;
    }
    Some(false) => {
      set_splash(&app, "启动失败");
      let _ = app.dialog_message(&format!("端口 {port} 已被其他程序占用"));
      return;
    }
    None => {}
  }
  let root = jarvis_root(&app);
  let node = match node::resolve_node(&root) {
    Ok(path) => path,
    Err(_) => match download_runtime_node(&app) {
      Ok(path) => path,
      Err(error) => {
        set_splash(&app, "启动失败");
        if !error.is_empty() {
          let _ = app.dialog_message(&error);
        }
        return;
      }
    },
  };
  set_splash(&app, "正在启动服务");
  let app_for_events = app.clone();
  match sidecar::spawn_managed_sidecar(&app.state::<AppState>().sidecar, &node, &root, port, move |event| handle_event(&app_for_events, event)) {
    Ok(true) => {}
    Ok(false) => return,
    Err(error) => {
      set_splash(&app, "启动失败");
      let _ = app.dialog_message(&error);
      return;
    }
  }
  if let Err(error) = wait_for_backend(&app, port, Duration::from_secs(STARTUP_TIMEOUT_SECS)) {
    set_splash(&app, "启动失败");
    stop_current_sidecar(&app);
    let _ = app.dialog_message(&error);
  }
}

fn handle_event(app: &AppHandle, event: DesktopEvent) {
  match event {
    DesktopEvent::Ready { port } => mark_backend_ready(app, port),
    DesktopEvent::Restart => restart_sidecar(app),
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
  let _ = app.notification().builder().title(title).body(body).show();
}

fn window_is_front(app: &AppHandle) -> bool {
  app.get_webview_window("main").is_some_and(|window| {
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    visible && focused
  })
}

fn restart_sidecar(app: &AppHandle) {
  stop_current_sidecar(app);
  start_backend(app.clone());
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

fn show_main(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
  }
  if let Ok(slot) = app.state::<AppState>().last_session.lock() {
    if let Some((workspace_id, session_id)) = slot.clone() {
      let _ = app.emit("jarvis://open-session", OpenSessionPayload { workspace_id, session_id });
    }
  }
}

fn quit_app(app: &AppHandle) {
  app.state::<AppState>().quitting.store(true, Ordering::Relaxed);
  stop_current_sidecar(app);
  app.exit(0);
}

/// `None` = 没人听端口；`Some(true)` = 已有 Jarvis；`Some(false)` = 被其他程序占用。
fn probe_existing_jarvis(port: u16) -> Option<bool> {
  probe_jarvis(port, Duration::from_secs(1))
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
  let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[&show, &check_update, &quit])?;
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

fn set_splash(app: &AppHandle, text: &str) {
  set_splash_state(app, text, "hidden", 0);
}

fn set_download_progress(app: &AppHandle, done: u64, total: Option<u64>) {
  match total {
    Some(size) if size > 0 => {
      let percent = ((done.saturating_mul(100)) / size).min(100) as u8;
      set_splash_state(app, &format!("正在下载 Node {percent}%"), "percent", percent);
    }
    _ => set_splash_state(app, "正在下载 Node", "unknown", 0),
  }
}

fn set_splash_state(app: &AppHandle, text: &str, mode: &str, percent: u8) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.eval(&format!(
      "(function(text,mode,percent){{\n        var n=document.getElementById('status');\n        if(n) n.textContent=text;\n        var bar=document.getElementById('progress');\n        var fill=document.getElementById('progress-fill');\n        if(!bar||!fill) return;\n        if(mode==='hidden'){{\n          bar.hidden=true;\n          bar.classList.remove('unknown');\n          fill.style.width='0%';\n          return;\n        }}\n        bar.hidden=false;\n        if(mode==='unknown'){{\n          bar.classList.add('unknown');\n          fill.style.width='32%';\n          return;\n        }}\n        bar.classList.remove('unknown');\n        fill.style.width=Math.max(0,Math.min(100,percent))+'%';\n      }})({text:?},{mode:?},{percent})"
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

fn settings_path() -> PathBuf {
  dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".jarvis").join("desktop.json")
}

fn load_notifications_enabled() -> bool {
  let Ok(text) = fs::read_to_string(settings_path()) else { return true };
  serde_json::from_str::<serde_json::Value>(&text)
    .ok()
    .and_then(|value| value.get("notificationsEnabled")?.as_bool())
    .unwrap_or(true)
}

fn save_notifications_enabled(enabled: bool) {
  let path = settings_path();
  if let Some(parent) = path.parent() {
    let _ = fs::create_dir_all(parent);
  }
  let _ = fs::write(path, format!("{{\"notificationsEnabled\":{enabled}}}"));
}

trait DialogMessage {
  fn dialog_message(&self, message: &str) -> Result<(), tauri::Error>;
}

impl DialogMessage for AppHandle {
  fn dialog_message(&self, message: &str) -> Result<(), tauri::Error> {
    if let Some(window) = self.get_webview_window("main") {
      let _ = window.eval(&format!("alert({message:?})"));
    }
    Ok(())
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

