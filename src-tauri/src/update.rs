//! 桌面端自更新：不依赖 Node 服务，只要窗口能打开就能检查、下载并安装更新。
//! 服务正常时托盘仍交给网页界面处理（它会先确认没有正在运行的会话）。

use crate::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

/// 同一时间只允许一个更新流程（启动失败自动检查、托盘、启动页按钮共用）。
struct UpdateGuard<'a>(&'a AtomicBool);

impl<'a> UpdateGuard<'a> {
  fn acquire(flag: &'a AtomicBool) -> Option<Self> {
    flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).ok().map(|_| Self(flag))
  }
}

impl Drop for UpdateGuard<'_> {
  fn drop(&mut self) {
    self.0.store(false, Ordering::Release);
  }
}

/// 服务启动失败后自动检查一次；有新版本就直接提示更新，否则照常显示错误。
pub fn offer_after_startup_failure(app: &AppHandle, error: &str) {
  let state = app.state::<AppState>();
  let Some(_guard) = UpdateGuard::acquire(&state.updating) else {
    crate::show_alert(app, error);
    return;
  };
  crate::show_status(app, "启动失败，正在检查更新");
  let update = check(app);
  crate::restore_splash(app);
  match update {
    Ok(Some(update)) => {
      if confirm(app, &startup_failure_prompt(error, &update.current_version, &update.version), "立即更新", "稍后") {
        install(app, update);
      }
    }
    Ok(None) | Err(_) => crate::show_alert(app, error),
  }
}

/// 用户主动检查（托盘或启动页按钮），在后台线程执行，结果都用对话框说明。
pub fn spawn_manual_check(app: &AppHandle) {
  let app = app.clone();
  thread::spawn(move || manual_check(&app));
}

fn manual_check(app: &AppHandle) {
  let state = app.state::<AppState>();
  let Some(_guard) = UpdateGuard::acquire(&state.updating) else {
    message(app, "正在检查更新，请稍候", MessageDialogKind::Info);
    return;
  };
  crate::show_status(app, "正在检查更新");
  let result = check(app);
  crate::restore_splash(app);
  match result {
    Ok(None) => message(app, &format!("当前已是最新版本（{}）", app.package_info().version), MessageDialogKind::Info),
    Ok(Some(update)) => {
      if confirm(app, &available_prompt(&update.current_version, &update.version), "立即更新", "稍后") {
        install(app, update);
      }
    }
    Err(error) => message(app, &format!("检查更新失败：{error}"), MessageDialogKind::Error),
  }
}

fn check(app: &AppHandle) -> Result<Option<Update>, String> {
  let updater = app.updater().map_err(|error| error.to_string())?;
  tauri::async_runtime::block_on(updater.check()).map_err(|error| error.to_string())
}

/// 下载、安装并重启。Windows 安装器启动前，插件会调用 cleanup_before_exit，
/// 资源表里的 SidecarCleanup 随之停止 Node 服务，然后进程直接退出。
fn install(app: &AppHandle, update: Update) {
  let mut received: u64 = 0;
  let mut last_status = String::new();
  let result = tauri::async_runtime::block_on(update.download_and_install(
    |chunk, total| {
      received = received.saturating_add(chunk as u64);
      let (text, percent) = download_status(received, total);
      if text != last_status {
        crate::show_progress(app, &text, percent);
        last_status = text;
      }
    },
    || crate::show_status(app, "正在安装更新"),
  ));
  match result {
    Ok(()) => {
      crate::show_status(app, "更新完成，正在重启");
      app.state::<AppState>().quitting.store(true, Ordering::Relaxed);
      app.restart();
    }
    Err(error) => {
      crate::restore_splash(app);
      message(app, &format!("更新失败：{error}"), MessageDialogKind::Error);
    }
  }
}

fn download_status(received: u64, total: Option<u64>) -> (String, Option<u8>) {
  match total {
    Some(size) if size > 0 => {
      let percent = (received.saturating_mul(100) / size).min(100) as u8;
      (format!("正在下载更新 {percent}%"), Some(percent))
    }
    _ => ("正在下载更新".to_string(), None),
  }
}

fn startup_failure_prompt(error: &str, current: &str, latest: &str) -> String {
  format!("Jarvis 启动失败。发现新版本 {latest}（当前 {current}），更新后可能解决这个问题，是否立即更新？\n\n{error}")
}

fn available_prompt(current: &str, latest: &str) -> String {
  format!("发现新版本 {latest}（当前 {current}），是否立即更新？\n\n更新完成后 Jarvis 会自动重启。")
}

fn confirm(app: &AppHandle, text: &str, ok: &str, cancel: &str) -> bool {
  let mut dialog = app
    .dialog()
    .message(text)
    .title("Jarvis")
    .buttons(MessageDialogButtons::OkCancelCustom(ok.into(), cancel.into()));
  if let Some(window) = app.get_webview_window("main") {
    dialog = dialog.parent(&window);
  }
  dialog.blocking_show()
}

fn message(app: &AppHandle, text: &str, kind: MessageDialogKind) {
  let mut dialog = app.dialog().message(text).title("Jarvis").kind(kind);
  if let Some(window) = app.get_webview_window("main") {
    dialog = dialog.parent(&window);
  }
  dialog.blocking_show();
}

#[cfg(test)]
mod tests {
  use super::{available_prompt, download_status, startup_failure_prompt, UpdateGuard};
  use std::sync::atomic::AtomicBool;

  #[test]
  fn only_one_update_flow_runs_at_a_time() {
    let flag = AtomicBool::new(false);
    let first = UpdateGuard::acquire(&flag).expect("first flow");
    assert!(UpdateGuard::acquire(&flag).is_none());
    drop(first);
    assert!(UpdateGuard::acquire(&flag).is_some(), "guard must release after the flow ends");
  }

  #[test]
  fn reports_download_percent_when_size_is_known() {
    assert_eq!(download_status(50, Some(200)), ("正在下载更新 25%".to_string(), Some(25)));
    assert_eq!(download_status(300, Some(200)), ("正在下载更新 100%".to_string(), Some(100)));
  }

  #[test]
  fn reports_indeterminate_download_without_size() {
    assert_eq!(download_status(10, None), ("正在下载更新".to_string(), None));
    assert_eq!(download_status(10, Some(0)), ("正在下载更新".to_string(), None));
  }

  #[test]
  fn startup_failure_prompt_keeps_the_error_and_versions() {
    let text = startup_failure_prompt("Jarvis 服务启动后意外退出", "0.1.25", "0.1.26");
    assert!(text.ends_with("\n\nJarvis 服务启动后意外退出"));
    assert!(text.contains("0.1.26（当前 0.1.25）"));
    assert!(available_prompt("0.1.25", "0.1.26").contains("自动重启"));
  }
}
