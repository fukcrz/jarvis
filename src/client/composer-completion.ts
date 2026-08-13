import type { ComposerCommand } from "../shared/protocol";

export const MAX_COMPOSER_SUGGESTIONS = 8;

export interface ComposerCompletionContext {
  trigger: "/" | "@" | "@@";
  query: string;
  from: number;
  to: number;
}

export interface CompletionReplacement {
  from: number;
  to: number;
  insert: string;
  cursor: number;
}

export function completionContextFor(value: string, cursor: number): ComposerCompletionContext | undefined {
  const position = Math.max(0, Math.min(cursor, value.length));
  const firstNonWhitespace = value.search(/\S/);
  if (firstNonWhitespace !== -1 && value[firstNonWhitespace] === "/") {
    const from = firstNonWhitespace;
    const to = tokenEnd(value, from + 1);
    if (position > from && position <= to) {
      return { trigger: "/", query: value.slice(from + 1, position), from, to };
    }
  }

  let from = position;
  while (from > 0 && !/\s/.test(value[from - 1] ?? "")) from -= 1;
  if (value[from] !== "@") return undefined;
  const isSessionReference = value[from + 1] === "@";
  const queryStart = from + (isSessionReference ? 2 : 1);
  const to = tokenEnd(value, queryStart);
  if (position < queryStart || position > to) return undefined;
  return { trigger: isSessionReference ? "@@" : "@", query: value.slice(queryStart, position), from, to };
}

export function matchingComposerCommands(commands: readonly ComposerCommand[], query: string): ComposerCommand[] {
  const normalized = query.toLocaleLowerCase();
  return commands
    .filter((command) => command.name.toLocaleLowerCase().includes(normalized) || command.description?.toLocaleLowerCase().includes(normalized))
    .slice(0, MAX_COMPOSER_SUGGESTIONS);
}

export function completionReplacement(value: string, context: ComposerCompletionContext, replacement: string): CompletionReplacement {
  const hasDelimiter = /\s/.test(value.slice(context.to, context.to + 1));
  const insert = hasDelimiter ? replacement : `${replacement} `;
  return {
    from: context.from,
    to: context.to,
    insert,
    cursor: context.from + insert.length + (hasDelimiter ? 1 : 0),
  };
}

function tokenEnd(value: string, from: number): number {
  let to = from;
  while (to < value.length && !/\s/.test(value[to] ?? "")) to += 1;
  return to;
}
