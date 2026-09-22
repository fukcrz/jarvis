import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
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
cpSync(dist, join(staging, "dist"), { recursive: true });
cpSync(join(root, "package.json"), join(staging, "package.json"));
cpSync(join(root, "package-lock.json"), join(staging, "package-lock.json"));
cpSync(join(root, "scripts"), join(staging, "scripts"), { recursive: true });

const install = spawnSync("npm", ["ci", "--omit=dev"], {
  cwd: staging,
  stdio: "inherit",
  windowsHide: true,
  shell: process.platform === "win32",
  env: { ...process.env, NODE_ENV: "production" },
});
if (install.status !== 0) {
  throw new Error("desktop runtime npm ci --omit=dev 失败");
}

console.log(`desktop runtime staged at ${staging}`);
