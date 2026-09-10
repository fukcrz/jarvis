import type { ExtensionUiRequest } from "../../shared/protocol";

/**
 * 把 `ctx.ui.select` 的字符串负载拆回结构化数据。
 *
 * `ask_user_question`（`@juicesharp/rpiv-ask-user-question`）在非终端宿主里退化成
 * RPC 对话框：标题是「问题 + 每个选项的 `--- N. 标签 preview ---` 预览块」，选项是
 * `"N. 标签 — 描述"`，末尾再补一行 `"N+1. Type something."`。照原样渲染会变成一坨
 * 无法阅读的文本，且同一份选项在标题（预览）和选项行里出现两次。
 *
 * 这里只在形态完全匹配时解析；任何一处对不上就返回 `undefined`，由调用方回退到原始
 * 纯文本渲染，绝不丢信息、也绝不臆造选项。
 */

/** 描述分隔符：`rpc-fallback.ts` 的 `formatOptionLine` 固定拼 `label — description`。 */
const DESCRIPTION_SEPARATOR = " — ";
const OPTION_LINE = /^(\d+)\.\s+([\s\S]*)$/;
const PREVIEW_HEADER = /^---\s+(\d+)\.\s+(.*?)\s*preview\s*---$/;
/** 扩展给问题加的方括号短标签，例如「[统一顺序] ...」。 */
const SHORT_HEADER = /^\[([^\]\n]{1,16})\]\s+([\s\S]+)$/;
const ABSENT_DESCRIPTION = new Set(["", "undefined", "null"]);

export interface ExtensionSelectOption {
  /** 回传给扩展的原始字符串，必须逐字保持不变。 */
  value: string;
  /** 回退格式里的序号；解析不出时为 undefined。 */
  index?: number;
  label: string;
  description?: string;
  /** 该选项自己的预览正文（原本折叠在标题里）。 */
  preview?: string;
  /** 扩展自动追加的「自行输入」行。 */
  custom?: boolean;
}

export interface ExtensionSelectDialog {
  /** 方括号短标签，没有时为 undefined。 */
  header?: string;
  /** 已剥离预览块与短标签的问题正文。 */
  question: string;
  options: ExtensionSelectOption[];
}

export interface ExtensionDialogHeading {
  /** 方括号短标签，没有时为 undefined。 */
  header?: string;
  /** 标题正文（已去掉短标签）。 */
  question: string;
}

type SelectRequest = Pick<Extract<ExtensionUiRequest, { method: "select" }>, "title" | "options">;

/** 解析编号选项行；只要有一行不是「N. …」的形态就整体放弃。 */
export function parseSelectOptions(values: string[]): ExtensionSelectOption[] | undefined {
  if (values.length === 0) return undefined;
  const options: ExtensionSelectOption[] = [];
  const separated: boolean[] = [];
  for (const value of values) {
    const match = OPTION_LINE.exec(value.trim());
    if (match === null) return undefined;
    const body = match[2].trim();
    const separator = body.indexOf(DESCRIPTION_SEPARATOR);
    const label = (separator === -1 ? body : body.slice(0, separator)).trim();
    if (label === "") return undefined;
    const rawDescription = separator === -1 ? "" : body.slice(separator + DESCRIPTION_SEPARATOR.length).trim();
    separated.push(separator !== -1);
    options.push({
      value,
      index: Number(match[1]),
      label,
      ...(ABSENT_DESCRIPTION.has(rawDescription) ? {} : { description: rawDescription }),
    });
  }
  // 序号必须是 1..n，否则说明这不是扩展回退格式拼出来的列表。
  if (options.some((option, position) => option.index !== position + 1)) return undefined;

  // 末尾那行「Type something.」连分隔符都没有，而真实选项一定带 ` — 描述`。
  const last = options.at(-1)!;
  if (!separated.at(-1)! && separated.slice(0, -1).every(Boolean)) {
    options[options.length - 1] = { ...last, custom: true };
  }
  return options;
}

export function parseSelectDialog(request: SelectRequest): ExtensionSelectDialog | undefined {
  const options = parseSelectOptions(request.options);
  if (options === undefined) return undefined;

  const { question, previews } = extractPreviewBlocks(request.title);
  const indexes = new Set(options.map((option) => option.index));
  // 预览块必须一一对应到选项，否则形态和选项列表对不上。
  if (new Set(previews.map((preview) => preview.index)).size !== previews.length) return undefined;
  if (previews.some((preview) => !indexes.has(preview.index))) return undefined;
  const merged = options.map((option) => {
    const preview = previews.find((candidate) => candidate.index === option.index);
    return preview === undefined || preview.body === "" ? option : { ...option, preview: preview.body };
  });

  const heading = splitDialogHeading(question);
  if (heading.question === "") return undefined;
  return { ...(heading.header === undefined ? {} : { header: heading.header }), question: heading.question, options: merged };
}

/** 拆出扩展自己加的方括号短标签（如「[严格程度] 规则写多硬？」，没有标签就是整段标题）。 */
export function splitDialogHeading(title: string): ExtensionDialogHeading {
  const trimmed = title.trim();
  const match = SHORT_HEADER.exec(trimmed);
  return match === null ? { question: trimmed } : { header: match[1], question: match[2].trim() };
}

/** 问题标题：短标签 + 问题正文（不含折叠在标题里的预览正文）。 */
export function selectDialogTitle(dialog: ExtensionSelectDialog): string {
  return dialog.header === undefined ? dialog.question : `${dialog.header}：${dialog.question}`;
}

/** 已选择结果行只回显标签，不再重复整串「N. 标签 — 描述」。 */
export function selectAnswerLabel(options: string[], value: string): string {
  return parseSelectOptions(options)?.find((option) => option.value === value)?.label ?? value;
}

/** 折叠状态下的预览摘要：预览是等宽排版的对齐文本，只取第一行有内容的行。 */
export function previewSummary(preview: string): string {
  for (const line of preview.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed.replace(/\s+/g, " ");
  }
  return "";
}

function extractPreviewBlocks(title: string): { question: string; previews: Array<{ index: number; body: string }> } {
  const lines = title.split(/\r?\n/);
  const question: string[] = [];
  const previews: Array<{ index: number; body: string }> = [];
  for (let position = 0; position < lines.length; position += 1) {
    const header = PREVIEW_HEADER.exec((lines[position] ?? "").trim());
    if (header === null) {
      question.push(lines[position] ?? "");
      continue;
    }
    const body: string[] = [];
    let cursor = position + 1;
    while (cursor < lines.length && PREVIEW_HEADER.exec((lines[cursor] ?? "").trim()) === null) {
      body.push(lines[cursor] ?? "");
      cursor += 1;
    }
    previews.push({ index: Number(header[1]), body: body.join("\n").trim() });
    position = cursor - 1;
  }
  return { question: question.join("\n").trim(), previews };
}
