#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const skillScriptsDir = dirname(fileURLToPath(import.meta.url));
const agentRootFromSkill = join(skillScriptsDir, "..", "..", "..");

function agentRoots() {
	const roots = [agentRootFromSkill];
	if (process.env.PI_CODING_AGENT_DIR) roots.push(process.env.PI_CODING_AGENT_DIR);
	roots.push(join(homedir(), ".pi", "agent"));
	return [...new Set(roots)];
}

function firstExisting(paths) {
	return paths.find((path) => existsSync(path)) ?? null;
}

function playwrightSkillPw() {
	return firstExisting(agentRoots().map((root) =>
		join(root, "npm", "node_modules", "pi-playwright", "skills", "playwright-browser", "scripts", "pw.js"),
	));
}

function playwrightCliJs() {
	return firstExisting(agentRoots().map((root) =>
		join(root, "npm", "node_modules", "@playwright", "cli", "playwright-cli.js"),
	));
}

function sanitizeSessionName(value) {
	const session = String(value || "")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "");
	return session || "pi-playwright";
}

function detectSessionName() {
	if (process.env.PLAYWRIGHT_CLI_SESSION) {
		return sanitizeSessionName(process.env.PLAYWRIGHT_CLI_SESSION);
	}
	const git = spawnSync("git", ["rev-parse", "--show-toplevel"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (git.status === 0 && git.stdout.trim()) {
		return sanitizeSessionName(basename(git.stdout.trim()));
	}
	return sanitizeSessionName(basename(process.cwd()));
}

function hasExplicitSessionArg(args) {
	return args.some((arg, index) => {
		if (arg.startsWith("-s=")) return true;
		if (arg === "-s" || arg === "--session") return true;
		if (index > 0 && (args[index - 1] === "-s" || args[index - 1] === "--session")) return true;
		return false;
	});
}

const args = process.argv.slice(2);
const cmd = args.find((arg) => !arg.startsWith("-"));
if (cmd === "open") {
	for (let index = args.length - 1; index >= 0; index--) {
		if (args[index] === "--headed" || args[index].startsWith("--headed=")) {
			args.splice(index, 1);
		}
	}
	if (!args.some((arg) => arg === "--browser" || arg.startsWith("--browser="))) {
		args.push("--browser=chromium");
	}
}

const skillPw = playwrightSkillPw();
if (skillPw) {
	const result = spawnSync(process.execPath, [skillPw, ...args], { stdio: "inherit" });
	if (result.status === 0) process.exit(0);
}

const cliJs = playwrightCliJs();
if (cliJs) {
	const cliArgs = hasExplicitSessionArg(args) ? args : [`-s=${detectSessionName()}`, ...args];
	const result = spawnSync(process.execPath, [cliJs, ...cliArgs], { stdio: "inherit" });
	process.exit(typeof result.status === "number" ? result.status : 1);
}

console.error("pi-playwright is not installed. Run: pi install npm:pi-playwright");
process.exit(1);
