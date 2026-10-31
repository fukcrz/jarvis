//! 桌面壳的下载接管。
//!
//! WebView2 自带的下载 UI 被 wry 默认关掉（`--disable-features=msWebOOUI`），
//! 没有 `on_download` 时下载只会静默落进系统下载目录。这里把每个下载请求改写到
//! 临时目录，下载完成后弹原生「另存为」，再移动到用户选择的位置。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::webview::DownloadEvent;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::{notify_saved, show_alert, show_main, AppState};

const MOVE_ATTEMPTS: u32 = 20;
const MOVE_RETRY_DELAY: Duration = Duration::from_millis(100);
const DIALOG_POLL: Duration = Duration::from_millis(100);
/// Windows 的 ERROR_NOT_SAME_DEVICE 与 unix 的 EXDEV 都是 17：跨卷 rename 重试没用。
const CROSS_DEVICE_ERRNO: i32 = 17;

/// 待确认的下载都先落这里；启动与退出时清扫。
pub fn download_root() -> PathBuf {
  std::env::temp_dir().join("jarvis").join("downloads")
}

#[derive(Default)]
pub struct DownloadState {
  /// url → 待确认的临时目录（同一 URL 可能并发下载多次）。
  pending: Mutex<HashMap<String, Vec<PathBuf>>>,
  /// 同一时刻只处理一个另存为对话框，避免连续下载叠出多个模态框。
  saving: Arc<Mutex<bool>>,
  counter: AtomicU64,
}

impl DownloadState {
  fn next_dir(&self) -> PathBuf {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_nanos()).unwrap_or(0);
    let seq = self.counter.fetch_add(1, Ordering::Relaxed);
    download_root().join(format!("{stamp:x}-{seq:x}"))
  }
}

/// 挂到窗口 `on_download` 上的入口。返回 false 会取消这次下载。
pub fn handle_event(app: &AppHandle, event: DownloadEvent<'_>) -> bool {
  match event {
    DownloadEvent::Requested { url, destination } => prepare(app, url.as_str(), destination),
    DownloadEvent::Finished { url, path, success } => {
      finish(app, url.as_str(), path, success);
      true
    }
    _ => true,
  }
}

/// 改写落盘路径到临时目录；目录建不出来就保持 WebView2 的默认路径，别丢掉这次下载。
fn prepare(app: &AppHandle, url: &str, destination: &mut PathBuf) -> bool {
  let state = app.state::<AppState>();
  let dir = state.downloads.next_dir();
  if fs::create_dir_all(&dir).is_err() {
    return true;
  }
  let name = desired_file_name(destination, url);
  if let Ok(mut pending) = state.downloads.pending.lock() {
    pending.entry(url.to_string()).or_default().push(dir.clone());
  }
  *destination = dir.join(name);
  true
}

/// 下载结束：失败就清掉临时目录，成功就交给另存为流程。
fn finish(app: &AppHandle, url: &str, path: Option<PathBuf>, success: bool) {
  let dir = app.state::<AppState>().downloads.pending.lock().ok().and_then(|mut pending| {
    let dirs = pending.get_mut(url)?;
    if dirs.is_empty() { None } else { Some(dirs.remove(0)) }
  });
  if !success {
    if let Some(dir) = dir {
      remove_dir(&dir);
    }
    return;
  }
  // 成功的下载一定有 path；拿不到就保持安静，临时目录留给启动清扫。
  let Some(source) = path else { return };
  let name = desired_file_name(&source, url);
  let app = app.clone();
  thread::spawn(move || prompt_save(&app, source, name, dir));
}

fn prompt_save(app: &AppHandle, source: PathBuf, name: String, dir: Option<PathBuf>) {
  // 窗口可能藏在托盘里，先把界面拉出来再弹对话框，否则对话框挂在不可见窗口上。
  show_main(app);
  let gate = Arc::clone(&app.state::<AppState>().downloads.saving);
  acquire(&gate);
  let dialog_app = app.clone();
  let release_gate = Arc::clone(&gate);
  let source_for_dialog = source.clone();
  app.dialog().file().set_file_name(&name).save_file(move |target| {
    let chosen = target.and_then(|file| file.into_path().ok());
    match chosen {
      Some(target) => match move_file(&source_for_dialog, &target) {
        Ok(()) => notify_saved(&dialog_app, &target),
        Err(error) => show_alert(&dialog_app, &format!("保存失败：{error}")),
      },
      None => {
        if let Some(dir) = dir.as_deref() {
          remove_dir(dir);
        }
      }
    }
    release(&release_gate);
  });
}

fn acquire(gate: &Arc<Mutex<bool>>) {
  loop {
    if let Ok(mut busy) = gate.lock() {
      if !*busy {
        *busy = true;
        return;
      }
    }
    thread::sleep(DIALOG_POLL);
  }
}

fn release(gate: &Arc<Mutex<bool>>) {
  if let Ok(mut busy) = gate.lock() {
    *busy = false;
  }
}

/// 优先 rename（同卷瞬时），占用时重试；跨卷退化为复制。
fn move_file(source: &Path, target: &Path) -> Result<(), String> {
  if let Some(parent) = target.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let mut last_error = String::new();
  for attempt in 0..MOVE_ATTEMPTS {
    match fs::rename(source, target) {
      Ok(()) => return Ok(()),
      Err(error) => {
        last_error = error.to_string();
        if error.raw_os_error() == Some(CROSS_DEVICE_ERRNO) {
          break;
        }
        if attempt + 1 < MOVE_ATTEMPTS {
          thread::sleep(MOVE_RETRY_DELAY);
        }
      }
    }
  }
  fs::copy(source, target).map_err(|error| format!("{last_error}；复制失败：{error}"))?;
  let _ = fs::remove_file(source);
  Ok(())
}

fn remove_dir(dir: &Path) {
  let _ = fs::remove_dir_all(dir);
}

/// 启动时清掉上次没确认保存的残留。
pub fn cleanup_stale() {
  let Ok(entries) = fs::read_dir(download_root()) else { return };
  for entry in entries.flatten() {
    let path = entry.path();
    if path.is_dir() {
      let _ = fs::remove_dir_all(&path);
    } else {
      let _ = fs::remove_file(&path);
    }
  }
}

fn desired_file_name(path: &Path, url: &str) -> String {
  let from_destination = path.file_name().map(|name| sanitize_file_name(&name.to_string_lossy())).unwrap_or_default();
  if !from_destination.is_empty() {
    return from_destination;
  }
  let from_url = url_last_segment(url).map(|name| sanitize_file_name(&name)).unwrap_or_default();
  if from_url.is_empty() { "download".to_string() } else { from_url }
}

fn url_last_segment(url: &str) -> Option<String> {
  let without_query = url.split(['?', '#']).next().unwrap_or(url);
  let last = without_query.rsplit('/').next()?;
  let decoded = percent_decode(last);
  if decoded.is_empty() || decoded == "files" { None } else { Some(decoded) }
}

fn percent_decode(value: &str) -> String {
  let bytes = value.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut index = 0;
  while index < bytes.len() {
    if bytes[index] == b'%' && index + 2 < bytes.len() {
      let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok().and_then(|hex| u8::from_str_radix(hex, 16).ok());
      if let Some(byte) = hex {
        out.push(byte);
        index += 3;
        continue;
      }
    }
    out.push(bytes[index]);
    index += 1;
  }
  String::from_utf8_lossy(&out).to_string()
}

/// 文件名里不能出现的字符换成下划线；Windows 还不允许结尾的点。
fn sanitize_file_name(name: &str) -> String {
  let cleaned: String = name
    .chars()
    .map(|ch| match ch {
      '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
      ch if (ch as u32) < 0x20 => '_',
      ch => ch,
    })
    .collect();
  let trimmed = cleaned.trim().trim_end_matches('.').to_string();
  if trimmed.is_empty() || trimmed == "." || trimmed == ".." { String::new() } else { trimmed }
}

#[cfg(test)]
mod tests {
  use super::{download_root, desired_file_name, move_file, sanitize_file_name, url_last_segment, DownloadState};
  use std::fs;
  use std::path::PathBuf;

  #[test]
  fn keeps_chinese_file_names() {
    assert_eq!(sanitize_file_name("需求整理-初稿.md"), "需求整理-初稿.md");
  }

  #[test]
  fn replaces_separators_and_trailing_dots() {
    assert_eq!(sanitize_file_name("a/b\\c:d?.txt"), "a_b_c_d_.txt");
    assert_eq!(sanitize_file_name("name."), "name");
    assert_eq!(sanitize_file_name("   "), "");
  }

  #[test]
  fn falls_back_to_url_segment() {
    assert_eq!(desired_file_name(&PathBuf::from(""), "/api/files?path=x&download=1"), "download");
    assert_eq!(desired_file_name(&PathBuf::from(""), "https://example.com/a%20b.pdf"), "a b.pdf");
    assert_eq!(url_last_segment("/api/files?path=x"), None);
    assert_eq!(url_last_segment("https://example.com/dir/"), None);
  }

  #[test]
  fn prefers_the_webview_name() {
    assert_eq!(desired_file_name(&PathBuf::from("C:/Downloads/报告.pdf"), "/api/files?download=1"), "报告.pdf");
  }

  #[test]
  fn moves_into_a_missing_directory() {
    let root = download_root().join("test-move");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let source = root.join("source.txt");
    fs::write(&source, b"hello").unwrap();
    let target = root.join("nested").join("target.txt");
    move_file(&source, &target).unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "hello");
    assert!(!source.exists());
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn download_directories_are_unique() {
    let state = DownloadState::default();
    assert_ne!(state.next_dir(), state.next_dir());
  }
}
