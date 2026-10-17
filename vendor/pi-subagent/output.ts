import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateLine,
} from "@earendil-works/pi-coding-agent";
import { getResultSummaryText } from "./runner-events.js";
import { type SingleResult, isResultError, isResultSuccess } from "./types.js";

export type SaveFullOutput = (content: string) => string | null;

export interface FormattedCallsSummary {
  text: string;
  truncated: boolean;
  fullOutputPath: string | null;
}

export interface OutputArtifact {
  dir: string;
  filePath: string;
}

export function writeOutputArtifact(content: string): OutputArtifact {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-output-"));
  const filePath = path.join(dir, "subagent-output.md");
  try {
    fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
    return { dir, filePath };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatResultLabel(result: SingleResult, fallbackIndex: number): string {
  const displayIndex = (result.callIndex ?? fallbackIndex) + 1;
  const sessionText = result.session ? ` session=${oneLine(result.session.handle)}` : "";
  return `${displayIndex}: ${result.agent}${sessionText}`;
}

function formatCompactResultLabel(result: SingleResult, fallbackIndex: number): string {
  return truncateLine(formatResultLabel(result, fallbackIndex), 180).text;
}

function resultStatus(result: SingleResult): "completed" | "failed" {
  return isResultError(result) ? "failed" : "completed";
}

export function formatFullCallsSummary(results: SingleResult[]): string {
  const successCount = results.filter((result) => isResultSuccess(result)).length;
  const summaries = results.map((result, index) =>
    `[${formatResultLabel(result, index)}] ${resultStatus(result)}:\n${getResultSummaryText(result)}`
  );
  return `${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`;
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\r\n?/g, "\n").split("\n").length;
}

function buildBoundedSummary(
  results: SingleResult[],
  fullOutputPath: string | null,
): string {
  const successCount = results.filter((result) => isResultSuccess(result)).length;
  const statuses = results.map(
    (result, index) => `- [${formatCompactResultLabel(result, index)}] ${resultStatus(result)}`,
  );
  const artifactText = fullOutputPath
    ? `Full output saved to: ${fullOutputPath}`
    : "Full output is preserved in tool details.";
  const prelude = [
    `${successCount}/${results.length} succeeded`,
    "",
    `[Output truncated to ${formatSize(DEFAULT_MAX_BYTES)} or ${DEFAULT_MAX_LINES} lines. ${artifactText}]`,
    "",
    "Results:",
    ...statuses,
  ].join("\n");

  const marker = "[output truncated]";
  const sectionHeaders = results.map(
    (result, index) => `\n\n[${formatCompactResultLabel(result, index)}] ${resultStatus(result)}:\n`,
  );
  const fixedText = prelude + sectionHeaders.map((header) => `${header}${marker}`).join("");
  const availableBytes = Math.max(0, DEFAULT_MAX_BYTES - Buffer.byteLength(fixedText, "utf8"));
  const availableLines = Math.max(0, DEFAULT_MAX_LINES - countLines(fixedText));
  const perResultBytes = Math.max(1, Math.floor(availableBytes / Math.max(1, results.length)));
  const perResultLines = Math.max(1, Math.floor(availableLines / Math.max(1, results.length)));

  const sections = results.map((result, index) => {
    const body = getResultSummaryText(result);
    const truncation = truncateHead(body, {
      maxBytes: perResultBytes,
      maxLines: perResultLines,
    });
    const suffix = truncation.truncated ? `${truncation.content ? "\n" : ""}${marker}` : "";
    return `${sectionHeaders[index]}${truncation.content}${suffix}`;
  });

  return prelude + sections.join("");
}

export function formatCallsSummary(
  results: SingleResult[],
  saveFullOutput: SaveFullOutput,
): FormattedCallsSummary {
  const fullText = formatFullCallsSummary(results);
  if (!truncateHead(fullText).truncated) {
    return { text: fullText, truncated: false, fullOutputPath: null };
  }

  const fullOutputPath = saveFullOutput(fullText);
  const text = buildBoundedSummary(results, fullOutputPath);
  const finalCheck = truncateHead(text);
  if (finalCheck.truncated) {
    throw new Error("Internal error: bounded subagent summary exceeded Pi output limits.");
  }

  return { text, truncated: true, fullOutputPath };
}
