import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const codingAgentRoot = join(root, "node_modules/@earendil-works/pi-coding-agent");
const piAiTypePaths = [
  join(root, "node_modules/@earendil-works/pi-ai/dist/types.d.ts"),
  join(codingAgentRoot, "node_modules/@earendil-works/pi-ai/dist/types.d.ts"),
].filter(existsSync);

async function replaceOnce(path, before, after) {
  const source = await readFile(path, "utf8");
  if (source.includes(after)) return;
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`Expected one patch target in ${path}, found ${count}`);
  await writeFile(path, source.replace(before, after), "utf8");
}

async function replaceAllExact(path, before, after, expectedCount) {
  const source = await readFile(path, "utf8");
  const beforeCount = source.split(before).length - 1;
  const afterCount = source.split(after).length - 1;
  if (beforeCount === 0 && afterCount === expectedCount) return;
  if (beforeCount !== expectedCount || afterCount !== 0) {
    throw new Error(`Expected ${expectedCount} unpatched targets in ${path}, found ${beforeCount} unpatched and ${afterCount} patched`);
  }
  await writeFile(path, source.replaceAll(before, after), "utf8");
}

async function replaceOneOf(path, replacements) {
  const source = await readFile(path, "utf8");
  if (replacements.some(({ after }) => source.includes(after))) return;
  const matches = replacements.filter(({ before }) => source.split(before).length - 1 === 1);
  if (matches.length === 0) throw new Error(`Expected one patch target in ${path}, found 0`);
  const longestLength = Math.max(...matches.map(({ before }) => before.length));
  const specificMatches = matches.filter(({ before }) => before.length === longestLength);
  if (specificMatches.length !== 1) throw new Error(`Expected one patch target in ${path}, found ${specificMatches.length}`);
  const [{ before, after }] = specificMatches;
  await writeFile(path, source.replace(before, after), "utf8");
}

for (const piAiTypes of piAiTypePaths) {
  await replaceOneOf(piAiTypes, [
    {
      before: "export interface SimpleStreamOptions extends StreamOptions {\n    reasoning?: ThinkingLevel;",
      after: "export interface SimpleStreamOptions extends StreamOptions {\n    /** Stable source session ID for local request routing. Unlike sessionId, this is not replaced for standalone summaries. */\n    ownerSessionId?: string;\n    reasoning?: ThinkingLevel;",
    },
    {
      before: "export interface SimpleStreamOptions extends StreamOptions {\n    /** Provider-neutral tool selection for simple requests. Default: \"auto\". */",
      after: "export interface SimpleStreamOptions extends StreamOptions {\n    /** Stable source session ID for local request routing. Unlike sessionId, this is not replaced for standalone summaries. */\n    ownerSessionId?: string;\n    /** Provider-neutral tool selection for simple requests. Default: \"auto\". */",
    },
    {
      before: "export interface SimpleStreamOptions extends StreamOptions {\n    /** Provider-neutral tool selection for simple requests. Default: \"auto\". */\n    toolChoice?: ToolChoice;",
      after: "export interface SimpleStreamOptions extends StreamOptions {\n    /** Stable source session ID for local request routing. Unlike sessionId, this is not replaced for standalone summaries. */\n    ownerSessionId?: string;\n    /** Provider-neutral tool selection for simple requests. Default: \"auto\". */\n    toolChoice?: ToolChoice;",
    },
    {
      before: "export interface SimpleStreamOptions extends StreamOptions {\n    /** Provider-neutral tool selection for simple requests. When omitted, adapters use provider-specific behavior. */",
      after: "export interface SimpleStreamOptions extends StreamOptions {\n    /** Stable source session ID for local request routing. Unlike sessionId, this is not replaced for standalone summaries. */\n    ownerSessionId?: string;\n    /** Provider-neutral tool selection for simple requests. When omitted, adapters use provider-specific behavior. */",
    },
    {
      before: "export interface SimpleStreamOptions extends StreamOptions {\n    /** Provider-neutral tool selection for simple requests. When omitted, adapters use provider-specific behavior. */\n    toolChoice?: ToolChoice;",
      after: "export interface SimpleStreamOptions extends StreamOptions {\n    /** Stable source session ID for local request routing. Unlike sessionId, this is not replaced for standalone summaries. */\n    ownerSessionId?: string;\n    /** Provider-neutral tool selection for simple requests. When omitted, adapters use provider-specific behavior. */\n    toolChoice?: ToolChoice;",
    },
  ]);
}

await replaceOnce(
  join(root, "node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js"),
  "            return modelRuntime.streamSimple(model, context, {\n                ...options,\n                timeoutMs,",
  "            return modelRuntime.streamSimple(model, context, {\n                ...options,\n                // Keep local provider routing tied to this AgentSession even when compaction\n                // replaces sessionId with an isolated UUID for cache/request affinity.\n                ownerSessionId: sessionManager.getSessionId(),\n                timeoutMs,",
);

const codingAgentDist = join(codingAgentRoot, "dist/core");
const codingAgentUtils = join(codingAgentRoot, "dist/utils");
const piTuiDist = join(root, "node_modules/@earendil-works/pi-tui/dist");

// Pi's Windows cross-spawn path can bypass the server's node:child_process exports.
await replaceOnce(
  join(codingAgentUtils, "child-process.js"),
  'return process.platform === "win32" ? crossSpawn(command, args, options) : nodeSpawn(command, args, options);',
  'return process.platform === "win32" ? crossSpawn(command, args, { ...options, windowsHide: true }) : nodeSpawn(command, args, options);',
);
await replaceOnce(
  join(codingAgentUtils, "child-process.js"),
  '? crossSpawn.sync(command, args, options)',
  '? crossSpawn.sync(command, args, { ...options, windowsHide: true })',
);
await replaceOnce(
  join(codingAgentDist, "resolve-config-value.js"),
  '            stdio: ["ignore", "pipe", "ignore"],\n        });\n        return output.trim()',
  '            stdio: ["ignore", "pipe", "ignore"],\n            windowsHide: true,\n        });\n        return output.trim()',
);
await replaceOnce(
  join(codingAgentUtils, "tools-manager.js"),
  '    const result = spawnSync(command, args, { stdio: "pipe" });',
  '    const result = spawnSync(command, args, { stdio: "pipe", windowsHide: true });',
);
await replaceOnce(
  join(codingAgentUtils, "clipboard.js"),
  'const options = { input: text, timeout: 5000, stdio: ["pipe", "ignore", "ignore"] };',
  'const options = { input: text, timeout: 5000, stdio: ["pipe", "ignore", "ignore"], windowsHide: true };',
);
await replaceOnce(
  join(codingAgentUtils, "open-browser.js"),
  'spawn(cmd, args, { stdio: "ignore", detached: true })',
  'spawn(cmd, args, { stdio: "ignore", detached: process.platform !== "win32", windowsHide: true })',
);
await replaceOnce(
  join(codingAgentUtils, "shell.js"),
  '                stdio: "ignore",\n                detached: true,\n                windowsHide: true,',
  '                stdio: "ignore",\n                detached: false,\n                windowsHide: true,',
);
await replaceOnce(
  join(codingAgentRoot, "dist/modes/interactive/external-editor.js"),
  '                stdio: "inherit",\n                shell: process.platform === "win32",',
  '                stdio: "inherit",\n                shell: process.platform === "win32",\n                windowsHide: true,',
);
await replaceOnce(
  join(codingAgentRoot, "dist/modes/interactive/session-share.js"),
  'spawnSync("gh", ["auth", "status"], { encoding: "utf-8" })',
  'spawnSync("gh", ["auth", "status"], { encoding: "utf-8", windowsHide: true })',
);
await replaceOnce(
  join(codingAgentRoot, "dist/modes/interactive/session-share.js"),
  'spawn("gh", ["gist", "create", "--public=false", tmpFile])',
  'spawn("gh", ["gist", "create", "--public=false", tmpFile], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })',
);
if (existsSync(piTuiDist)) {
  await replaceOnce(join(piTuiDist, "autocomplete.js"),
    '            stdio: ["ignore", "pipe", "pipe"],',
    '            stdio: ["ignore", "pipe", "pipe"],\n            windowsHide: true,');
  await replaceOnce(join(piTuiDist, "terminal-image.js"),
    '            timeout: 250,\n            stdio: ["ignore", "pipe", "ignore"],',
    '            timeout: 250,\n            stdio: ["ignore", "pipe", "ignore"],\n            windowsHide: true,');
}
await replaceOnce(
  join(codingAgentRoot, "dist/modes/rpc/rpc-client.js"),
  '            stdio: ["pipe", "pipe", "pipe"],\n        });',
  '            stdio: ["pipe", "pipe", "pipe"],\n            windowsHide: true,\n        });',
);
await replaceOnce(
  join(codingAgentRoot, "dist/modes/interactive/components/session-selector.js"),
  'spawnSync("trash", trashArgs, { encoding: "utf-8" })',
  'spawnSync("trash", trashArgs, { encoding: "utf-8", windowsHide: true })',
);
await replaceOnce(
  join(codingAgentRoot, "dist/modes/interactive/interactive-mode.js"),
  '                    stdio: ["ignore", "pipe", "ignore"],',
  '                    stdio: ["ignore", "pipe", "ignore"],\n                    windowsHide: true,',
);

// The SDK's primary Bash runner already hides its console. Cover its other
// automatic child-process paths too, including extension pi.exec and the
// built-in grep/find tools.
await replaceOnce(
  join(codingAgentDist, "exec.js"),
  "            shell: false,\n            stdio: [\"ignore\", \"pipe\", \"pipe\"],\n        });",
  "            shell: false,\n            stdio: [\"ignore\", \"pipe\", \"pipe\"],\n            windowsHide: true,\n        });",
);

await replaceOnce(
  join(codingAgentDist, "tools", "grep.js"),
  "const child = spawn(rgPath, args, { stdio: [\"ignore\", \"pipe\", \"pipe\"] });",
  "const child = spawn(rgPath, args, { stdio: [\"ignore\", \"pipe\", \"pipe\"], windowsHide: true });",
);

await replaceOnce(
  join(codingAgentDist, "tools", "find.js"),
  "const child = spawn(fdPath, args, { stdio: [\"ignore\", \"pipe\", \"pipe\"] });",
  "const child = spawn(fdPath, args, { stdio: [\"ignore\", \"pipe\", \"pipe\"], windowsHide: true });",
);

// SDK 会话初始化路径也会触发控制台子进程（无控制台的 node 服务端下会闪窗）：
// - 会话加载时查 git 分支（resource-loader -> footer-data-provider）
// - grep/find 工具激活时检查命令版本（tools-manager）
// - Unix 分支的 which 检查（Windows 走 where，顺带修掉）
await replaceOnce(
  join(codingAgentDist, "../core/footer-data-provider.js"),
  "    const result = spawnSync(\"git\", [\"--no-optional-locks\", \"symbolic-ref\", \"--quiet\", \"--short\", \"HEAD\"], {\n        cwd: repoDir,\n        encoding: \"utf8\",\n        stdio: [\"ignore\", \"pipe\", \"ignore\"],\n    });",
  "    const result = spawnSync(\"git\", [\"--no-optional-locks\", \"symbolic-ref\", \"--quiet\", \"--short\", \"HEAD\"], {\n        cwd: repoDir,\n        encoding: \"utf8\",\n        stdio: [\"ignore\", \"pipe\", \"ignore\"],\n        windowsHide: true,\n    });",
);

await replaceOnce(
  join(codingAgentDist, "../core/footer-data-provider.js"),
  "        execFile(\"git\", [\"--no-optional-locks\", \"symbolic-ref\", \"--quiet\", \"--short\", \"HEAD\"], {\n            cwd: repoDir,\n            encoding: \"utf8\",\n        }, (error, stdout) => {",
  "        execFile(\"git\", [\"--no-optional-locks\", \"symbolic-ref\", \"--quiet\", \"--short\", \"HEAD\"], {\n            cwd: repoDir,\n            encoding: \"utf8\",\n            windowsHide: true,\n        }, (error, stdout) => {",
);

await replaceOnce(
  join(codingAgentRoot, "dist/utils/tools-manager.js"),
  "        const result = spawnSync(cmd, [\"--version\"], { stdio: \"pipe\" });",
  "        const result = spawnSync(cmd, [\"--version\"], { stdio: \"pipe\", windowsHide: true });",
);

await replaceOnce(
  join(codingAgentRoot, "dist/utils/shell.js"),
  "        const result = spawnSync(\"which\", [executable], { encoding: \"utf-8\", timeout: 5000 });",
  "        const result = spawnSync(\"which\", [executable], { encoding: \"utf-8\", timeout: 5000, windowsHide: true });",
);

const subagentRunnerPaths = [
  join(root, "node_modules/@mjakl/pi-subagent/runner.ts"),
  join(homedir(), ".pi/agent/npm/node_modules/@mjakl/pi-subagent/runner.ts"),
];
for (const runnerPath of new Set(subagentRunnerPaths)) {
  if (!existsSync(runnerPath)) continue;
  await replaceOnce(
    runnerPath,
    '        detached: !isWindows,\n        stdio: ["pipe", "pipe", "pipe"],\n        env: {',
    '        detached: !isWindows,\n        stdio: ["pipe", "pipe", "pipe"],\n        windowsHide: true,\n        env: {',
  );
  await replaceOnce(
    runnerPath,
    '            const killer = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {\n              stdio: "ignore",\n            });',
    '            const killer = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {\n              stdio: "ignore",\n              windowsHide: true,\n            });',
  );
}

const foveaRoots = [
  join(root, "node_modules/pi-fovea"),
  join(homedir(), ".pi/agent/npm/node_modules/pi-fovea"),
];
for (const foveaRoot of new Set(foveaRoots)) {
  const astgrepPath = join(foveaRoot, "src/core/astgrep.ts");
  const gitPath = join(foveaRoot, "src/core/git.ts");
  if (!existsSync(astgrepPath) || !existsSync(gitPath)) continue;

  await replaceOnce(
    astgrepPath,
    'const probe = spawnSync("ast-grep", ["--version"], { encoding: "utf8" });',
    'const probe = spawnSync("ast-grep", ["--version"], { encoding: "utf8", windowsHide: true });',
  );
  await replaceOnce(
    astgrepPath,
    'const r = spawnSync(bin, ["--version"], { encoding: "utf8" });',
    'const r = spawnSync(bin, ["--version"], { encoding: "utf8", windowsHide: true });',
  );
  await replaceOnce(
    astgrepPath,
    'execFile(bin, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 }, (error) => {',
    'execFile(bin, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true }, (error) => {',
  );
  await replaceOnce(
    astgrepPath,
    '          { cwd, encoding: "utf8", timeout: RUN_TIMEOUT, maxBuffer: RUN_MAX_BUFFER },',
    '          { cwd, encoding: "utf8", timeout: RUN_TIMEOUT, maxBuffer: RUN_MAX_BUFFER, windowsHide: true },',
  );
  await replaceOnce(
    astgrepPath,
    '      execFile(bin, ["scan", "--help"], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 }, (error) => {',
    '      execFile(bin, ["scan", "--help"], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true }, (error) => {',
  );
  await replaceOnce(
    astgrepPath,
    '      { cwd, stdio: ["ignore", "pipe", "pipe"] },',
    '      { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },',
  );
  await replaceOnce(
    gitPath,
    '            env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", GIT_TERMINAL_PROMPT: "0" },\n            encoding: "utf8",',
    '            env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", GIT_TERMINAL_PROMPT: "0" },\n            encoding: "utf8",\n            windowsHide: true,',
  );
  const cli = join(foveaRoot, "dist/cli.mjs");
  if (!existsSync(cli)) continue;
  await replaceOnce(cli,
    '        encoding: "utf8",\n        timeout: opts.timeout ?? GIT_TIMEOUT,',
    '        encoding: "utf8",\n        windowsHide: true,\n        timeout: opts.timeout ?? GIT_TIMEOUT,');
  await replaceOnce(cli,
    'spawnSync("ast-grep", ["--version"], { encoding: "utf8" })',
    'spawnSync("ast-grep", ["--version"], { encoding: "utf8", windowsHide: true })');
  await replaceOnce(cli,
    'execFile2(bin, ["--version"], { encoding: "utf8", timeout: 5e3, maxBuffer: 1024 * 1024 }',
    'execFile2(bin, ["--version"], { encoding: "utf8", timeout: 5e3, maxBuffer: 1024 * 1024, windowsHide: true }');
  await replaceOnce(cli,
    '{ cwd, encoding: "utf8", timeout: RUN_TIMEOUT, maxBuffer: RUN_MAX_BUFFER }',
    '{ cwd, encoding: "utf8", timeout: RUN_TIMEOUT, maxBuffer: RUN_MAX_BUFFER, windowsHide: true }');
  await replaceOnce(cli,
    'execFile2(bin, ["scan", "--help"], { encoding: "utf8", timeout: 5e3, maxBuffer: 1024 * 1024 }',
    'execFile2(bin, ["scan", "--help"], { encoding: "utf8", timeout: 5e3, maxBuffer: 1024 * 1024, windowsHide: true }');
  await replaceOnce(cli,
    '{ cwd, stdio: ["ignore", "pipe", "pipe"] }',
    '{ cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }');
}

// Installed Pi extensions are outside this repository; repeat these patches after installs.
const webAccessRoots = [
  join(root, "node_modules/pi-web-access"),
  join(homedir(), ".pi/agent/npm/node_modules/pi-web-access"),
];
for (const base of new Set(webAccessRoots)) {
  if (!existsSync(join(base, "github-api.ts"))) continue;
  const githubApi = join(base, "github-api.ts");
  for (const [before, after, count] of [
    ['{ timeout: 5000, ...(signal ? { signal } : {}) }', '{ timeout: 5000, ...(signal ? { signal } : {}), windowsHide: true }', 1],
    ['{ timeout: 10000 }', '{ timeout: 10000, windowsHide: true }', 3],
    ['{ timeout: 15000, maxBuffer: 5 * 1024 * 1024 }', '{ timeout: 15000, maxBuffer: 5 * 1024 * 1024, windowsHide: true }', 1],
    ['{ timeout: 10000, maxBuffer: 2 * 1024 * 1024 }', '{ timeout: 10000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }', 1],
  ]) {
    await replaceAllExact(githubApi, before, after, count);
  }
  await replaceOnce(join(base, "github-issue-pr.ts"),
    '\t\t\tmaxBuffer: 10 * 1024 * 1024,',
    '\t\t\tmaxBuffer: 10 * 1024 * 1024,\n\t\t\twindowsHide: true,');
  await replaceOnce(join(base, "chrome-cookies.ts"),
    'maxBuffer: 1024 * 1024, env: { ...process.env, PIWA_PROTECTED:',
    'maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, PIWA_PROTECTED:');
  await replaceOnce(join(base, "chrome-cookies.ts"),
    'execFile("sqlite3", ["-readonly", "-json", dbPath, sql], { timeout: 5000, maxBuffer: 1024 * 1024 }',
    'execFile("sqlite3", ["-readonly", "-json", dbPath, sql], { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true }');
  await replaceOnce(join(base, "chrome-cookies.ts"),
    'execFile("python3", ["-c", script, dbPath, sql], { timeout: 5000, maxBuffer: 1024 * 1024 }',
    'execFile("python3", ["-c", script, dbPath, sql], { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true }');
  await replaceOnce(join(base, "index.ts"),
    'execFileSync("npm", ["root", "-g"], { encoding: "utf-8" })',
    'execFileSync("npm", ["root", "-g"], { encoding: "utf-8", windowsHide: true })');
  await replaceOnce(join(base, "video-extract.ts"),
    'timeout: 10000, stdio: ["pipe", "pipe", "pipe"]',
    'timeout: 10000, stdio: ["pipe", "pipe", "pipe"], windowsHide: true');
  await replaceOnce(join(base, "video-extract.ts"),
    'timeout: 10000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"]',
    'timeout: 10000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true');
  await replaceOnce(join(base, "youtube-extract.ts"),
    'timeout: 15000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"]',
    'timeout: 15000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true');
  await replaceOnce(join(base, "youtube-extract.ts"),
    'timeout: 30000, stdio: ["pipe", "pipe", "pipe"]',
    'timeout: 30000, stdio: ["pipe", "pipe", "pipe"], windowsHide: true');
}

const askQuestionEditorPaths = [
  join(root, "node_modules/@juicesharp/rpiv-ask-user-question/state/external-editor.ts"),
  join(homedir(), ".pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question/state/external-editor.ts"),
];
for (const path of new Set(askQuestionEditorPaths)) {
  if (!existsSync(path)) continue;
  await replaceOnce(path,
    '\t\t\tstdio: "inherit",\n\t\t\tshell: process.platform === "win32",',
    '\t\t\tstdio: "inherit",\n\t\t\tshell: process.platform === "win32",\n\t\t\twindowsHide: true,');
}

const playwrightRoots = [
  join(root, "node_modules/pi-playwright"),
  join(homedir(), ".pi/agent/npm/node_modules/pi-playwright"),
];
for (const base of new Set(playwrightRoots)) {
  const runtime = join(base, "skills/playwright-browser/scripts/lib/runtime.js");
  if (!existsSync(runtime)) continue;
  await replaceOnce(runtime,
    '  const result = spawnSync(bin, finalArgs, {',
    '  const result = spawnSync(process.platform === "win32" ? process.execPath : bin, process.platform === "win32" ? [join(packageRoot, "node_modules", "@playwright", "cli", "playwright-cli.js"), ...finalArgs] : finalArgs, {');
  await replaceOnce(runtime,
    '      stdio: ["ignore", "pipe", "ignore"],',
    '      stdio: ["ignore", "pipe", "ignore"],\n      windowsHide: true,');
  await replaceOneOf(runtime, [
    {
      before: '    stdio: process.platform === "win32" ? ["ignore", "pipe", "pipe"] : "inherit",\n    windowsHide: true,',
      after: '    stdio: process.platform === "win32" ? ["ignore", "pipe", "pipe"] : "inherit",\n    maxBuffer: 64 * 1024 * 1024,\n    windowsHide: true,',
    },
    {
      before: '    stdio: "inherit",',
      after: '    stdio: process.platform === "win32" ? ["ignore", "pipe", "pipe"] : "inherit",\n    maxBuffer: 64 * 1024 * 1024,\n    windowsHide: true,',
    },
  ]);
  await replaceOnce(runtime,
    '  if (typeof result.status === "number") {',
    '  if (process.platform === "win32") {\n    if (result.stdout) process.stdout.write(result.stdout);\n    if (result.stderr) process.stderr.write(result.stderr);\n  }\n\n  if (typeof result.status === "number") {');

  const core = join(base, "node_modules/playwright-core/lib/coreBundle.js");
  const utils = join(base, "node_modules/playwright-core/lib/utilsBundle.js");
  if (!existsSync(core) || !existsSync(utils)) continue;
  await replaceOnce(core,
    '    shell: options.shell,\n    stdio\n  };\n  const spawnedProcess = childProcess.spawn',
    '    shell: options.shell,\n    stdio,\n    windowsHide: true\n  };\n  const spawnedProcess = childProcess.spawn');
  await replaceOnce(core,
    'const cp = childProcess3.fork(libPath("entry", "oopBrowserDownload.js"));',
    'const cp = childProcess3.fork(libPath("entry", "oopBrowserDownload.js"), { windowsHide: true });');
  await replaceOnce(core,
    'const client = (0, import_child_process2.spawn)(process.execPath, [...daemonArgs, "--annotate"], {\n          stdio: ["pipe", "pipe", "inherit"]',
    'const client = (0, import_child_process2.spawn)(process.execPath, [...daemonArgs, "--annotate"], {\n          stdio: ["pipe", "pipe", "inherit"],\n          windowsHide: true');
  await replaceOnce(core,
    'const daemon = (0, import_child_process2.spawn)(process.execPath, daemonArgs, { detached: true, stdio: "ignore", windowsHide: true });',
    'const daemon = (0, import_child_process2.spawn)(process.execPath, daemonArgs, { detached: process.platform !== "win32", stdio: "ignore", windowsHide: true });');
  await replaceOnce(core,
    'const child = (0, import_child_process3.spawn)(process.execPath, args, {\n          detached: true,',
    'const child = (0, import_child_process3.spawn)(process.execPath, args, {\n          detached: process.platform !== "win32",');
  await replaceOnce(core,
    'this._driverProcess = childProcess4.fork(import_path62.default.join(packageRoot, "cli.js"), ["run-driver"], {\n          stdio: "pipe",\n          detached: true,',
    'this._driverProcess = childProcess4.fork(import_path62.default.join(packageRoot, "cli.js"), ["run-driver"], {\n          stdio: "pipe",\n          detached: process.platform !== "win32",\n          windowsHide: true,');
  await replaceOnce(utils,
    '  const childProcessOptions = {};\n  let shouldUseWindowsInWsl',
    '  const childProcessOptions = { windowsHide: true };\n  let shouldUseWindowsInWsl');
  await replaceOnce(utils,
    '    encoding: "utf8",\n      ...execFileOptions',
    '    encoding: "utf8",\n      windowsHide: true,\n      ...execFileOptions');
  await replaceOnce(utils,
    'proc = import_node_child_process8.default.spawn(import_node_process8.default.execPath, args, { stdio: "inherit" });',
    'proc = import_node_child_process8.default.spawn(import_node_process8.default.execPath, args, { stdio: "inherit", windowsHide: true });');
}

console.log("Applied Pi ownerSessionId and Windows hidden-process patches");
