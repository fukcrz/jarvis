//! 服务看门狗的纯逻辑：重启次数预算和退避间隔。

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// 健康检查间隔。
pub const CHECK_INTERVAL: Duration = Duration::from_secs(5);
/// 单次健康检查超时。
pub const HEALTH_TIMEOUT: Duration = Duration::from_secs(4);
/// 连续这么多次没响应，就认为服务卡死。
pub const MAX_MISSED_HEALTH: u32 = 4;
/// 时间窗口内最多自动重启几次，超过就停下来提示用户。
pub const MAX_RESTARTS: usize = 3;
pub const RESTART_WINDOW: Duration = Duration::from_secs(5 * 60);

#[derive(Default)]
pub struct RestartBudget {
  history: VecDeque<Instant>,
}

impl RestartBudget {
  /// 记一次重启；返回 false 表示窗口内已经重启太多次，应该停下。
  pub fn try_take(&mut self, now: Instant) -> bool {
    while self.history.front().is_some_and(|at| now.duration_since(*at) > RESTART_WINDOW) {
      self.history.pop_front();
    }
    if self.history.len() >= MAX_RESTARTS {
      return false;
    }
    self.history.push_back(now);
    true
  }

  /// 本轮重启前的等待：1、2、4 秒……
  pub fn backoff(&self) -> Duration {
    let attempts = self.history.len().saturating_sub(1).min(5) as u32;
    Duration::from_secs(1u64 << attempts)
  }

  pub fn reset(&mut self) {
    self.history.clear();
  }
}

#[cfg(test)]
mod tests {
  use super::{RestartBudget, MAX_RESTARTS, RESTART_WINDOW};
  use std::time::{Duration, Instant};

  #[test]
  fn allows_a_few_restarts_per_window() {
    let start = Instant::now();
    let mut budget = RestartBudget::default();
    for _ in 0..MAX_RESTARTS {
      assert!(budget.try_take(start));
    }
    assert!(!budget.try_take(start + Duration::from_secs(10)));
    assert!(budget.try_take(start + RESTART_WINDOW + Duration::from_secs(1)));
  }

  #[test]
  fn backs_off_exponentially() {
    let start = Instant::now();
    let mut budget = RestartBudget::default();
    budget.try_take(start);
    assert_eq!(budget.backoff(), Duration::from_secs(1));
    budget.try_take(start);
    assert_eq!(budget.backoff(), Duration::from_secs(2));
    budget.try_take(start);
    assert_eq!(budget.backoff(), Duration::from_secs(4));
  }
}
