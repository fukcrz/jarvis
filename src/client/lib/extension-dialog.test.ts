import { describe, expect, it } from "vitest";
import { parseSelectDialog, parseSelectOptions, previewSummary, selectAnswerLabel, selectDialogTitle } from "./extension-dialog";

/**
 * 标题按 `rpc-fallback.ts` 的 `buildPreviewBlock` 拼法构造：问题 + `\n\n` +
 * `--- N. 标签 preview ---\n正文`，多个预览块之间同样用 `\n\n` 分隔。
 */
function questionnaireTitle(question: string, previews: Array<{ index: number; label: string; body: string }>): string {
  const blocks = previews.map((preview) => `--- ${String(preview.index)}. ${preview.label} preview ---\n${preview.body}`);
  return blocks.length === 0 ? question : `${question}\n\n${blocks.join("\n\n")}`;
}

const FIRST_LABEL = "a8pi → anzhiyu → relay1 → a8pi2 → relay2";
const SECOND_LABEL = "a8pi → a8pi2 → anzhiyu → relay1 → relay2";
const THIRD_LABEL = "anzhiyu → a8pi → relay1 → a8pi2 → relay2";
const FIRST_OPTION = `${FIRST_LABEL} — 不发明新规则，直接沿用 terra/5.5/gpt-sol/gpt6 现有顺序；luna 只需按同一排序重排（或补齐）。`;
const SECOND_OPTION = `${SECOND_LABEL} — 同一家（https://www.a8pi.com）的两个 key 相邻，a8pi2 上移到 anzhiyu 之前；会影响 terra/5.5/gpt-sol/gpt6 三组现有顺序。`;
const THIRD_OPTION = `${THIRD_LABEL} — anzhiyu 提到第一优先，a8pi 第二；同样会影响 terra/5.5/gpt-sol/gpt6 现有顺序。`;
const CUSTOM_OPTION = "Type something.";

const TITLE = questionnaireTitle("[统一顺序] gpt 组统一后的 provider 优先顺序，确定哪一种？", [
  {
    index: 1,
    label: FIRST_LABEL,
    body: [
      "统一后（推荐）",
      "",
      " luna  : a8pi → anzhiyu → relay-tech-gpt1 → a8pi2 → relay-tech-gpt2",
      " terra : a8pi → anzhiyu → relay-tech-gpt1 → a8pi2 → relay-tech-gpt2",
      "",
      "说明：a8pi2 是 f9da106 时按「置于 relay1 之后」加的，顺序保持不变。",
    ].join("\n"),
  },
  { index: 2, label: SECOND_LABEL, body: "按“同厂相邻”排序\n\n luna  : a8pi → a8pi2 → anzhiyu → relay-tech-gpt1 → relay-tech-gpt2" },
  { index: 3, label: THIRD_LABEL, body: "anzhiyu 优先\n\n注意：anzhiyu 的 luna 目前正在熔断（failures=4）。" },
]);

const OPTIONS = [`1. ${FIRST_OPTION}`, `2. ${SECOND_OPTION}`, `3. ${THIRD_OPTION}`, `4. ${CUSTOM_OPTION}`];

describe("parseSelectDialog", () => {
  it("把折叠在标题里的预览块并回对应选项，问题正文不再重复选项", () => {
    const dialog = parseSelectDialog({ title: TITLE, options: OPTIONS });

    expect(dialog).toBeDefined();
    expect(dialog!.header).toBe("统一顺序");
    expect(dialog!.question).toBe("gpt 组统一后的 provider 优先顺序，确定哪一种？");
    expect(dialog!.options.map((option) => option.label)).toEqual([FIRST_LABEL, SECOND_LABEL, THIRD_LABEL, CUSTOM_OPTION]);
    expect(dialog!.options.map((option) => option.description)).toEqual([
      "不发明新规则，直接沿用 terra/5.5/gpt-sol/gpt6 现有顺序；luna 只需按同一排序重排（或补齐）。",
      "同一家（https://www.a8pi.com）的两个 key 相邻，a8pi2 上移到 anzhiyu 之前；会影响 terra/5.5/gpt-sol/gpt6 三组现有顺序。",
      "anzhiyu 提到第一优先，a8pi 第二；同样会影响 terra/5.5/gpt-sol/gpt6 现有顺序。",
      undefined,
    ]);
    expect(dialog!.options[0]!.preview).toContain("terra : a8pi → anzhiyu");
    expect(dialog!.options[1]!.preview).toContain("同厂相邻");
    expect(dialog!.options[2]!.preview).toContain("熔断（failures=4）");
    expect(dialog!.options[3]!.preview).toBeUndefined();
    expect(dialog!.options.map((option) => option.value)).toEqual(OPTIONS);
  });

  it("只有末尾那行没有描述时才判定为「自行输入」", () => {
    const dialog = parseSelectDialog({ title: "要继续吗？", options: ["1. 继续 — 立即执行", "2. 取消"] });

    expect(dialog!.options.map((option) => option.custom)).toEqual([undefined, true]);
    expect(dialog!.options[1]!.label).toBe("取消");
  });

  it("所有选项都没有描述时不误判自行输入行", () => {
    const dialog = parseSelectDialog({ title: "选一个", options: ["1. 甲", "2. 乙"] });

    expect(dialog!.options.every((option) => option.custom === undefined)).toBe(true);
    expect(dialog!.options.map((option) => option.label)).toEqual(["甲", "乙"]);
  });

  it("丢弃拼接产生的 undefined 描述", () => {
    const options = parseSelectOptions(["1. 甲 — undefined", "2. Type something."]);

    expect(options![0]!.description).toBeUndefined();
    expect(options![1]!.custom).toBe(true);
  });

  it("预览块对不上选项序号时整体放弃解析", () => {
    const title = questionnaireTitle("问题", [{ index: 5, label: "幽灵选项", body: "内容" }]);

    expect(parseSelectDialog({ title, options: ["1. 甲 — a", "2. 乙 — b"] })).toBeUndefined();
  });

  it("两个预览块指向同一个序号时整体放弃解析", () => {
    const title = questionnaireTitle("问题", [
      { index: 1, label: "甲", body: "第一份" },
      { index: 1, label: "甲", body: "第二份" },
    ]);

    expect(parseSelectDialog({ title, options: ["1. 甲 — a", "2. Type something."] })).toBeUndefined();
  });

  it("标签自身带分隔符时按第一个分隔符切分，回传值保持原样", () => {
    const options = parseSelectOptions(["1. 甲 — 乙 — 说明", "2. Type something."]);

    expect(options![0]!.label).toBe("甲");
    expect(options![0]!.description).toBe("乙 — 说明");
    expect(options![0]!.value).toBe("1. 甲 — 乙 — 说明");
  });

  it("选项行不是编号列表时放弃解析，交给调用方原样渲染", () => {
    expect(parseSelectDialog({ title: "Pick a model", options: ["gpt-5 luna", "gpt-5 terra"] })).toBeUndefined();
    expect(parseSelectDialog({ title: "Pick a model", options: ["1. 甲 — a", "乙"] })).toBeUndefined();
    expect(parseSelectDialog({ title: "Pick a model", options: [] })).toBeUndefined();
  });

  it("剥掉方括号短标签，但保留问题里的其它方括号", () => {
    const dialog = parseSelectDialog({ title: "[范围] 这次改动包含 [A] 部分吗？", options: ["1. 包含 — 是", "2. Type something."] });

    expect(dialog!.header).toBe("范围");
    expect(dialog!.question).toBe("这次改动包含 [A] 部分吗？");
  });
});

describe("selectAnswerLabel", () => {
  it("已选择结果只显示标签", () => {
    expect(selectAnswerLabel(OPTIONS, OPTIONS[0]!)).toBe(FIRST_LABEL);
    expect(selectAnswerLabel(OPTIONS, OPTIONS[3]!)).toBe(CUSTOM_OPTION);
    expect(selectAnswerLabel(OPTIONS, "手输的内容")).toBe("手输的内容");
  });
});

describe("selectDialogTitle", () => {
  it("拼成「短标签：问题」，没有短标签时只给问题", () => {
    const dialog = parseSelectDialog({ title: TITLE, options: OPTIONS })!;
    expect(selectDialogTitle(dialog)).toBe("统一顺序：gpt 组统一后的 provider 优先顺序，确定哪一种？");
    expect(selectDialogTitle({ question: "要继续吗？", options: [] })).toBe("要继续吗？");
  });
});

describe("previewSummary", () => {
  it("取第一行有内容的文本并压缩空白", () => {
    expect(previewSummary("\n\n  统一后（推荐）  \n luna : a → b")).toBe("统一后（推荐）");
    expect(previewSummary("   ")).toBe("");
  });
});
