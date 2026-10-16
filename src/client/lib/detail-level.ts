export type DetailLevel = "concise" | "normal" | "verbose";

export const DETAIL_LEVEL_STORAGE_KEY = "jarvis.timeline.detailLevel";

export const DETAIL_LEVELS: ReadonlyArray<{ value: DetailLevel; label: string; hint: string }> = [
  { value: "concise", label: "简洁", hint: "只看回答，过程只留标题" },
  { value: "normal", label: "普通", hint: "运行时展开过程，完成后收起" },
  { value: "verbose", label: "详细", hint: "过程和思考都展开" },
];

export function parseDetailLevel(value: unknown): DetailLevel {
  return value === "concise" || value === "verbose" ? value : "normal";
}

export function readDetailLevel(): DetailLevel {
  try {
    return parseDetailLevel(window.localStorage.getItem(DETAIL_LEVEL_STORAGE_KEY));
  } catch {
    return "normal";
  }
}

export function writeDetailLevel(level: DetailLevel): void {
  try {
    if (level === "normal") window.localStorage.removeItem(DETAIL_LEVEL_STORAGE_KEY);
    else window.localStorage.setItem(DETAIL_LEVEL_STORAGE_KEY, level);
  } catch {
    // 存不了就只在本次生效。
  }
}
