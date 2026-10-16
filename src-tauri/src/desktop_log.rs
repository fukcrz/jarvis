//! 桌面端日志：写到 `~/.jarvis/logs/desktop-YYYY-MM-DD.log`（UTC 日期），
//! 记录服务的错误输出、崩溃、自动重启等。服务端自己的日志在同目录的 `server-*.log`，
//! 两边都由服务端按 7 天清理。写失败只丢这一行。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;

static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub fn jarvis_home() -> PathBuf {
  if let Some(home) = std::env::var_os("JARVIS_HOME").filter(|value| !value.is_empty()) {
    return PathBuf::from(home);
  }
  dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".jarvis")
}

pub fn log_dir() -> PathBuf {
  jarvis_home().join("logs")
}

pub fn write(line: &str) {
  let _guard = WRITE_LOCK.lock();
  let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
  let dir = log_dir();
  if fs::create_dir_all(&dir).is_err() {
    return;
  }
  let path = dir.join(format!("desktop-{}.log", utc_day(now)));
  if fs::metadata(&path).map(|meta| meta.len() > MAX_FILE_BYTES).unwrap_or(false) {
    return;
  }
  if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
    let _ = writeln!(file, "{} {}", utc_time(now), line.trim_end());
  }
}

/// 公历日期（UTC），不依赖 chrono。
pub fn utc_day(epoch_secs: u64) -> String {
  let days = (epoch_secs / 86_400) as i64;
  let (year, month, day) = civil_from_days(days);
  format!("{year:04}-{month:02}-{day:02}")
}

fn utc_time(epoch_secs: u64) -> String {
  let secs = epoch_secs % 86_400;
  format!("{}T{:02}:{:02}:{:02}Z", utc_day(epoch_secs), secs / 3600, (secs / 60) % 60, secs % 60)
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
  let z = days + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z.rem_euclid(146_097);
  let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
  let y = yoe + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
  let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
  (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
  use super::{utc_day, utc_time};

  #[test]
  fn formats_utc_dates() {
    assert_eq!(utc_day(0), "1970-01-01");
    assert_eq!(utc_day(1_792_130_692), "2026-10-16");
    assert_eq!(utc_day(951_782_400), "2000-02-29");
    assert_eq!(utc_time(1_792_130_692), "2026-10-16T06:04:52Z");
  }
}
