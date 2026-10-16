import { describe, expect, it } from "vitest";
import { STATIC_SETTINGS_ENTRIES, searchSettings, type SettingsSearchEntry } from "./settings-search";

const titles = (query: string, entries: readonly SettingsSearchEntry[] = STATIC_SETTINGS_ENTRIES) => searchSettings(entries, query).map((entry) => entry.title);

describe("searchSettings", () => {
  it("returns everything for an empty query", () => {
    expect(searchSettings(STATIC_SETTINGS_ENTRIES, "  ")).toHaveLength(Math.min(30, STATIC_SETTINGS_ENTRIES.length));
  });

  it("matches title, description and keywords case-insensitively", () => {
    expect(titles("助手")[0]).toBe("助手名称");
    expect(titles("CLOUDFLARE")).toContain("内网穿透");
    expect(titles("compaction")).toContain("重试等待 / 压缩阈值");
  });

  it("expands synonyms", () => {
    expect(titles("认证")).toContain("访问密码");
    expect(titles("公网")).toContain("内网穿透");
    expect(titles("beta")).toContain("更新通道");
  });

  it("requires every token and ranks title hits first", () => {
    expect(titles("访问 密码")[0]).toBe("访问密码");
    expect(titles("访问 回收站")).toEqual([]);
    const entries: SettingsSearchEntry[] = [
      { key: "a", title: "其他", description: "模型说明", category: "models", route: { page: "models" } },
      { key: "b", title: "模型组", category: "model-groups", route: { page: "model-groups" } },
    ];
    expect(titles("模型", entries)).toEqual(["模型组", "其他"]);
  });

  it("returns nothing for unknown words", () => {
    expect(titles("完全不存在的词")).toEqual([]);
  });
});
