#!/usr/bin/env node
// Jarvis CLI — starts the built production server.
// Resolves paths relative to the package root so `npx jarvis` works from any
// directory (the server resolves dist/client against process.cwd()).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distEntry = join(root, "dist", "server", "server", "index.js");

const DEFAULT_PORT = "9528";

function printHelp() {
  console.log(`jarvis — a local coding workspace for persistent Pi sessions

Usage:
  jarvis [options]

Options:
  -p, --port <port>   Port to listen on (default: ${DEFAULT_PORT})
  -h, --host <host>   Bind address (default: 0.0.0.0, i.e. all interfaces)
      --open          Open the web UI in your default browser after start
  -v, --version       Print version
      --help          Show this help

Requires Node.js >= 24 and a configured Pi profile (~/.pi/agent).

Security: jarvis has no authentication and can operate Pi sessions.
Run it only on your local machine or a trusted LAN — never expose it
to the public internet.
`);
}

function parseArgs(argv) {
  const opts = { port: null, host: null, open: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "-p":
      case "--port":
        opts.port = next();
        break;
      case "-h":
      case "--host":
        opts.host = next();
        break;
      case "--open":
        opts.open = true;
        break;
      case "-v":
      case "--version":
        opts.version = true;
        break;
      case "--help":
        opts.help = true;
        break;
      default:
        if (arg.startsWith("-")) {
          console.error(`jarvis: unknown option "${arg}" (see --help)`);
          process.exit(2);
        }
        console.error(`jarvis: unexpected argument "${arg}" (see --help)`);
        process.exit(2);
    }
  }
  return opts;
}

function openBrowser(port) {
  const url = `http://127.0.0.1:${port}`;
  const command =
    process.platform === "win32"
      ? "start"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  // Give the server a moment to start listening.
  setTimeout(() => {
    spawn(command, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  }, 1200);
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  printHelp();
  process.exit(0);
}

if (opts.version) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  console.log(pkg.version);
  process.exit(0);
}

if (!existsSync(distEntry)) {
  console.error(
    "jarvis: production build not found. Build it first with:\n\n  npm run build\n",
  );
  process.exit(1);
}

const port = opts.port ?? process.env["PORT"] ?? DEFAULT_PORT;
const host = opts.host ?? process.env["HOST"] ?? "0.0.0.0";

const child = spawn(
  process.execPath,
  [distEntry],
  {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOST: host,
    },
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("error", (error) => {
  console.error("jarvis: failed to start server:", error.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (opts.open && (code === 0 || signal === null)) process.exit(code ?? 0);
  process.exit(code ?? 0);
});

if (opts.open) openBrowser(port);
