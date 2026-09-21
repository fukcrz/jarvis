use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

pub const NODE_VERSION: &str = "24.21.0";
const NODE_EXE_SHA256: &str = "ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32";
const NODE_EXE_URL: &str = "https://nodejs.org/dist/v24.21.0/win-x64/node.exe";

pub fn project_node_path() -> PathBuf {
  runtime_dir().join("node.exe")
}

pub fn runtime_dir() -> PathBuf {
  dirs::data_local_dir()
    .unwrap_or_else(|| PathBuf::from("."))
    .join("jarvis")
    .join("runtime")
    .join(format!("node-v{NODE_VERSION}"))
}

pub fn resolve_node() -> Result<PathBuf, String> {
  let project = project_node_path();
  if project.is_file() && node_version_ok(&project) {
    return Ok(project);
  }
  if let Ok(system) = which::which("node") {
    if node_version_ok(&system) {
      return Ok(system);
    }
  }
  Err("need-download".into())
}

pub fn node_version_ok(path: &Path) -> bool {
  let output = Command::new(path).arg("-v").output().ok();
  let Some(output) = output else { return false };
  if !output.status.success() {
    return false;
  }
  let text = String::from_utf8_lossy(&output.stdout);
  parse_major(text.trim()).is_some_and(|major| major >= 24)
}

fn parse_major(version: &str) -> Option<u32> {
  let trimmed = version.strip_prefix('v').unwrap_or(version);
  trimmed.split('.').next()?.parse().ok()
}

pub fn download_node() -> Result<PathBuf, String> {
  let dir = runtime_dir();
  fs::create_dir_all(&dir).map_err(|error| format!("无法创建运行时目录：{error}"))?;
  let dest = dir.join("node.exe");
  let temp = dir.join("node.exe.part");
  let response = ureq::get(NODE_EXE_URL)
    .call()
    .map_err(|error| format!("下载 Node 失败：{error}"))?;
  let mut file = fs::File::create(&temp).map_err(|error| format!("无法写入 Node：{error}"))?;
  let mut hasher = Sha256::new();
  let mut buffer = [0_u8; 64 * 1024];
  let mut reader = response.into_reader();
  loop {
    let read = reader.read(&mut buffer).map_err(|error| format!("下载 Node 失败：{error}"))?;
    if read == 0 {
      break;
    }
    file.write_all(&buffer[..read]).map_err(|error| format!("无法写入 Node：{error}"))?;
    hasher.update(&buffer[..read]);
  }
  file.flush().map_err(|error| format!("无法写入 Node：{error}"))?;
  drop(file);
  let digest = hex::encode(hasher.finalize());
  if digest != NODE_EXE_SHA256 {
    let _ = fs::remove_file(&temp);
    return Err("Node 校验失败，请重试".into());
  }
  fs::rename(&temp, &dest).map_err(|error| format!("无法保存 Node：{error}"))?;
  if !node_version_ok(&dest) {
    return Err("下载的 Node 版本不可用".into());
  }
  Ok(dest)
}

#[cfg(test)]
mod tests {
  use super::parse_major;

  #[test]
  fn parses_node_major() {
    assert_eq!(parse_major("v24.21.0"), Some(24));
    assert_eq!(parse_major("22.11.0"), Some(22));
  }
}
