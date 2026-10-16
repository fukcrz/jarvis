import { describe, expect, it } from "vitest";
import { RecentLogs } from "./recent-logs.js";

describe("RecentLogs", () => {
  it("keeps only the newest lines", () => {
    const logs = new RecentLogs(3);
    logs.push("a\nb\n");
    logs.push("c\nd\n");
    expect(logs.text()).toBe("b\nc\nd\n");
  });

  it("drops old lines over the byte budget", () => {
    const logs = new RecentLogs(100, 10);
    logs.push("1234\n5678\nabcd\n");
    expect(logs.text()).toBe("5678\nabcd\n");
  });
});
