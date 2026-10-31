/**
 * 真实执行的命令摘要：剥掉赋值、变量、目录切换、输出重定向和纯提示 echo，
 * 只留真正在跑的东西；多步用 `→` 串起来，超出的折成 `+N`。
 */

const NOISE_HEADS = new Set([
  "cd", "pushd", "popd", "sleep", "true", "false", ":", "echo", "printf", "wait", "exit", "pwd",
  "continue", "break", "shift",
  // 控制结构：本身不是命令，循环/条件体里的语句会单独出现。
  "for", "while", "until", "if", "elif", "else", "then", "fi", "do", "done", "case", "esac",
  "function", "switch", "foreach", "try", "catch", "finally", "begin", "process", "end",
  "[", "[[", "test",
  "{", "}", "(", ")", "};", "}'",
]);
const CONTROL_HEADS = new Set(["foreach", "for", "while", "until", "if", "try", "switch", "function", "catch", "finally", "process", "begin", "end"]);
const WRAPPERS = new Set(["sudo", "time", "nohup", "env", "command", "builtin", "exec", "export", "local", "readonly", "declare", "do", "then", "else", "elif"]);
const ASSIGNMENT = /^(?:export\s+|local\s+|readonly\s+|declare\s+(?:-\w+\s+)*|set\s+)?([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
/** PowerShell 赋值：`$name = value`、`$env:NAME = value`。 */
const PS_ASSIGNMENT = /^\$(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*)$/;
const HEREDOC = /<<-?\s*(['"]?)([A-Z][A-Z0-9_]*)\1/;
/** PowerShell here-string：`@'` 换行 … 换行 `'@`。 */
const HERE_STRING = /@(['"])[ \t]*\r?\n[\s\S]*?\r?\n\1@/g;
/** 内联脚本：带换行或空白很多的长引号参数，整段折叠。 */
const CODE_ARG = /(['"])((?:\\.|(?!\1).){81,})\1/g;
/** 纯变量展开或命令替换的参数，折叠。 */
const SUBSTITUTION_ARG = /(['"])\$\(\s*cat\b[^'"]*\1/g;
const LONG_PATH = /(^|[\s"'(=:])((?:[A-Za-z]:)?[/\\]?(?:[^\s"'():|;&]*[/\\]){4,}[^\s"'():|;&]*)/g;
const PREFIX_ASSIGNMENT = /^(?:export\s+|local\s+|readonly\s+|declare\s+(?:-\w+\s+)*|set\s+)?(?:\$)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*/;
const QUOTED_HEAD = /^(["'])([^"']{24,})\1/;
/** `"$(cat <<'EOF' )"`：heredoc 抠完剩下未闭合的命令替换。 */
const UNCLOSED_SUBSTITUTION = /(["'])\$\(\s*cat\b[\s\S]*$/;
/** `python -c "<code>"`、`node -e "<code>"` 这类执行标志后面的整段脚本。 */
const EVAL_FLAG_ARG = /(\s(?:-e|-c|--eval|-Command|--command|-EncodedCommand)\s+)(["'])(?:\\.|(?!\2)[\s\S])*\2/g;
const SCRIPT_RUNNERS = new Set(["node", "nodejs", "deno", "bun", "python", "python3", "py", "bash", "sh", "zsh", "pwsh", "powershell", "ruby", "perl", "php"]);

export interface CommandSummaryOptions {
  /** 最多展开多少步，默认 3。 */
  steps?: number;
  /** 是否补 `+N`，默认补。 */
  count?: boolean;
}

export interface CommandSummary {
  /** 单行展示用的真实命令；多步时用 `→` 串起来。 */
  text: string;
  /** 被折叠掉的步骤数。 */
  hidden: number;
}

const MAX_STEPS = 3;
const MAX_TEXT = 150;
const MAX_VALUE = 240;

export function commandSummary(command?: string, options: CommandSummaryOptions = {}): CommandSummary {
  const raw = (command ?? "").trim();
  if (raw === "") return { text: "", hidden: 0 };
  const statements = splitStatements(stripHeredocBodies(stripHereStrings(raw)));
  const variables = collectVariables(statements);
  const steps = dedupe(statements
    .map((statement) => cleanStatement(statement, variables))
    .filter((statement): statement is string => statement !== undefined));
  if (steps.length === 0) return { text: fallbackHeadline(raw), hidden: 0 };
  const shown = steps.slice(0, options.steps ?? MAX_STEPS);
  const hidden = steps.length - shown.length;
  const suffix = hidden > 0 && options.count !== false ? ` → +${String(hidden)}` : "";
  const budget = MAX_TEXT - suffix.length;
  let text = shown.join(" → ");
  if (text.length > budget) {
    const cut = text.slice(0, budget - 1);
    const boundary = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("/"));
    text = `${(boundary > budget * 0.7 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
  }
  return { text: `${text}${suffix}`, hidden };
}

/** 行内只展示摘要；空字符串表示没有可解析的内容。 */
export function commandLabel(command?: string, options: CommandSummaryOptions = {}): string {
  const { text } = commandSummary(command, options);
  return text === "" ? "命令" : text;
}

/** 解析失败时的退路：与旧行为一致，取第一行非空内容。 */
function fallbackHeadline(raw: string): string {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const first = lines[0] ?? "";
  const headline = lines.length > 1 ? `${first} …` : first;
  return headline.length > MAX_TEXT ? `${headline.slice(0, MAX_TEXT - 1).trimEnd()}…` : headline;
}

function dedupe(statements: string[]): string[] {
  const output: string[] = [];
  for (const statement of statements) if (output.at(-1) !== statement) output.push(statement);
  return output;
}

/** PowerShell here-string 的正文同样是内联脚本，整段丢掉。 */
function stripHereStrings(command: string): string {
  if (!command.includes("@'") && !command.includes('@"')) return command;
  // 换成空字符串：`@'…'@ | python -` 剩下 `"" | python -`，管道那头才是命令。
  return command.replace(HERE_STRING, '""');
}

/** heredoc 正文是内联脚本，整段丢掉，只留 `<<EOF` 标记。 */
function stripHeredocBodies(command: string): string {
  if (!command.includes("<<")) return command;
  const lines = command.split(/\r?\n/);
  const kept: string[] = [];
  let terminator: string | undefined;
  for (const line of lines) {
    if (terminator !== undefined) {
      if (line.trim() === terminator) terminator = undefined;
      continue;
    }
    kept.push(line);
    const match = HEREDOC.exec(line);
    const marker = match?.[2];
    if (marker !== undefined) terminator = marker;
  }
  return kept.join("\n");
}

/** 按顶层 `&&`、`||`、`;`、换行切分；引号、括号内的内容不切。 */
function splitStatements(command: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: string | undefined;
  let depth = 0;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote !== undefined) {
      current += char;
      if (char === "\\" && quote === '"') {
        current += command[index + 1] ?? "";
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "\\") {
      current += char + (command[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (char === "(" || char === "{") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ")" || char === "}") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (depth === 0 && (pair === "&&" || pair === "||")) {
      statements.push(current);
      current = "";
      index += 1;
      continue;
    }
    if (depth === 0 && (char === ";" || char === "\n")) {
      statements.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  statements.push(current);
  return statements.map((statement) => statement.trim()).filter((statement) => statement !== "");
}

/** 顶层赋值留成变量表，后面的 `"$VAR"` 才能还原成真正的命令。 */
function collectVariables(statements: string[]): Map<string, string> {
  const variables = new Map<string, string>();
  for (const statement of statements) {
    const match = ASSIGNMENT.exec(statement.trim()) ?? PS_ASSIGNMENT.exec(statement.trim());
    if (match === null) continue;
    const [, name, value] = match;
    if (name === undefined || value === undefined) continue;
    // 只还原字面值：命令结果（`$aapt=Get-ChildItem …`）自己会单独成一步。
    const rawValue = value.trim();
    const literal = /^(['"])[\s\S]*\1$/.test(rawValue) || /^[^\s@]+$/.test(rawValue);
    if (!literal) continue;
    const trimmed = unquote(rawValue);
    if (trimmed === "" || trimmed.length > MAX_VALUE) continue;
    if (trimmed.includes("$(") || trimmed.includes("`")) continue;
    variables.set(name, trimmed);
  }
  return variables;
}

function unquote(value: string): string {
  const match = /^(['"])([\s\S]*)\1$/.exec(value);
  return match?.[2] === undefined ? value : match[2];
}

function cleanStatement(statement: string, variables: Map<string, string>, depth = 0): string | undefined {
  let text = stripRedirections(statement);
  const assigned = unwrapPowerShellAssignment(text);
  if (assigned === undefined) return undefined;
  text = dropEmptyLiteral(substitute(assigned));
  text = dropEmptyLiteral(substitute(stripPrefixes(text)));
  text = expandVariables(text, variables);
  if (text.startsWith("$(") && text.endsWith(")") && depth < 3) return cleanStatement(text.slice(2, -1), variables, depth + 1);
  if (text.startsWith("(") && depth < 3) {
    const inner = unwrapPropertyAccess(text);
    if (inner !== text) return cleanStatement(inner, variables, depth + 1);
    const leading = stripLeadingParens(text);
    if (leading !== text) return cleanStatement(leading, variables, depth + 1);
  }
  text = normalizeHead(text);
  if (isControlBlock(text) && depth < 3) {
    const body = blockBody(text);
    if (body !== undefined) return cleanStatement(body, variables, depth + 1);
  }
  if (text === "" || text.startsWith("-") || text.startsWith("$") || isNoise(text)) return undefined;
  text = shortenPaths(text);
  text = collapseCodeArguments(text);
  text = text.replace(/\s+/g, " ").replace(/[;{}\s]+$/, "").trim();
  if (text === "" || isNoise(text)) return undefined;
  return text;
}

/** here-string 抠空后留下的 `"" | python -`：空字面量不是命令，管道那头才是。 */
function dropEmptyLiteral(statement: string): string {
  return statement.replace(/^\s*\|+\s*/, "").replace(/^(?:""|'')?\s*\|+\s*/, "");
}

/** 先剥前缀再剥一次，`do n=$(find …)` 这类嵌套也能还原。 */
function substitute(statement: string): string {
  return substitutedAssignment(statement) ?? statement;
}

/** `html=$(curl ...)`：赋值里的命令替换才是真正在跑的东西。 */
function substitutedAssignment(statement: string): string | undefined {
  const match = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"|')?\$\(([\s\S]*)\)(?:"|')?$/.exec(statement.trim());
  return match?.[1]?.trim();
}

/** `$html = (Invoke-WebRequest ...).Content` 里真正跑的只有右边；纯数据赋值整条丢掉。 */
function unwrapPowerShellAssignment(statement: string): string | undefined {
  const match = /^\$(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/.exec(statement.trim());
  if (match === null) return statement;
  const value = match[2]?.trim() ?? "";
  if (value.startsWith("@'") || value.startsWith('@"')) return undefined;
  if (!looksLikeCommand(value)) return undefined;
  return unwrapPropertyAccess(value);
}

const CommandRun = /^(?:[A-Z][a-z]+-[A-Z][A-Za-z]+)$/;

function looksLikeCommand(value: string): boolean {
  const trimmed = value.trim();
  // `& 'D:/tools/bz.exe' l …`、`& $aapt dump badging`：带调用符就是命令。
  if (trimmed.startsWith("&")) return true;
  // `'C:/…/x.exe' -flag`：引号路径或字符串后面还带参数才算命令；单独一个就是数据。
  if (/^['"]/.test(trimmed)) return /\s/.test(trimmed.replace(/^(['"])[\s\S]*?\1/, "").trim());
  const head = trimmed.replace(/^[([&]+/u, "").trim();
  const name = head.split(/\s+/)[0] ?? "";
  // `$aapt dump badging $apk`：变量当命令名，还原后才知道跑什么。
  if (name.startsWith("$") || name.includes("/") || name.includes("\\")) return true;
  if (CommandRun.test(name)) return true;
  return /^(?:node|npm|pnpm|npx|yarn|bun|deno|git|rg|grep|curl|wget|python3?|python|bash|sh|pwsh|powershell|docker|kubectl|tsc|vite)$/.test(baseName(name));
}

/** `(Invoke-WebRequest ...).Content` → `Invoke-WebRequest ...` */
function unwrapPropertyAccess(value: string): string {
  const paren = /^\(([\s\S]*)\)(?:\.[A-Za-z_][\w.]*)?$/.exec(value.trim());
  return paren?.[1]?.trim() ?? value.trim();
}

/** `(Get-FileHash $apk).Hash | Set-Content $a` → `Get-FileHash $apk | Set-Content $a` */
function stripLeadingParens(statement: string): string {
  const end = matchingParen(statement, 0);
  if (end === undefined) return statement;
  const inner = statement.slice(1, end).trim();
  if (!CommandRun.test(inner.split(/\s+/)[0] ?? "")) return statement;
  const rest = statement.slice(end + 1).trim().replace(/^(?:\.[A-Za-z_][\w.]*)/, "").trim();
  return rest === "" ? inner : `${inner} ${rest}`;
}

function parensBalanced(text: string): boolean {
  let depth = 0;
  for (const char of text) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
  }
  return depth === 0;
}

function matchingParen(text: string, start: number): number | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function stripPrefixes(statement: string): string {
  let text = statement.trim();
  for (let guard = 0; guard < 12; guard += 1) {
    const assignment = PREFIX_ASSIGNMENT.exec(text);
    if (assignment !== null && parensBalanced(assignment[0])) {
      text = text.slice(assignment[0].length).trim();
      continue;
    }
    if (assignment !== null) return text;
    const [token] = text.split(/\s+/);
    if (token === undefined) return "";
    if (WRAPPERS.has(token) && text.length > token.length) {
      text = text.slice(token.length).trim();
      continue;
    }
    return text;
  }
  return text;
}

function expandVariables(statement: string, variables: Map<string, string>): string {
  if (variables.size === 0) return statement;
  return statement.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced: string | undefined, plain: string | undefined) => variables.get(braced ?? plain ?? "") ?? match);
}

/** PowerShell 的 `&` 调用符和"长引号路径当命令"都还原成真正的命令名。 */
function normalizeHead(statement: string): string {
  let text = statement.trim();
  if (text.startsWith("& ")) text = text.slice(2).trim();
  const match = QUOTED_HEAD.exec(text);
  if (match !== null) {
    const path = match[2];
    if (path === undefined) return text;
    return `${baseName(path)}${text.slice(match[0].length)}`;
  }
  // 变量还原后命令名可能变成完整路径：`C:/tools/aapt2.exe dump badging`
  const head = text.split(/\s+/)[0] ?? "";
  if (!/[/\\]/.test(head) || head.includes("=")) return text;
  return `${baseName(head)}${text.slice(head.length)}`;
}

function isNoise(statement: string): boolean {
  // 整条就是一个字符串字面量：`if (…) { "bz ok" }` 里的分支，不是命令。
  if (/^(['"])[\s\S]*\1$/.test(statement)) return true;
  const [head] = statement.split(/\s+/);
  if (head === undefined) return true;
  const name = head.replace(/^["']|["']$/g, "");
  return NOISE_HEADS.has(name) || NOISE_HEADS.has(name.replace(/;$/, ""));
}

/** 去掉 `>out`、`2>&1`、`>> log` 这类重定向，命令本身不变。 */
function stripRedirections(statement: string): string {
  return statement
    .replace(/\s*\d?&>>?\s*(?:"[^"]*"|'[^']*'|\S+)/g, "")
    .replace(/\s*\d?>>?\s*(?:"[^"]*"|'[^']*'|\S+)/g, "")
    .replace(/\s*\d?>&\d?/g, "")
    .trim();
}

/** 很长的路径只留末三段：`…/sites/preview/index/h5`。命令本身不动。 */
function shortenPaths(statement: string): string {
  const [head = ""] = statement.split(/\s+/);
  const tail = statement.slice(head.length);
  return head + tail.replace(LONG_PATH, (match: string, prefix: string, path: string) => {
    if (path.includes("://") || path.length <= 44) return match;
    const segments = path.split(/[/\\]/).filter((segment) => segment !== "");
    if (segments.length < 4) return match;
    const shortened = segments.slice(-3).join("/");
    return `${prefix}…/${shortened}`;
  });
}

/** 内联脚本和纯变量展开的参数只留省略号。 */
function collapseCodeArguments(statement: string): string {
  let text = statement
    .replace(UNCLOSED_SUBSTITUTION, (_match: string, quote: string) => `${quote}…${quote}`)
    .replace(SUBSTITUTION_ARG, (_match: string, quote: string) => `${quote}…${quote}`)
    .replace(CODE_ARG, (match: string, quote: string, body: string) => (isCode(body) ? `${quote}…${quote}` : match));
  if (SCRIPT_RUNNERS.has(baseName(text.split(/\s+/)[0] ?? ""))) {
    text = text.replace(EVAL_FLAG_ARG, (_match: string, prefix: string, quote: string) => `${prefix}${quote}…${quote}`);
  }
  return text;
}

/** 内联脚本的长参数：带换行，或带语句分隔符/箭头/大括号。 */
function isCode(body: string): boolean {
  if (body.includes("\n")) return true;
  if (body.length < 81) return false;
  return /[;{}]|=>|\b(?:import|const|let|await|function|return|print)\b/.test(body);
}

/** `foreach (...) { ... }` 这类块本身不是命令，里面的语句才是。 */
function isControlBlock(statement: string): boolean {
  const [head] = statement.split(/\s+/);
  if (head === undefined) return false;
  return CONTROL_HEADS.has(head.replace(/^["']|["']$/g, ""));
}

function blockBody(statement: string): string | undefined {
  const start = statement.indexOf("{");
  if (start < 0) return undefined;
  const end = matchingBrace(statement, start);
  if (end === undefined) return undefined;
  const body = statement.slice(start + 1, end).trim();
  return body === "" ? undefined : body;
}

function matchingBrace(text: string, start: number): number | undefined {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function baseName(token: string): string {
  const trimmed = token.replace(/^["']|["']$/g, "");
  const segments = trimmed.split(/[/\\]/).filter((segment) => segment !== "");
  return (segments.at(-1) ?? trimmed).replace(/\.(?:cmd|exe|bat|ps1|psm1)$/i, "");
}
