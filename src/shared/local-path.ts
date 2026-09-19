/**
 * 模型常把 Windows 盘符路径写成 Unix 根路径（`/D:/foo`、`//D:\foo`）。
 * 这种写法在 Windows 上不能直接给 Node 用，这里只剥多余的根斜杠，Unix 路径不动。
 */
const WINDOWS_DRIVE_WITH_UNIX_ROOT = /^[\\/]+([a-zA-Z]:[\\/].*)$/;

/** 去掉包在引号或 <> 里的路径外壳。 */
export function unwrapPathDelimiters(value: string): string {
  let current = value.trim();
  for (let i = 0; i < 3; i += 1) {
    if (current.length < 2) break;
    const start = current[0];
    const end = current[current.length - 1];
    if (start === undefined || end === undefined) break;
    if ((start === "\"" && end === "\"") || (start === "'" && end === "'") || (start === "<" && end === ">")) {
      current = current.slice(1, -1).trim();
      continue;
    }
    break;
  }
  return current;
}

/** `/D:/foo`、`//D:\foo` → `D:/foo` / `D:\foo`。 */
export function stripRedundantRootBeforeWindowsDrive(path: string): string {
  return WINDOWS_DRIVE_WITH_UNIX_ROOT.exec(path)?.[1] ?? path;
}

/** 去掉引号/尖括号，并剥掉盘符前多余的 Unix 根斜杠。 */
export function canonicalizeLocalPathInput(value: string): string {
  return stripRedundantRootBeforeWindowsDrive(unwrapPathDelimiters(value));
}
