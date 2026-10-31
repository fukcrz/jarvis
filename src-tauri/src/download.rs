//! 桌面壳的下载接管。
//!
//! WebView2 自带的下载 UI 被 wry 默认关掉（`--disable-features=msWebOOUI`），
//! 没有 `on_download` 时下载只会静默落进系统下载目录。这里把每个下载请求改写到
//! 临时目录，下载完成后弹原生「另存为」，再移动到用户选择的位置。
//! 没有确认保存的残留目录在下一次启动时清掉。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::webview::DownloadEvent;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::{notify_failed, notify_saved, show_alert, show_main_window, AppState};

const MOVE_ATTEMPTS: u32 = 20;
const MOVE_RETRY_DELAY: Duration = Duration::from_millis(100);
const DIALOG_POLL: Duration = Duration::from_millis(100);
/// 前一个保存对话框一直没关时不要无限等下去。
const DIALOG_WAIT_TIMEOUT: Duration = Duration::from_secs(120);
/// 清扫时只动老于这个时间的目录：另一个正在跑的客户端可能正在下载。
const STALE_AFTER: Duration = Duration::from_secs(60 * 60);
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

/// 下载结束：失败就清掉临时目录并提示，成功就交给另存为流程。
fn finish(app: &AppHandle, url: &str, path: Option<PathBuf>, success: bool) {
  let state = app.state::<AppState>();
  // 优先按 Finished 给的路径反查临时目录：同一 URL 并发下载时 FIFO 会错位。
  let dir = match path.as_deref().and_then(|file| dir_under(&download_root(), file)) {
    Some(dir) => {
      forget(&state.downloads, &dir);
      Some(dir)
    }
    None => take_pending(&state.downloads, url),
  };
  if !success {
    if let Some(dir) = dir.as_deref() {
      remove_dir(dir);
    }
    notify_failed(app, "文件没能下载完成，可以再试一次");
    return;
  }
  // 成功的下载一定有 path；拿不到就保持安静，临时目录留给启动清扫。
  let Some(source) = path else { return };
  let name = desired_file_name(&source, url);
  let app = app.clone();
  thread::spawn(move || prompt_save(&app, source, name, dir));
}

fn dir_under(root: &Path, file: &Path) -> Option<PathBuf> {
  let parent = file.parent()?;
  if parent.starts_with(root) { Some(parent.to_path_buf()) } else { None }
}

fn take_pending(state: &DownloadState, url: &str) -> Option<PathBuf> {
  let mut pending = state.pending.lock().ok()?;
  let dirs = pending.get_mut(url)?;
  if dirs.is_empty() { None } else { Some(dirs.remove(0)) }
}

fn forget(state: &DownloadState, dir: &Path) {
  let Ok(mut pending) = state.pending.lock() else { return };
  for dirs in pending.values_mut() {
    dirs.retain(|value| value != dir);
  }
}

fn prompt_save(app: &AppHandle, source: PathBuf, name: String, dir: Option<PathBuf>) {
  // 窗口可能藏在托盘里，先把界面拉出来再弹对话框；这里只唤窗口，不跳会话。
  show_main_window(app);
  let gate = Arc::clone(&app.state::<AppState>().downloads.saving);
  if !acquire(&gate) {
    show_alert(app, "还有一个保存对话框没关，先处理它再下载一次");
    return;
  }
  let dialog_app = app.clone();
  let release_gate = Arc::clone(&gate);
  let source_for_dialog = source.clone();
  let dir_for_dialog = dir.clone();
  let mut dialog = app.dialog().file().set_file_name(&name);
  if let Some(window) = app.get_webview_window("main") {
    // 不挂 parent 的话对话框可能被主窗口盖住，看着像“点了没反应”。
    dialog = dialog.set_parent(&window);
  }
  dialog.save_file(move |target| {
    let chosen = target.and_then(|file| file.into_path().ok());
    match chosen {
      Some(target) => match move_file(&source_for_dialog, &target) {
        Ok(()) => {
          if let Some(dir) = dir_for_dialog.as_deref() {
            remove_dir(dir);
          }
          notify_saved(&dialog_app, &target);
        }
        Err(error) => {
          let kept = dir_for_dialog.as_deref().map(|dir| dir.display().to_string()).unwrap_or_default();
          show_alert(&dialog_app, &format!("保存失败：{error}\n临时文件还在 {kept}"));
        }
      },
      None => {
        if let Some(dir) = dir_for_dialog.as_deref() {
          remove_dir(dir);
        }
      }
    }
    release(&release_gate);
  });
}

/// 拿串行门；超过 `DIALOG_WAIT_TIMEOUT` 还没轮到就放弃，不要越积越多线程。
fn acquire(gate: &Arc<Mutex<bool>>) -> bool {
  let deadline = Instant::now() + DIALOG_WAIT_TIMEOUT;
  loop {
    if let Ok(mut busy) = gate.lock() {
      if !*busy {
        *busy = true;
        return true;
      }
    }
    if Instant::now() >= deadline {
      return false;
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

/// 启动时清掉上次没确认保存的残留；正在被另一个客户端用的目录不动。
pub fn cleanup_stale() {
  let Ok(entries) = fs::read_dir(download_root()) else { return };
  for entry in entries.flatten() {
    let path = entry.path();
    let fresh = fs::metadata(&path)
      .and_then(|meta| meta.modified())
      .ok()
      .and_then(|modified| SystemTime::now().duration_since(modified).ok())
      .map(|age| age < STALE_AFTER)
      .unwrap_or(false);
    if fresh {
      continue;
    }
    if path.is_dir() {
      let _ = fs::remove_dir_all(&path);
    } else {
      let _ = fs::remove_file(&path);
    }
  }
}

fn desired_file_name(path: &Path, url: &str) -> String {
  let from_destination = path.file_name().map(|name| sanitize_file_name(&name.to_string_lossy())).unwrap_or_default();
  if !from_destination.is_empty() && !is_generic_name(&from_destination) {
    return from_destination;
  }
  // 内嵌预览（PDF 工具栏）下载时 WebView2 只会给出 `files.pdf` 这种名字，真名在 URL 的 path 参数里。
  if let Some(name) = query_path_name(url) {
    return name;
  }
  if !from_destination.is_empty() {
    return from_destination;
  }
  let from_url = url_last_segment(url).map(|name| sanitize_file_name(&name)).unwrap_or_default();
  if from_url.is_empty() { "download".to_string() } else { from_url }
}

/// `files.pdf` / `download` 这类泛称不能当文件名用。
fn is_generic_name(name: &str) -> bool {
  let stem = name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(name).to_ascii_lowercase();
  matches!(stem.as_str(), "files" | "file" | "download")
}

/// `/api/files?path=D%3A%2Fp%2F%E6%8A%A5%E5%91%8A.pdf` → `报告.pdf`
fn query_path_name(url: &str) -> Option<String> {
  let query = url.split_once('?')?.1.split('#').next().unwrap_or_default();
  let value = query.split('&').find_map(|pair| pair.strip_prefix("path="))?;
  let decoded = percent_decode(value);
  let name = decoded.rsplit(['/', '\\']).next().unwrap_or_default();
  let name = sanitize_file_name(name);
  if name.is_empty() { None } else { Some(name) }
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
  if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
    return String::new();
  }
  // CON/NUL/COM1 这些保留设备名在 Windows 上既建不了文件也存不进去。
  if is_reserved_name(&trimmed) { format!("_{trimmed}") } else { trimmed }
}

fn is_reserved_name(name: &str) -> bool {
  let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
  if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
    return true;
  }
  let bytes = stem.as_bytes();
  bytes.len() == 4
    && (stem.starts_with("COM") || stem.starts_with("LPT"))
    && bytes[3].is_ascii_digit()
    && bytes[3] != b'0'
}

#[cfg(test)]
mod tests {
  use super::{download_root, desired_file_name, move_file, query_path_name, sanitize_file_name, url_last_segment, DownloadState};
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
    assert_eq!(desired_file_name(&PathBuf::from(""), "https://example.com/a%20b.pdf"), "a b.pdf");
    assert_eq!(desired_file_name(&PathBuf::from(""), "/api/system/diagnostics"), "diagnostics");
    assert_eq!(desired_file_name(&PathBuf::from(""), "/api/files?download=1"), "download");
    assert_eq!(url_last_segment("/api/files?path=x"), None);
    assert_eq!(url_last_segment("https://example.com/dir/"), None);
  }

  #[test]
  fn prefers_the_real_name_over_a_generic_one() {
    // 内嵌 PDF 预览里点工具栏下载，WebView2 给的是 files.pdf，真名在 path 参数里。
    let url = "/api/files?path=D%3A%2Fp%2F%E6%8A%A5%E5%91%8A.pdf";
    assert_eq!(desired_file_name(&PathBuf::from("C:/Downloads/files.pdf"), url), "报告.pdf");
    assert_eq!(desired_file_name(&PathBuf::from("C:/Downloads/download"), url), "报告.pdf");
    assert_eq!(query_path_name("/api/files?path=a/b/c.txt&download=1").as_deref(), Some("c.txt"));
    assert_eq!(query_path_name("/api/files?download=1"), None);
  }

  #[test]
  fn escapes_reserved_device_names() {
    assert_eq!(sanitize_file_name("NUL"), "_NUL");
    assert_eq!(sanitize_file_name("aux.txt"), "_aux.txt");
    assert_eq!(sanitize_file_name("COM1.log"), "_COM1.log");
    assert_eq!(sanitize_file_name("COM0.txt"), "COM0.txt");
    assert_eq!(sanitize_file_name("console.md"), "console.md");
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
