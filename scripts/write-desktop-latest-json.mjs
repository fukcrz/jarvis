// 发版时生成更新清单：正式版 latest.json（releases/latest 下）、测试版 beta.json（updater-beta Release 下）。
// 结果通过 GITHUB_OUTPUT 告诉工作流：prerelease / write_latest / write_beta。
// 本地试跑：JARVIS_NSIS_DIR=<含 exe 和 .sig 的目录> JARVIS_CURRENT_BETA=0.1.27 node scripts/write-desktop-latest-json.mjs
import { appendFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BETA_MANIFEST_URL, buildManifest, parseVersion, planManifests } from "./desktop-release.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
parseVersion(version);
const tag = process.env["GITHUB_REF_NAME"];
if (tag !== undefined && tag !== "" && tag !== `v${version}`) {
  throw new Error(`标签 ${tag} 与 package.json 版本 ${version} 不一致`);
}

const nsis = process.env["JARVIS_NSIS_DIR"] ?? join(root, "src-tauri", "target", "release", "bundle", "nsis");
const exe = readdirSync(nsis).find((name) => name.endsWith(".exe") && !name.toLowerCase().includes("uninstall"));
if (!exe) {
  throw new Error(`找不到 NSIS 安装包：${nsis}`);
}
const signature = readFileSync(join(nsis, `${exe}.sig`), "utf8").trim();
if (!signature) {
  throw new Error(`签名文件为空：${exe}.sig`);
}

/** 当前测试版清单里的版本；还没有清单（首次）时返回 undefined。 */
async function currentBetaVersion() {
  const override = process.env["JARVIS_CURRENT_BETA"];
  if (override !== undefined) return override === "" ? undefined : override;
  const response = await fetch(BETA_MANIFEST_URL, { redirect: "follow" });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`读取当前测试版清单失败：HTTP ${String(response.status)}`);
  const manifest = await response.json();
  return typeof manifest.version === "string" ? manifest.version : undefined;
}

const current = await currentBetaVersion();
const plan = planManifests(version, current);
const manifest = `${JSON.stringify(buildManifest({ version, exe, signature }), null, 2)}\n`;
for (const [name, wanted] of [["latest.json", plan.latest], ["beta.json", plan.beta]]) {
  const out = join(nsis, name);
  rmSync(out, { force: true });
  if (!wanted) continue;
  writeFileSync(out, manifest);
  console.log(`wrote ${out}`);
}
if (!plan.beta) console.log(`测试版清单已是 ${String(current)}，高于 ${version}，保持不变`);

const output = process.env["GITHUB_OUTPUT"];
if (output) {
  appendFileSync(output, `prerelease=${String(plan.prerelease)}\nwrite_latest=${String(plan.latest)}\nwrite_beta=${String(plan.beta)}\n`);
}
