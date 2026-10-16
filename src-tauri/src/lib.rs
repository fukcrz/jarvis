mod desktop_log;
mod node;
mod sidecar;
mod supervisor;
mod update;

use serde::Serialize;
use sidecar::DesktopEvent;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    })
    .invoke_handler(tauri::generate_handler![set_notifications_enabled, open_external_url, take_update_check, check_desktop_update, update::get_update_channel, update::set_update_channel, update::check_channel_update, open_logs_folder])
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

#[tauri::command]
fn take_update_check(state: State<AppState>) -> bool {
  state.update_check_requested.swap(false, Ordering::Relaxed)
}

/// 启动页“检查更新”按钮：服务没起来时也能更新。
#[tauri::command]
fn check_desktop_update(app: AppHandle) {
  update::spawn_manual_check(&app);
}

/// 设置 → 数据与恢复 → 打开日志目录。
#[tauri::command]
fn open_logs_folder() -> Result<(), String> {
  let dir = desktop_log::log_dir();
  fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
  open::that_detached(&dir).map_err(|error| error.to_string())
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
  app.state::<AppState>().generation.fetch_add(1, Ordering::SeqCst);
  app.state::<AppState>().startup_failed.store(false, Ordering::Relaxed);
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
      report_startup_failure(&app, &format!("端口 {port} 已被其他程序占用"), false);
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
        // 空字符串表示用户取消了 Node 下载，不再弹窗。
        report_startup_failure(&app, &error, true);
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
      report_startup_failure(&app, &error, true);
      return;
    }
  }
  if let Err(error) = wait_for_backend(&app, port, Duration::from_secs(STARTUP_TIMEOUT_SECS)) {
    stop_current_sidecar(&app);
    report_startup_failure(&app, &error, true);
  }
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
      if state.generation.load(Ordering::SeqCst) != generation || state.quitting.load(Ordering::Relaxed) || state.updating.load(Ordering::Relaxed) {
        return;
      }
      if state.restarting.load(Ordering::SeqCst) || sidecar_closing(&app) {
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
  desktop_log::write(&format!("看门狗：{reason}"));
  if let Ok(mut slot) = app.state::<AppState>().port.lock() {
    *slot = None;
  }
  let allowed = app.state::<AppState>().restart_budget.lock().map(|mut budget| {
    if budget.try_take(Instant::now()) { Some(budget.backoff()) } else { None }
  }).unwrap_or(Some(Duration::from_secs(1)));
  let Some(backoff) = allowed else {
    desktop_log::write("看门狗：5 分钟内已自动重启 3 次，停止自动重启");
    show_alert(app, &format!(
      "Jarvis 服务多次异常退出，已停止自动重启。\n\n可以在托盘菜单点“重启服务”再试；设置 → 数据与恢复 里可以导出诊断包。\n日志目录：{}\n\n{reason}",
      desktop_log::log_dir().display()
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
    desktop_log::write("看门狗：服务已自动恢复");
    let _ = app.notification().builder().title("Jarvis").body("服务已自动恢复").show();
  }
}

/// 托盘“重启服务”：不依赖服务本身还活着；手动重启会清空自动重启计数。
fn manual_restart(app: &AppHandle) {
  if let Ok(mut budget) = app.state::<AppState>().restart_budget.lock() {
    budget.reset();
  }
  desktop_log::write("托盘：重启服务");
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
    desktop_log::write("托盘：退出");
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
    let _ = fs::write(path, text);
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

