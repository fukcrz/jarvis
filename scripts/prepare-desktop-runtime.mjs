import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staging = join(root, "src-tauri", "runtime-staging");
const dist = join(root, "dist");

if (!existsSync(join(dist, "server", "server", "index.js")) || !existsSync(join(dist, "client", "index.html"))) {
  throw new Error("请先执行 npm run build");
}

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
writeFileSync(join(staging, ".gitkeep"), "");
cpSync(dist, join(staging, "dist"), { recursive: true });
cpSync(join(root, "package.json"), join(staging, "package.json"));
cpSync(join(root, "package-lock.json"), join(staging, "package-lock.json"));
cpSync(join(root, "scripts"), join(staging, "scripts"), { recursive: true });
cpSync(join(root, "plugins"), join(staging, "plugins"), { recursive: true });
cpSync(join(root, "skills"), join(staging, "skills"), { recursive: true });
if (existsSync(join(root, "vendor"))) cpSync(join(root, "vendor"), join(staging, "vendor"), { recursive: true });

const install = spawnSync("npm", ["ci", "--omit=dev"], {
  cwd: staging,
  stdio: process.platform === "win32" ? ["ignore", "pipe", "pipe"] : "inherit",
  maxBuffer: 64 * 1024 * 1024,
  windowsHide: true,
  shell: process.platform === "win32",
  env: { ...process.env, NODE_ENV: "production" },
});
if (process.platform === "win32") {
  if (install.stdout) process.stdout.write(install.stdout);
  if (install.stderr) process.stderr.write(install.stderr);
}
if (install.status !== 0) {
  throw new Error("desktop runtime npm ci --omit=dev 失败");
}

// 本地路径插件不会由 Pi 安装依赖，必须随运行时自包含，否则装完插件加载就报缺模块。
for (const entry of readdirSync(join(staging, "plugins"))) {
  const pluginDir = join(staging, "plugins", entry);
  if (!existsSync(join(pluginDir, "package.json"))) continue;
  const args = existsSync(join(pluginDir, "package-lock.json"))
    ? ["ci", "--omit=dev"]
    : ["install", "--omit=dev", "--no-package-lock"];
  const pluginInstall = spawnSync("npm", args, {
    cwd: pluginDir,
    stdio: process.platform === "win32" ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    shell: process.platform === "win32",
    env: { ...process.env, NODE_ENV: "production" },
  });
  if (process.platform === "win32") {
    if (pluginInstall.stdout) process.stdout.write(pluginInstall.stdout);
    if (pluginInstall.stderr) process.stderr.write(pluginInstall.stderr);
  }
  if (pluginInstall.status !== 0) throw new Error(`插件依赖安装失败：${entry}`);
  console.log(`plugin dependencies installed: ${entry}`);
}

console.log(`desktop runtime staged at ${staging}`);
