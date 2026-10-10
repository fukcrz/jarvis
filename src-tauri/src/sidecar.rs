use serde::Deserialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const MAX_DIAGNOSTIC_LINES: usize = 40;
const MAX_DIAGNOSTIC_LINE_CHARS: usize = 500;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum DesktopEvent {
  #[serde(rename = "ready")]
  Ready { port: u16 },
  #[serde(rename = "restart")]
  Restart,
  #[serde(rename = "run-finished")]
  RunFinished {
    #[serde(rename = "workspaceId")]
    workspace_id: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "runId")]
    #[allow(dead_code)]
    run_id: String,
    failed: bool,
    #[serde(rename = "sessionName")]
    session_name: Option<String>,
    text: Option<String>,
    #[serde(rename = "errorMessage")]
    error_message: Option<String>,
  },
}

#[derive(Default)]
struct DiagnosticTail {
  lines: VecDeque<String>,
}

impl DiagnosticTail {
  fn push(&mut self, line: &str) {
    let line = truncate_line(line.trim());
    if line.is_empty() {
      return;
    }
    if self.lines.len() == MAX_DIAGNOSTIC_LINES {
      self.lines.pop_front();
    }
    self.lines.push_back(line);
  }

  fn text(&self) -> String {
    self.lines.iter().cloned().collect::<Vec<_>>().join("\n")
  }
}

pub struct Sidecar {
  child: Child,
  diagnostics: Arc<Mutex<DiagnosticTail>>,
}

#[derive(Default)]
pub struct SidecarSlot {
  pub child: Option<Sidecar>,
  pub closing: bool,
}

pub type SharedSidecar = Arc<Mutex<SidecarSlot>>;

/// Windows updater calls cleanup_before_exit, then exits without RunEvent::Exit.
/// Keep this guard only in the app resource table so that cleanup also stops Node.
pub struct SidecarCleanup(pub SharedSidecar);

impl tauri::Resource for SidecarCleanup {}

impl Drop for SidecarCleanup {
  fn drop(&mut self) {
    stop_managed_sidecar(&self.0, true);
  }
}

impl Sidecar {
  pub fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
    self.child.try_wait()
  }

  pub fn diagnostics(&self) -> String {
    self.diagnostics.lock().map(|tail| tail.text()).unwrap_or_default()
  }
}

pub fn parse_desktop_line(line: &str) -> Option<DesktopEvent> {
  serde_json::from_str(line.strip_prefix("JARVIS_DESKTOP:")?.trim()).ok()
}

pub fn server_entry(root: &Path) -> PathBuf {
  root.join("dist").join("server").join("server").join("index.js")
}

/// Node's CJS loader cannot resolve Windows verbatim paths (`\\?\C:\...`):
/// `realpathSync` collapses them to a bare drive letter and exits with EISDIR.
pub fn strip_windows_verbatim(path: &Path) -> PathBuf {
  let Some(text) = path.to_str() else {
    return path.to_path_buf();
  };
  if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
    let mut normalized = String::from(r"\\");
    normalized.push_str(rest);
    return PathBuf::from(normalized);
  }
  if let Some(rest) = text.strip_prefix(r"\\?\") {
    return PathBuf::from(rest);
  }
  path.to_path_buf()
}

pub fn spawn_sidecar(node: &Path, root: &Path, port: u16, on_event: impl Fn(DesktopEvent) + Send + 'static) -> Result<Sidecar, String> {
  let entry = server_entry(root);
  if !entry.is_file() {
    return Err(format!("找不到服务入口：{}", entry.display()));
  }
  let node = strip_windows_verbatim(node);
  let root = strip_windows_verbatim(root);
  let entry = strip_windows_verbatim(&entry);
  let mut command = Command::new(&node);
  command
    .arg(&entry)
    .current_dir(&root)
    .env("NODE_ENV", "production")
    .env("HOST", "0.0.0.0")
    .env("PORT", port.to_string())
    .env("JARVIS_DESKTOP", "1")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  #[cfg(windows)]
  {
    command.creation_flags(CREATE_NO_WINDOW);
  }
  let mut child = command.spawn().map_err(|error| format!("无法启动 Jarvis 服务：{error}"))?;
  let diagnostics = Arc::new(Mutex::new(DiagnosticTail::default()));
  if let Some(stdout) = child.stdout.take() {
    let diagnostics = Arc::clone(&diagnostics);
    thread::spawn(move || {
      let reader = BufReader::new(stdout);
      for line in reader.lines().map_while(Result::ok) {
        if let Some(event) = parse_desktop_line(&line) {
          on_event(event);
        } else if let Ok(mut tail) = diagnostics.lock() {
          tail.push(&line);
        }
      }
    });
  }
  if let Some(stderr) = child.stderr.take() {
    let diagnostics = Arc::clone(&diagnostics);
    thread::spawn(move || {
      let reader = BufReader::new(stderr);
      for line in reader.lines().map_while(Result::ok) {
        if let Ok(mut tail) = diagnostics.lock() {
          tail.push(&line);
        }
      }
    });
  }
  Ok(Sidecar { child, diagnostics })
}

/// Serialize spawn with exit cleanup so no child can appear after the guard runs.
pub fn spawn_managed_sidecar(slot: &SharedSidecar, node: &Path, root: &Path, port: u16, on_event: impl Fn(DesktopEvent) + Send + 'static) -> Result<bool, String> {
  let mut slot = slot.lock().unwrap_or_else(|error| error.into_inner());
  if slot.closing {
    return Ok(false);
  }
  slot.child = Some(spawn_sidecar(node, root, port, on_event)?);
  Ok(true)
}

pub fn stop_managed_sidecar(slot: &SharedSidecar, closing: bool) {
  let mut slot = slot.lock().unwrap_or_else(|error| error.into_inner());
  slot.closing |= closing;
  // Hold the lock through termination: updater exit must wait for an in-flight
  // restart stop too. stop_sidecar never joins the event-reader threads.
  if let Some(mut child) = slot.child.take() {
    stop_sidecar(&mut child);
  }
}

pub fn stop_sidecar(sidecar: &mut Sidecar) {
  let pid = sidecar.child.id();
  #[cfg(windows)]
  {
    let mut killer = Command::new("taskkill");
    killer.args(["/PID", &pid.to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    killer.creation_flags(CREATE_NO_WINDOW);
    if !killer.status().is_ok_and(|status| status.success()) {
      let _ = sidecar.child.kill();
    }
  }
  #[cfg(not(windows))]
  {
    let _ = sidecar.child.kill();
  }
  let deadline = Instant::now() + Duration::from_secs(5);
  loop {
    match sidecar.child.try_wait() {
      Ok(Some(_)) | Err(_) => return,
      Ok(None) => {}
    }
    if Instant::now() >= deadline {
      eprintln!("Jarvis service {pid} did not exit after termination");
      return;
    }
    thread::sleep(Duration::from_millis(20));
  }
}

fn truncate_line(line: &str) -> String {
  if line.chars().count() <= MAX_DIAGNOSTIC_LINE_CHARS {
    return line.to_string();
  }
  format!("{}...", line.chars().take(MAX_DIAGNOSTIC_LINE_CHARS).collect::<String>())
}

#[cfg(test)]
mod tests {
  use super::{parse_desktop_line, spawn_managed_sidecar, stop_managed_sidecar, stop_sidecar, strip_windows_verbatim, DiagnosticTail, SharedSidecar, SidecarCleanup};
  use std::fs;
  use std::path::{Path, PathBuf};
  use std::sync::{mpsc, Arc};
  use std::time::{Duration, SystemTime, UNIX_EPOCH};

  struct ServiceFixture {
    root: PathBuf,
    slot: SharedSidecar,
    resources: Option<tauri::ResourceTable>,
    port: u16,
  }

  impl ServiceFixture {
    fn start() -> Self {
      let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
      let root = std::env::temp_dir().join(format!("jarvis-sidecar-test-{}-{unique}", std::process::id()));
      let mut fixture = Self { root, slot: Arc::default(), resources: Some(tauri::ResourceTable::default()), port: 0 };
      fixture.resources.as_mut().unwrap().add(SidecarCleanup(Arc::clone(&fixture.slot)));
      let entry = super::server_entry(&fixture.root);
      fs::create_dir_all(entry.parent().unwrap()).unwrap();
      fs::write(&entry, r#"
const http = require('node:http');
const server = http.createServer((_, response) => response.end('fixture'));
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('JARVIS_DESKTOP:' + JSON.stringify({type: 'ready', port: server.address().port}) + '\n');
});
"#).unwrap();
      let (sender, receiver) = mpsc::channel();
      assert!(spawn_managed_sidecar(&fixture.slot, &which::which("node").expect("Node required for sidecar lifecycle tests"), &fixture.root, 0, move |event| {
        if let super::DesktopEvent::Ready { port } = event {
          let _ = sender.send(port);
        }
      }).unwrap());
      fixture.port = receiver.recv_timeout(Duration::from_secs(10)).expect("isolated sidecar ready event");
      assert_ne!(fixture.port, 9528);
      fixture
    }

    fn reachable(&self) -> bool {
      ureq::get(&format!("http://127.0.0.1:{}/", self.port)).timeout(Duration::from_secs(1)).call().is_ok()
    }
  }

  impl Drop for ServiceFixture {
    fn drop(&mut self) {
      self.resources.take();
      let _ = fs::remove_dir_all(&self.root);
    }
  }

  #[test]
  fn updater_resource_cleanup_stops_the_running_service_and_prevents_respawn() {
    let mut fixture = ServiceFixture::start();
    assert!(fixture.reachable(), "sidecar must stay alive after spawn returns");
    // Like cleanup_before_exit's ResourceTable::clear, dropping the table drops
    // the resource without calling Resource::close or RunEvent::Exit.
    fixture.resources.take();
    assert!(!fixture.reachable(), "updater cleanup must release the isolated port");
    assert!(fixture.slot.lock().unwrap().child.is_none());
    // Invalid paths prove cleanup is checked before attempting to launch Node.
    assert!(!spawn_managed_sidecar(&fixture.slot, Path::new("missing-node"), &fixture.root, 0, |_| {}).unwrap());
  }

  #[test]
  fn updater_cleanup_is_idempotent_after_normal_service_stop() {
    let mut fixture = ServiceFixture::start();
    stop_managed_sidecar(&fixture.slot, false);
    assert!(!fixture.reachable());
    fixture.resources.take();
    assert!(fixture.slot.lock().unwrap().closing);
    drop(SidecarCleanup(Arc::clone(&fixture.slot)));
    assert!(fixture.slot.lock().unwrap().child.is_none());
  }

  #[test]
  fn updater_cleanup_waits_for_an_inflight_stop() {
    let mut fixture = ServiceFixture::start();
    let slot = Arc::clone(&fixture.slot);
    let (taken_tx, taken_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let stopping = std::thread::spawn(move || {
      let mut slot = slot.lock().unwrap();
      let mut child = slot.child.take().unwrap();
      taken_tx.send(()).unwrap();
      // Pause after taking the process, the former gap before termination.
      let released = release_rx.recv_timeout(Duration::from_secs(5));
      stop_sidecar(&mut child);
      drop(slot);
      released.unwrap();
    });
    taken_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let resources = fixture.resources.take().unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (cleaned_tx, cleaned_rx) = mpsc::channel();
    let cleanup = std::thread::spawn(move || {
      started_tx.send(()).unwrap();
      drop(resources);
      cleaned_tx.send(()).unwrap();
    });
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let waiting = cleaned_rx.recv_timeout(Duration::from_millis(100));
    release_tx.send(()).unwrap();
    stopping.join().unwrap();
    cleanup.join().unwrap();
    assert!(matches!(waiting, Err(mpsc::RecvTimeoutError::Timeout)), "cleanup must wait for the active stop");
    assert!(!fixture.reachable());
    assert!(fixture.slot.lock().unwrap().closing);
  }

  #[test]
  fn parses_ready_event() {
    let event = parse_desktop_line("JARVIS_DESKTOP:{\"type\":\"ready\",\"port\":9528}\n").expect("event");
    match event {
      super::DesktopEvent::Ready { port } => assert_eq!(port, 9528),
      _ => panic!("expected ready"),
    }
  }

  #[test]
  fn keeps_the_latest_diagnostic_lines() {
    let mut tail = DiagnosticTail::default();
    for number in 0..42 {
      tail.push(&format!("line-{number}"));
    }
    let text = tail.text();
    assert!(!text.contains("line-0\n"));
    assert!(text.starts_with("line-2\n"));
    assert!(text.ends_with("line-41"));
  }

  #[test]
  fn strips_windows_verbatim_drive_prefix() {
    assert_eq!(
      strip_windows_verbatim(Path::new(r"\\?\C:\Users\app\Jarvis\resources\jarvis")),
      Path::new(r"C:\Users\app\Jarvis\resources\jarvis"),
    );
    assert_eq!(
      strip_windows_verbatim(Path::new(r"\\?\C:\Program Files\nodejs\node.exe")),
      Path::new(r"C:\Program Files\nodejs\node.exe"),
    );
  }

  #[test]
  fn strips_windows_verbatim_unc_prefix() {
    assert_eq!(
      strip_windows_verbatim(Path::new(r"\\?\UNC\server\share\jarvis")),
      Path::new(r"\\server\share\jarvis"),
    );
  }

  #[test]
  fn leaves_normal_paths_unchanged() {
    assert_eq!(
      strip_windows_verbatim(Path::new(r"C:\Users\app\Jarvis")),
      Path::new(r"C:\Users\app\Jarvis"),
    );
    assert_eq!(strip_windows_verbatim(Path::new(".")), Path::new("."));
    assert_eq!(
      strip_windows_verbatim(Path::new("/usr/local/jarvis")),
      Path::new("/usr/local/jarvis"),
    );
  }
}
