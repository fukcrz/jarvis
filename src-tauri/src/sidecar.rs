use serde::Deserialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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

pub fn parse_desktop_line(line: &str) -> Option<DesktopEvent> {
  serde_json::from_str(line.strip_prefix("JARVIS_DESKTOP:")?.trim()).ok()
}

pub fn server_entry(root: &Path) -> PathBuf {
  root.join("dist").join("server").join("server").join("index.js")
}

pub fn spawn_sidecar(node: &Path, root: &Path, port: u16, on_event: impl Fn(DesktopEvent) + Send + 'static) -> Result<Child, String> {
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
  if let Some(stdout) = child.stdout.take() {
    thread::spawn(move || {
      let reader = BufReader::new(stdout);
      for line in reader.lines().map_while(Result::ok) {
        if let Some(event) = parse_desktop_line(&line) {
          on_event(event);
        }
      }
    });
  }
  if let Some(stderr) = child.stderr.take() {
    thread::spawn(move || {
      let reader = BufReader::new(stderr);
      for line in reader.lines().map_while(Result::ok) {
        eprintln!("{line}");
      }
    });
  }
  Ok(child)
}

pub fn stop_sidecar(child: &mut Child) {
  let pid = child.id();
  #[cfg(windows)]
  {
    let mut killer = Command::new("taskkill");
    killer.args(["/PID", &pid.to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    killer.creation_flags(CREATE_NO_WINDOW);
    let _ = killer.status();
  }
  #[cfg(not(windows))]
  {
    let _ = child.kill();
  }
  let _ = child.wait();
}

#[cfg(test)]
mod tests {
  use super::parse_desktop_line;

  #[test]
  fn parses_ready_event() {
    let event = parse_desktop_line("JARVIS_DESKTOP:{\"type\":\"ready\",\"port\":9528}\n").expect("event");
    match event {
      super::DesktopEvent::Ready { port } => assert_eq!(port, 9528),
      _ => panic!("expected ready"),
    }
  }
}
