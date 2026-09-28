use serde::Deserialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

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

pub fn spawn_sidecar(node: &Path, root: &Path, port: u16, on_event: impl Fn(DesktopEvent) + Send + 'static) -> Result<Sidecar, String> {
  let entry = server_entry(root);
  if !entry.is_file() {
    return Err(format!("找不到服务入口：{}", entry.display()));
  }
  let mut command = Command::new(node);
  command
    .arg(&entry)
    .current_dir(root)
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

pub fn stop_sidecar(sidecar: &mut Sidecar) {
  let pid = sidecar.child.id();
  #[cfg(windows)]
  {
    let mut killer = Command::new("taskkill");
    killer.args(["/PID", &pid.to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    killer.creation_flags(CREATE_NO_WINDOW);
    let _ = killer.status();
  }
  #[cfg(not(windows))]
  {
    let _ = sidecar.child.kill();
  }
  let _ = sidecar.child.wait();
}

fn truncate_line(line: &str) -> String {
  if line.chars().count() <= MAX_DIAGNOSTIC_LINE_CHARS {
    return line.to_string();
  }
  format!("{}...", line.chars().take(MAX_DIAGNOSTIC_LINE_CHARS).collect::<String>())
}

#[cfg(test)]
mod tests {
  use super::{parse_desktop_line, DiagnosticTail};

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
}
