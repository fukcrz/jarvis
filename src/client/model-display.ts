export function displayModelName(name: string): string {
  const compact = name.replace(/\s+\([^()]+\)\s*$/, "").trim();
  return compact === "" ? name : compact;
}
