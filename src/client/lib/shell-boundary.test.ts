import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 桌面壳边界守卫：桌面壳专用的能力只能出现在能力层，组件不许自己调 Tauri。
 * 这套规则是「新功能不会再踩同一个坑」的机械保证，不靠记性。
 */

const REPO_ROOT = process.cwd();
const CLIENT_ROOT = join(REPO_ROOT, "src", "client");
const TAURI_ALLOWLIST = new Set([
  "src/client/desktop.ts",
  "src/client/lib/composer-drop-desktop.ts",
  "src/client/lib/desktop-updater.ts",
  "src/client/components/update-prompt.tsx",
]);
const WINDOW_OPEN_ALLOWLIST = new Set(["src/client/desktop.ts"]);

function sourceFiles(dir: string = CLIENT_ROOT): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
      continue;
    }
    if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
    if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) continue;
    files.push(path);
  }
  return files;
}

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("桌面壳边界", () => {
  it("只有能力层可以引用 @tauri-apps", () => {
    const offenders = sourceFiles()
      .map((path) => path.slice(REPO_ROOT.length + 1).replaceAll("\\", "/"))
      .filter((path) => !TAURI_ALLOWLIST.has(path) && read(path).includes("@tauri-apps"));
    expect(offenders).toEqual([]);
  });

  it("只有 desktop.ts 可以调用 window.open", () => {
    const offenders = sourceFiles()
      .map((path) => path.slice(REPO_ROOT.length + 1).replaceAll("\\", "/"))
      .filter((path) => !WINDOW_OPEN_ALLOWLIST.has(path) && read(path).includes("window.open("));
    expect(offenders).toEqual([]);
  });
});

describe("桌面壳配置与命令", () => {
  it("窗口必须在 Rust 里创建（配置里不能再出现 app.windows）", () => {
    const config = JSON.parse(read("src-tauri/tauri.conf.json")) as { app?: { windows?: unknown[] } };
    expect(config.app?.windows).toBeUndefined();
  });

  it("注册的命令与权限声明一一对应", () => {
    const registered = [...read("src-tauri/src/lib.rs").matchAll(/generate_handler!\[([\s\S]*?)\]/g)]
      .flatMap((match) => match[1]!.split(","))
      .map((name) => name.trim().replace(/^update::/, ""))
      .filter((name) => name !== "");

    const defined = new Set([...read("src-tauri/src/lib.rs").matchAll(/#\[tauri::command\][\s\S]{0,80}?fn (\w+)/g)].map((match) => match[1]!));
    for (const name of [...read("src-tauri/src/update.rs").matchAll(/#\[tauri::command\][\s\S]{0,80}?fn (\w+)/g)]) defined.add(name[1]!);

    const allowed = new Set(
      [...read("src-tauri/permissions/desktop.toml").matchAll(/commands\.allow = \[([^\]]*)\]/g)]
        .flatMap((match) => match[1]!.split(","))
        .map((name) => name.trim().replaceAll('"', ""))
        .filter((name) => name !== ""),
    );

    const capabilities = JSON.parse(read("src-tauri/capabilities/default.json")) as { permissions: string[] };
    const custom = capabilities.permissions.filter((name) => !name.includes(":"));
    const declared = new Set([...read("src-tauri/permissions/desktop.toml").matchAll(/identifier = "([^"]+)"/g)].map((match) => match[1]!));

    expect([...registered].sort()).toEqual([...defined].sort());
    expect([...registered].sort()).toEqual([...allowed].sort());
    expect(custom.filter((name) => !declared.has(name))).toEqual([]);
  });
});
