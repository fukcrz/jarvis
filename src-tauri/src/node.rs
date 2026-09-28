use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const NODE_VERSION: &str = "24.21.0";
const NODE_EXE_SHA256: &str = "ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32";
const NODE_EXE_URL: &str = "https://nodejs.org/dist/v24.21.0/win-x64/node.exe";
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

pub fn project_node_path() -> PathBuf {
  runtime_dir().join("node.exe")
}

pub fn bundled_node_path(root: &Path) -> PathBuf {
  root.join("node.exe")
}

pub fn runtime_dir() -> PathBuf {
  dirs::data_local_dir()
    .unwrap_or_else(|| PathBuf::from("."))
    .join("jarvis")
    .join("runtime")
    .join(format!("node-v{NODE_VERSION}"))
}

pub fn resolve_node(root: &Path) -> Result<PathBuf, String> {
  let bundled = bundled_node_path(root);
  if bundled.is_file() && node_version_ok(&bundled) {
    return Ok(bundled);
  }
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
  let mut command = Command::new(path);
  command.arg("-v");
  #[cfg(windows)]
  command.creation_flags(CREATE_NO_WINDOW);
  let output = command.output().ok();
  let Some(output) = output else { return false };
  if !output.status.success() {
    return false;
  }
  let text = String::from_utf8_lossy(&output.stdout);
  parse_version(text.trim()).is_some_and(version_usable)
}

fn parse_version(version: &str) -> Option<(u32, u32)> {
  let trimmed = version.strip_prefix('v').unwrap_or(version);
  let mut parts = trimmed.split('.');
  let major = parts.next()?.parse().ok()?;
  let minor = parts.next().unwrap_or("0").parse().ok()?;
  Some((major, minor))
}

fn version_usable(version: (u32, u32)) -> bool {
  version.0 > 22 || (version.0 == 22 && version.1 >= 19)
}

pub fn download_node(mut on_progress: impl FnMut(u64, Option<u64>)) -> Result<PathBuf, String> {
  let dir = runtime_dir();
  fs::create_dir_all(&dir).map_err(|error| format!("无法创建运行时目录：{error}"))?;
  let dest = dir.join("node.exe");
  let temp = dir.join("node.exe.part");
  let result = download_node_to(&temp, &mut on_progress);
  if result.is_err() {
    let _ = fs::remove_file(&temp);
  }
  result?;
  fs::rename(&temp, &dest).map_err(|error| format!("无法保存 Node：{error}"))?;
  if !node_version_ok(&dest) {
    return Err("下载的 Node 版本不可用".into());
  }
  Ok(dest)
}

fn download_node_to(temp: &Path, on_progress: &mut impl FnMut(u64, Option<u64>)) -> Result<(), String> {
  let response = ureq::get(NODE_EXE_URL)
    .timeout(DOWNLOAD_TIMEOUT)
    .call()
    .map_err(|error| format!("下载 Node 失败：{error}"))?;
  let total = response.header("Content-Length").and_then(|value| value.parse().ok());
  let mut file = fs::File::create(temp).map_err(|error| format!("无法写入 Node：{error}"))?;
  let mut hasher = Sha256::new();
  let mut buffer = [0_u8; 64 * 1024];
  let mut reader = response.into_reader();
  let mut downloaded = 0_u64;
  on_progress(0, total);
  loop {
    let read = reader.read(&mut buffer).map_err(|error| format!("下载 Node 失败：{error}"))?;
    if read == 0 {
      break;
    }
    file.write_all(&buffer[..read]).map_err(|error| format!("无法写入 Node：{error}"))?;
    hasher.update(&buffer[..read]);
    downloaded += read as u64;
    on_progress(downloaded, total);
  }
  file.flush().map_err(|error| format!("无法写入 Node：{error}"))?;
  drop(file);
  let digest = hex::encode(hasher.finalize());
  if digest != NODE_EXE_SHA256 {
    return Err("Node 校验失败，请重试".into());
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::{bundled_node_path, parse_version, version_usable};
  use std::path::{Path, PathBuf};

  #[test]
  fn parses_node_version() {
    assert_eq!(parse_version("v24.21.0"), Some((24, 21)));
    assert_eq!(parse_version("22.19.0"), Some((22, 19)));
    assert_eq!(parse_version("22"), Some((22, 0)));
  }

  #[test]
  fn accepts_pi_supported_node_versions() {
    assert!(!version_usable((20, 19)));
    assert!(!version_usable((22, 18)));
    assert!(version_usable((22, 19)));
    assert!(version_usable((24, 0)));
  }

  #[test]
  fn resolves_bundled_node_from_resource_root() {
    assert_eq!(
      bundled_node_path(Path::new("resources/jarvis")),
      PathBuf::from("resources").join("jarvis").join("node.exe"),
    );
  }
}
