// 统一改版本号：package.json、package-lock.json、src-tauri/Cargo.toml、src-tauri/Cargo.lock。
// 用法：node scripts/bump-version.mjs 0.1.28-beta.1   （正式版：node scripts/bump-version.mjs 0.1.28）
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVersion } from "./desktop-release.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const next = process.argv[2]?.replace(/^v/, "");
if (next === undefined) throw new Error("用法：node scripts/bump-version.mjs <版本号>，例如 0.1.28-beta.1");
parseVersion(next);

const pkgPath = join(root, "package.json");
const current = JSON.parse(readFileSync(pkgPath, "utf8")).version;

function replaceOnce(file, pattern, replacement, count = 1) {
  const path = join(root, file);
  const text = readFileSync(path, "utf8");
  let hits = 0;
  const updated = text.replace(pattern, (...match) => {
    hits += 1;
    return hits <= count ? replacement(...match) : match[0];
  });
  if (hits < count) throw new Error(`${file} 里没找到当前版本 ${current}`);
  writeFileSync(path, updated);
}

const escaped = current.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
replaceOnce("package.json", new RegExp(`("version": ")${escaped}(")`), (_m, a, b) => `${a}${next}${b}`);
replaceOnce("package-lock.json", new RegExp(`("name": "jarvis",\\s*"version": ")${escaped}(")`, "g"), (_m, a, b) => `${a}${next}${b}`, 2);
replaceOnce("src-tauri/Cargo.toml", new RegExp(`^(version = ")${escaped}(")`, "m"), (_m, a, b) => `${a}${next}${b}`);
replaceOnce("src-tauri/Cargo.lock", new RegExp(`(name = "jarvis-desktop"\\nversion = ")${escaped}(")`), (_m, a, b) => `${a}${next}${b}`);
console.log(`${current} → ${next}`);
