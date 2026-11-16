import assert from "node:assert";
import { test } from "node:test";
import {
  INITIAL_TASK_WATCH,
  TASK_WATCH_COOLDOWN_MS,
  TASK_WATCH_MAX,
  taskWatchDecision,
  unfinishedTasks,
} from "./task-watch.ts";

test("unfinishedTasks reads only unchecked boxes and caps the list", () => {
  const text = [
    "# 任务",
    "",
    "- [ ] 登录接口",
    "- [x] 支付回调",
    "* [ ]  对账脚本  ",
    "普通行不算",
    "- [ ] 第四项",
  ].join("\n");
  assert.deepEqual(unfinishedTasks(text), ["登录接口", "对账脚本", "第四项"]);
  assert.equal(unfinishedTasks(""), 0);
  const many = Array.from({ length: 15 }, (_, i) => `- [ ] item-${i}`).join("\n");
  assert.equal(unfinishedTasks(many).length, 10);
});

test("no pending items means no wake and a reset budget", () => {
  const decision = taskWatchDecision({
    text: "- [x] done",
    outstandingAsync: 0,
    busy: false,
    state: { signature: "old", wakes: 3, at: 0 },
    now: 1_000_000,
  });
  assert.equal(decision.wake, false);
  assert.deepEqual(decision.state, { ...INITIAL_TASK_WATCH, signature: "" });
});

test("running children or a scheduled turn suppress the wake", () => {
  const base = {
    text: "- [ ] 登录接口",
    state: INITIAL_TASK_WATCH,
    now: 1_000_000,
  };
  assert.equal(taskWatchDecision({ ...base, outstandingAsync: 1, busy: false }).wake, false);
  assert.equal(taskWatchDecision({ ...base, outstandingAsync: 0, busy: true }).wake, false);
});

test("wakes once per cooldown window and stops at the cap", () => {
  const text = "- [ ] 登录接口";
  let state = INITIAL_TASK_WATCH;
  const first = taskWatchDecision({ text, outstandingAsync: 0, busy: false, state, now: 1_000_000 });
  assert.equal(first.wake, true);
  assert.equal(first.state.wakes, 1);
  state = first.state;

  const tooSoon = taskWatchDecision({
    text,
    outstandingAsync: 0,
    busy: false,
    state,
    now: 1_000_000 + TASK_WATCH_COOLDOWN_MS - 1,
  });
  assert.equal(tooSoon.wake, false);

  for (let i = 0; i < TASK_WATCH_MAX + 3; i += 1) {
    const next = taskWatchDecision({
      text,
      outstandingAsync: 0,
      busy: false,
      state,
      now: 1_000_000 + TASK_WATCH_COOLDOWN_MS * (i + 1),
    });
    state = next.state;
  }
  assert.equal(state.wakes, TASK_WATCH_MAX);
  const capped = taskWatchDecision({
    text,
    outstandingAsync: 0,
    busy: false,
    state,
    now: 9_000_000,
  });
  assert.equal(capped.wake, false);
});

test("progress on the checklist refills the wake budget", () => {
  const spent = { signature: "- [ ] 登录接口\n- [ ] 支付回调", wakes: TASK_WATCH_MAX, at: 0 };
  const decision = taskWatchDecision({
    text: "- [ ] 登录接口",
    outstandingAsync: 0,
    busy: false,
    state: spent,
    now: 1_000_000,
  });
  assert.equal(decision.wake, true);
  assert.equal(decision.state.wakes, 1);
});
