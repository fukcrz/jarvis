import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const nsis = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const exe = readdirSync(nsis).find((name) => name.endsWith(".exe") && !name.toLowerCase().includes("uninstall"));
if (!exe) {
  throw new Error(`找不到 NSIS 安装包：${nsis}`);
}
const signature = readFileSync(join(nsis, `${exe}.sig`), "utf8").trim();
if (!signature) {
  throw new Error(`签名文件为空：${exe}.sig`);
}
const manifest = {
  version,
  notes: `Jarvis ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `https://github.com/fukcrz/jarvis/releases/download/v${version}/${exe}`,
    },
  },
};
const out = join(nsis, "latest.json");
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${out}`);
