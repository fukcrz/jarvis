import type { ExtensionUiRequest } from "../../shared/protocol";

/**
 * 把 `ask_user_question` 在非终端宿主里的 RPC 回退负载拆回结构化数据。
 *
 * 单选走 `ctx.ui.select`：标题是「问题 + 每个选项的 `--- N. 标签 preview ---` 预览块」，
 * 选项是 `"N. 标签 — 描述"`，末尾再补一行 `"N+1. Type something."`。
 *
 * 多选走 `ctx.ui.input`：placeholder 固定 `1,3`，标题是「问题 + 编号选项列表 + 英/中文说明」。
 * 扩展只收一段字符串：纯序号当多选，含任何非序号令牌就当整段自定义回答。
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
/** `rpc-fallback.ts` 的 `MULTI_SELECT_PLACEHOLDER`，不随语言变。 */
export const MULTI_SELECT_PLACEHOLDER = "1,3";
/** 勾选 + 补充同时提交时，把选项标签和补充打成一段自定义文本；扩展会当 `kind: "custom"`。 */
const MULTI_NOTE_SEPARATOR = " — ";

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
type InputRequest = Pick<Extract<ExtensionUiRequest, { method: "input" }>, "title" | "placeholder">;

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

/**
 * 识别多选 RPC 回退的 `ui.input`：placeholder 必须是 `1,3`，标题必须能拆出编号选项列表。
 * 选项列表没有「Type something.」行（自定义回答靠非序号文本），说明句从问题正文里剥掉。
 */
export function parseMultiSelectDialog(request: InputRequest): ExtensionSelectDialog | undefined {
  if (request.placeholder !== MULTI_SELECT_PLACEHOLDER) return undefined;
  const lines = request.title.split(/\r?\n/).map((line) => line.trim());
  const optionLines: string[] = [];
  let firstOption = -1;
  let lastOption = -1;
  for (let position = 0; position < lines.length; position += 1) {
    const line = lines[position] ?? "";
    if (!OPTION_LINE.test(line)) continue;
    if (firstOption === -1) firstOption = position;
    // 选项必须连成一块；中间夹空行或说明就不是这份回退格式。说明句只允许出现在整块之后。
    if (lastOption !== -1 && position !== lastOption + 1) return undefined;
    lastOption = position;
    optionLines.push(line);
  }
  if (firstOption < 1 || lastOption === -1) return undefined;
  const options = parseSelectOptions(optionLines);
  if (options === undefined || options.some((option) => option.custom === true) || options.length < 2) return undefined;
  if (options.some((option) => option.description === undefined)) return undefined;

  const before = lines.slice(0, firstOption).filter((line) => line !== "").join("\n");
  const heading = splitDialogHeading(before);
  if (heading.question === "") return undefined;
  return { ...(heading.header === undefined ? {} : { header: heading.header }), question: heading.question, options };
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

/**
 * 多选提交值。扩展只认「纯序号」或「整段自定义」二选一：
 * - 只勾选项 → `"1,3"`
 * - 只写补充 → 补充原文
 * - 勾选 + 补充 → `"标签A, 标签B — 补充"`（走自定义通道，两边都进模型）
 * - 都空 → `""`（扩展当成空多选）
 */
export function encodeMultiSelectValue(options: ExtensionSelectOption[], selected: ReadonlySet<number>, note: string): string {
  const indexes = [...selected].filter((index) => Number.isInteger(index) && index >= 1 && index <= options.length).sort((left, right) => left - right);
  const trimmed = note.trim();
  if (indexes.length === 0) return trimmed;
  if (trimmed === "") return indexes.join(",");
  const labels = indexes.map((index) => options[index - 1]?.label).filter((label): label is string => label !== undefined && label !== "");
  if (labels.length === 0) return trimmed;
  return `${labels.join(", ")}${MULTI_NOTE_SEPARATOR}${trimmed}`;
}

/** 已提交的多选结果：纯序号回显成标签，其它原样。 */
export function multiSelectAnswerLabel(options: ExtensionSelectOption[], value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  const tokens = trimmed.split(/[,\s]+/).filter((token) => token.length > 0);
  if (tokens.length === 0 || tokens.some((token) => !/^\d+\.?$/.test(token))) return value;
  const labels: string[] = [];
  for (const token of tokens) {
    const index = Number.parseInt(token, 10);
    const option = options[index - 1];
    if (option === undefined || option.index !== index) return value;
    if (!labels.includes(option.label)) labels.push(option.label);
  }
  return labels.join("、");
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
