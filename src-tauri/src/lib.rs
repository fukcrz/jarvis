mod node;
mod sidecar;

use serde::Serialize;
use sidecar::DesktopEvent;
use std::fs;
use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_process::ProcessExt;
use tauri_plugin_updater::UpdaterExt;

const DEFAULT_PORT: u16 = 9528;

struct AppState {
  sidecar: Mutex<Option<Child>>,
  port: Mutex<Option<u16>>,
  notifications_enabled: AtomicBool,
  last_session: Mutex<Option<(String, String)>>,
  quitting: AtomicBool,
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
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .manage(AppState {
      sidecar: Mutex::new(None),
      port: Mutex::new(None),
      notifications_enabled: AtomicBool::new(notifications_enabled),
      last_session: Mutex::new(None),
      quitting: AtomicBool::new(false),
    })
    .invoke_handler(tauri::generate_handler![set_notifications_enabled])
    .setup(|app| {
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
      "check-update" => {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
          let _ = check_update(handle, false).await;
        });
      }
      _ => {}
    })
    .build(tauri::generate_context!())
    .expect("error while building Jarvis desktop")
    .run(|app, event| {
      if let tauri::RunEvent::ExitRequested { api, .. } = event {
        if !app.state::<AppState>().quitting.load(Ordering::Relaxed) {
          api.prevent_exit();
        }
      }
      if let tauri::RunEvent::Exit = event {
        stop_current_sidecar(app);
      }
    });
}

#[tauri::command]
fn set_notifications_enabled(state: State<AppState>, enabled: bool) {
  state.notifications_enabled.store(enabled, Ordering::Relaxed);
  save_notifications_enabled(enabled);
}

fn start_backend(app: AppHandle) {
  set_splash(&app, "正在启动");
  let node = match node::resolve_node() {
    Ok(path) => path,
    Err(_) => {
      set_splash(&app, "正在下载 Node");
      match node::download_node() {
        Ok(path) => path,
        Err(error) => {
          set_splash(&app, "启动失败");
          let _ = app.dialog_message(&error);
          return;
        }
      }
    }
  };
  let root = jarvis_root(&app);
  let port = desktop_port();
  let app_for_events = app.clone();
  match sidecar::spawn_sidecar(&node, &root, port, move |event| handle_event(&app_for_events, event)) {
    Ok(child) => {
      if let Ok(mut slot) = app.state::<AppState>().sidecar.lock() {
        *slot = Some(child);
      }
    }
    Err(error) => {
      set_splash(&app, "启动失败");
      let _ = app.dialog_message(&error);
      return;
    }
  }
  if !wait_for_port(&app, Duration::from_secs(30)) {
    set_splash(&app, "启动失败");
    let _ = app.dialog_message("Jarvis 服务未能在 30 秒内启动。若端口已被占用，请先停止其他 Jarvis 服务。");
  }
}

fn handle_event(app: &AppHandle, event: DesktopEvent) {
  match event {
    DesktopEvent::Ready { port } => {
      if let Ok(mut slot) = app.state::<AppState>().port.lock() {
        *slot = Some(port);
      }
      open_ui(app, port);
      let handle = app.clone();
      tauri::async_runtime::spawn(async move {
        let _ = check_update(handle, true).await;
      });
    }
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
  if let Ok(mut slot) = app.state::<AppState>().sidecar.lock() {
    if let Some(mut child) = slot.take() {
      sidecar::stop_sidecar(&mut child);
    }
  }
}

fn wait_for_port(app: &AppHandle, timeout: Duration) -> bool {
  let deadline = Instant::now() + timeout;
  while Instant::now() < deadline {
    if app.state::<AppState>().port.lock().ok().and_then(|slot| *slot).is_some() {
      return true;
    }
    thread::sleep(Duration::from_millis(200));
  }
  false
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
  if sidecar_busy(app) {
    let _ = app.dialog_message("有任务正在运行，退出将中断当前会话。");
  }
  app.state::<AppState>().quitting.store(true, Ordering::Relaxed);
  stop_current_sidecar(app);
  app.exit(0);
}

fn sidecar_busy(app: &AppHandle) -> bool {
  let port = app.state::<AppState>().port.lock().ok().and_then(|slot| *slot);
  let Some(port) = port else { return false };
  let url = format!("http://127.0.0.1:{port}/api/health");
  let Ok(response) = ureq::get(&url).timeout(Duration::from_secs(2)).call() else { return false };
  let Ok(body) = response.into_json::<serde_json::Value>() else { return false };
  body.get("running").and_then(serde_json::Value::as_u64).unwrap_or(0) > 0
}

async fn check_update(app: AppHandle, silent: bool) -> Result<(), String> {
  let updater = app.updater().map_err(|error| error.to_string())?;
  let update = updater.check().await.map_err(|error| error.to_string())?;
  let Some(update) = update else {
    if !silent {
      let _ = app.dialog_message("已是最新版本");
    }
    return Ok(());
  };
  if sidecar_busy(&app) {
    if !silent {
      let _ = app.dialog_message("有任务正在运行，已下载将在空闲后安装");
    }
    return Ok(());
  }
  update.download_and_install(|_, _| {}, || {}).await.map_err(|error| error.to_string())?;
  app.restart();
  #[allow(unreachable_code)]
  Ok(())
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

fn set_splash(app: &AppHandle, text: &str) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.eval(&format!(
      "var n=document.getElementById('status'); if(n) n.textContent = {text:?}"
    ));
  }
}

fn jarvis_root(app: &AppHandle) -> PathBuf {
  if cfg!(debug_assertions) {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
  } else {
    app.path().resource_dir().map(|dir| dir.join("jarvis")).unwrap_or_else(|_| PathBuf::from("."))
  }
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

