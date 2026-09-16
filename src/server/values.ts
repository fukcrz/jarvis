export { isRecord } from "../shared/protocol.js";

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function toIso(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}
