import { describe, expect, it } from "vitest";
import { isNotificationEnabled, notifyRunFinished, runNotificationContent } from "./notifications";

describe("runNotificationContent", () => {
  it("完成通知使用会话名与最后一条消息文本", () => {
    expect(runNotificationContent({ runId: "r1", failed: false, text: "  已修复 bug\n\n", sessionName: "demo" }))
      .toEqual({ title: "demo · 已完成", body: "已修复 bug" });
  });

  it("无文本时给出默认正文", () => {
    expect(runNotificationContent({ runId: "r1", failed: false }))
      .toEqual({ title: "Jarvis · 已完成", body: "回答已完成" });
  });

  it("失败通知优先展示错误信息", () => {
    expect(runNotificationContent({ runId: "r1", failed: true, errorMessage: "PI_RUNTIME_ERROR: boom", sessionName: "demo" }))
      .toEqual({ title: "demo · 运行失败", body: "PI_RUNTIME_ERROR: boom" });
  });

  it("失败且无错误信息时回退到最后一条文本", () => {
    expect(runNotificationContent({ runId: "r1", failed: true, text: "出错了", sessionName: "" }))
      .toEqual({ title: "Jarvis · 运行失败", body: "出错了" });
  });

  it("超长文本截断到 140 字符", () => {
    const { body } = runNotificationContent({ runId: "r1", failed: false, text: "a".repeat(300) });
    expect(body.endsWith("…")).toBe(true);
    expect(body.length).toBe(141);
  });
});

describe("notifyRunFinished 防御路径", () => {
  it("不支持通知的环境返回 unsupported（node 测试环境）", () => {
    expect(notifyRunFinished({ runId: "r1", failed: false })).toBe("unsupported");
  });

  it("默认开启通知", () => {
    expect(isNotificationEnabled()).toBe(true);
  });
});
