//! 桌面端自更新：不依赖 Node 服务，只要窗口能打开就能检查、下载并安装更新。
//! 服务正常时托盘仍交给网页界面处理（它会先确认没有正在运行的会话）。

use crate::AppState;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use tauri::{AppHandle, Manager, State, Url, Webview};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

const STABLE_ENDPOINT: &str = "https://github.com/fukcrz/jarvis/releases/latest/download/latest.json";
const BETA_ENDPOINT: &str = "https://github.com/fukcrz/jarvis/releases/download/updater-beta/beta.json";
const CHANNEL_SETTING: &str = "updateChannel";

/// 更新通道：正式版只看 latest.json；测试版看 beta.json（发版时正式版也会写进去，取较高版本）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum UpdateChannel {
  #[default]
  Stable,
  Beta,
}

impl UpdateChannel {
  pub fn parse(value: &str) -> Option<Self> {
    match value {
      "stable" => Some(Self::Stable),
      "beta" => Some(Self::Beta),
      _ => None,
    }
  }

  pub fn as_str(self) -> &'static str {
    match self {
      Self::Stable => "stable",
      Self::Beta => "beta",
    }
  }

  /// 更新器按顺序尝试，第一个拿到有效清单的为准。测试版清单缺失（尚未发过、被误删）时退回正式版清单。
  pub fn endpoints(self) -> &'static [&'static str] {
    match self {
      Self::Stable => &[STABLE_ENDPOINT],
      Self::Beta => &[BETA_ENDPOINT, STABLE_ENDPOINT],
    }
  }

  pub fn from_settings(settings: &serde_json::Map<String, serde_json::Value>) -> Self {
    settings.get(CHANNEL_SETTING).and_then(|value| value.as_str()).and_then(Self::parse).unwrap_or_default()
  }
}

fn current_channel(app: &AppHandle) -> UpdateChannel {
  app.state::<AppState>().update_channel.lock().map(|channel| *channel).unwrap_or_default()
}

/// 按当前通道构建更新器；其余配置（公钥、退出前清理）沿用插件默认。
fn channel_updater(app: &AppHandle) -> Result<Updater, String> {
  let urls = current_channel(app).endpoints().iter().map(|endpoint| Url::parse(endpoint)).collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
  app.updater_builder().endpoints(urls).and_then(|builder| builder.build()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_update_channel(state: State<AppState>) -> &'static str {
  state.update_channel.lock().map(|channel| *channel).unwrap_or_default().as_str()
}

#[tauri::command]
pub fn set_update_channel(state: State<AppState>, channel: String) -> Result<(), String> {
  let channel = UpdateChannel::parse(&channel).ok_or_else(|| format!("未知的更新通道：{channel}"))?;
  if let Ok(mut current) = state.update_channel.lock() {
    *current = channel;
  }
  crate::save_desktop_setting(CHANNEL_SETTING, serde_json::Value::String(channel.as_str().to_string()));
  Ok(())
}

/// 与插件 `check` 命令返回同样的结构，资源放进该网页的资源表，
/// 之后网页仍用插件的 download / install 命令操作同一个 rid。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelUpdateMetadata {
  rid: tauri::ResourceId,
  current_version: String,
  version: String,
  body: Option<String>,
  raw_json: serde_json::Value,
}

#[tauri::command]
pub async fn check_channel_update(app: AppHandle, webview: Webview) -> Result<Option<ChannelUpdateMetadata>, String> {
  let updater = channel_updater(&app)?;
  let Some(update) = updater.check().await.map_err(|error| error.to_string())? else { return Ok(None) };
  let metadata = ChannelUpdateMetadata {
    rid: 0,
    current_version: update.current_version.clone(),
    version: update.version.clone(),
    body: update.body.clone(),
    raw_json: update.raw_json.clone(),
  };
  let rid = webview.resources_table().add(update);
  Ok(Some(ChannelUpdateMetadata { rid, ..metadata }))
}

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
  let updater = channel_updater(app)?;
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
  use super::{available_prompt, download_status, startup_failure_prompt, UpdateChannel, UpdateGuard};
  use std::sync::atomic::AtomicBool;

  #[test]
  fn channel_defaults_to_stable_and_round_trips() {
    let empty = serde_json::Map::new();
    assert_eq!(UpdateChannel::from_settings(&empty), UpdateChannel::Stable);
    let beta = serde_json::json!({"updateChannel": "beta"});
    assert_eq!(UpdateChannel::from_settings(beta.as_object().unwrap()), UpdateChannel::Beta);
    let unknown = serde_json::json!({"updateChannel": "nightly"});
    assert_eq!(UpdateChannel::from_settings(unknown.as_object().unwrap()), UpdateChannel::Stable);
    for channel in [UpdateChannel::Stable, UpdateChannel::Beta] {
      assert_eq!(UpdateChannel::parse(channel.as_str()), Some(channel));
    }
    let stable = "https://github.com/fukcrz/jarvis/releases/latest/download/latest.json";
    let beta = "https://github.com/fukcrz/jarvis/releases/download/updater-beta/beta.json";
    assert_eq!(UpdateChannel::Stable.endpoints(), &[stable]);
    assert_eq!(UpdateChannel::Beta.endpoints(), &[beta, stable]);
  }

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
