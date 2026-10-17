#!/usr/bin/env node
/**
 * panel1 client —— 多站点 1Panel 管理 CLI（唯一入口，模型只调它，绝不手拼签名）
 *
 * 认证:1Panel-Timestamp + 1Panel-Token = md5("1panel" + API_KEY + TIMESTAMP)
 * 配置:data/sites.json(站点+key+密码+profile)、data/projects.json(项目部署映射)
 *       随 git 仓库同步(多设备);仓库必须保持私有。
 *
 * 兼容层:profile 由 swagger 路由表判定(初始化时)——
 *   legacy : /core/settings/api/config/{update,generate/key}, files/read 单端点(type 在 body),
 *            状态值 "Enable"
 *   current: /core/auth/api/{update,generate}, files/read/:type
 * 查询必填字段(order/orderBy/state)总是补齐(超集,两版都接受)。
 *
 * 写操作分级(与 SKILL.md 一致):
 *   safe(直接执行)      : start/restart/pause/unpause
 *   notice(说明后执行)  : stop/upgrade
 *   dangerous(需确认)   : delete/remove/kill —— CLI 强制 --confirm
 *
 * 使用示例:
 *   node client.mjs list
 *   node client.mjs status --site home
 *   node client.mjs query websites --site home --name xxx
 *   node client.mjs logs website --site home --name xxx.cn --tail 100
 *   node client.mjs operate container --site home --names c1 --action restart
 *   node client.mjs operate website --site home --id 3 --action stop
 *   node client.mjs project add --repo https://github.com/u/r --name 项目名称 --confirm
 *   node client.mjs project bind --key r --site home --kind website --id 3 --confirm
 *   node client.mjs project refresh --key r  // 只查询，保存需 --save --confirm
 *   node client.mjs site note --site home --text "xxx"
 */
import { createHash, createPublicKey, randomBytes, createCipheriv, constants, publicEncrypt, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, renameSync, unlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(SKILL_DIR, "data");
const SITES_FILE = path.join(DATA_DIR, "sites.json");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");
const TIMEOUT_MS = 30000;

/* ============================== 数据读写 ============================== */

function readJSON(file, fallback) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}
function writeJSON(file, data) {
	writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}
function loadSites() {
	return readJSON(SITES_FILE, { sites: [] });
}
function saveSites(sites) {
	writeJSON(SITES_FILE, sites);
}
const projectSnapshots = new WeakMap();
function loadProjects() {
	// 不能把损坏的登记表当成空表，否则下一次写入会覆盖已有项目。
	const raw = readFileSync(PROJECTS_FILE, "utf8");
	const data = JSON.parse(raw);
	if (!data || !Array.isArray(data.projects)) throw new Error("projects.json 必须包含 projects 数组");
	projectSnapshots.set(data, raw);
	return data;
}
function saveProjects(data) {
	const lock = `${PROJECTS_FILE}.lock.tmp`;
	const temp = `${PROJECTS_FILE}.${randomUUID()}.tmp`;
	let fd;
	try { fd = openSync(lock, "wx"); }
	catch (err) {
		if (err.code === "EEXIST") throw new Error("项目登记正在写入，请稍后重试；残留锁需确认无写入进程后清理");
		throw err;
	}
	try {
		if (readFileSync(PROJECTS_FILE, "utf8") !== projectSnapshots.get(data)) throw new Error("项目登记已被其他会话修改，请重新读取后重试");
		writeJSON(temp, data);
		renameSync(temp, PROJECTS_FILE);
	} finally {
		if (existsSync(temp)) unlinkSync(temp);
		closeSync(fd);
		unlinkSync(lock);
	}
}
function getSite(key) {
	const s = loadSites();
	const site = s.sites.find((x) => x.key === key);
	if (!site) throw new Error(`未找到站点 "${key}"。可用 list 查看站点, 或 add-site 初始化新站点。`);
	return site;
}
function now() {
	return new Date().toISOString();
}
function appendNote(obj, text) {
	const ts = now();
	const line = `[${ts}] ${text}`;
	obj.notes = obj.notes ? obj.notes + "\n" + line : line;
	obj.updatedAt = ts;
}

/* ============================== 签名请求核心 ============================== */

function signHeaders(apiKey) {
	const ts = String(Math.floor(Date.now() / 1000));
	const token = createHash("md5").update(`1panel${apiKey}${ts}`).digest("hex");
	return { "1Panel-Timestamp": ts, "1Panel-Token": token };
}

async function apiCall(site, apiPath, opts = {}) {
	const baseUrl = site.baseUrl.replace(/\/+$/, "");
	const url = new URL(`${baseUrl}/api/v2/${apiPath.replace(/^\/+/, "")}`);
	if (opts.query) {
		for (const [k, v] of Object.entries(opts.query)) {
			if (v !== undefined) url.searchParams.set(k, String(v));
		}
	}
	const headers = { "Content-Type": "application/json", ...signHeaders(site.apiKey) };
	let body;
	if (opts.body !== undefined) body = JSON.stringify(opts.body);
	let response;
	try {
		response = await fetch(url, { method: opts.method ?? "GET", headers, body, signal: opts.signal });
	} catch (err) {
		throw new Error(`网络错误(${baseUrl}): ${err.message}`);
	}
	const raw = await response.text();
	if (!response.ok) {
		const hint = [401, 403].includes(response.status)
			? " (API Key 无效/时间戳被拒: 检查面板 API 接口开关、白名单、机器时钟)"
			: "";
		throw new Error(`HTTP ${response.status}: ${raw.slice(0, 400)}${hint}`);
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = { code: 0, data: raw };
	}
	const code = parsed.code ?? 0;
	// 兼容: legacy 面板成功返回 code=200, 新面板返回 code=0
	if (code !== 0 && code !== 200) {
		throw new Error(`业务错误 code=${code}: ${parsed.msg ?? parsed.message ?? "无消息"}`);
	}
	return parsed.data;
}

/* 兼容层: 搜索必填字段总是补齐(超集, legacy/current 都接受) */
const SEARCH_EXTRA = {
	websites: { order: "null", orderBy: "createdAt" },
	containers: { state: "all", order: "null", orderBy: "createdAt" },
	cronjobs: { order: "null", orderBy: "createdAt" },
	databases: { order: "null", orderBy: "createdAt" },
};
function searchBody(module, params) {
	return {
		page: params.page ?? 1,
		pageSize: Math.min(params.pageSize ?? 50, 200),
		...(params.name ? { name: params.name } : {}),
		...(SEARCH_EXTRA[module] ?? {}),
	};
}

async function readSiteLogs(site, req) {
	// legacy: /files/read(type 在 body); current: /files/read/:type
	const body = { page: req.page ?? 1, pageSize: req.pageSize ?? 100, type: req.type, name: req.name, latest: req.latest ?? true };
	const tryPaths =
		site.profile === "current" ? [`files/read/${req.type}`, "files/read"] : ["files/read", `files/read/${req.type}`];
	let lastErr;
	for (const p of tryPaths) {
		try {
			return await apiCall(site, p, { method: "POST", body });
		} catch (err) {
			lastErr = err;
			if (!String(err.message).includes("404")) throw err;
		}
	}
	throw new Error(`读取日志失败: ${lastErr?.message}`);
}

/* ============================== RSA+AES 密码加密(登录用) ============================== */

function hybridEncrypt(password, pubKeyCookieValue) {
	// cookie 值 = base64(PEM) 或 PEM 本身(URL 解码已在 extractCookies 处理)
	const pem = pubKeyCookieValue.includes("-----")
		? pubKeyCookieValue
		: Buffer.from(pubKeyCookieValue, "base64").toString("utf8");
	const pub = createPublicKey(pem);
	const aesKey = randomBytes(16);
	const iv = randomBytes(16);
	const cipher = createCipheriv("aes-128-cbc", aesKey, iv);
	const enc = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
	const keyCipher = publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_PADDING }, aesKey);
	return `${keyCipher.toString("base64")}:${iv.toString("base64")}:${enc.toString("base64")}`;
}

/* ============================== 会话登录(仅 add-site 用) ============================== */

function extractCookies(resp) {
	let setCookieHeaders;
	try {
		setCookieHeaders = resp.headers.getSetCookie?.() ?? [];
	} catch {
		setCookieHeaders = [];
	}
	const map = {};
	for (const c of setCookieHeaders) {
		const [pair] = c.split(";");
		const idx = pair.indexOf("=");
		if (idx > 0) {
			let v = pair.slice(idx + 1).trim();
			try {
				v = decodeURIComponent(v);
			} catch {}
			map[pair.slice(0, idx).trim()] = v;
		}
	}
	return map;
}

async function panelLogin(siteAuth, { captchaID, captcha }) {
	const base = siteAuth.baseUrl.replace(/\/+$/, "");
	const settingResp = await fetch(`${base}/api/v2/core/auth/setting`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
	await settingResp.text();
	const cookies = extractCookies(settingResp);
	const pubKey = cookies["panel_public_key"];
	if (!pubKey) throw new Error("未获取到 panel_public_key(登录公钥) cookie, 请检查面板版本/网络。");
	const encPassword = hybridEncrypt(siteAuth.password, pubKey);
	const headers = { "Content-Type": "application/json" };
	if (siteAuth.entrance) headers.EntranceCode = Buffer.from(siteAuth.entrance, "utf8").toString("base64");
	const loginBody = { name: siteAuth.username, password: encPassword, language: "zh" };
	if (captchaID && captcha) Object.assign(loginBody, { captchaID, captcha });
	const loginResp = await fetch(`${base}/api/v2/core/auth/login`, {
		method: "POST",
		headers,
		body: JSON.stringify(loginBody),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	const loginRaw = await loginResp.text();
	let login;
	try {
		login = JSON.parse(loginRaw);
	} catch {
		login = { code: -1, message: loginRaw.slice(0, 200) };
	}
	const code = login.code ?? 0;
	if (code !== 0 && code !== 200) {
		const msg = login.message || "";
		const hint = msg.includes("Captcha")
			? "验证码不对/过期, 需要新的验证码(重新拉取后传入 --captcha-id/--captcha)"
			: msg.includes("Entrance")
				? "安全入口码不对, 检查 --entrance 参数"
				: msg === "ErrAuth"
					? "用户名/密码错误(或连续失败已被锁定, 等几分钟再试)"
					: "登录失败, 检查网络/面板版本";
		throw new Error(`登录失败(${msg || code}): ${hint}`);
	}
	if (login.data?.mfaStatus && !["", "disable", "Disable"].includes(login.data.mfaStatus)) {
		throw new Error(`该账号启用了 MFA(${login.data.mfaStatus}), 本 CLI 暂不支持, 请手动处理。`);
	}
	const loginCookies = extractCookies(loginResp);
	return {
		session: loginCookies["psession"] ?? "",
		csrf: loginCookies["pcsrftoken"] ?? "",
	};
}

async function fetchSwagger(base, session) {
	const resp = await fetch(`${base}/1panel/swagger/doc.json`, {
		headers: { Cookie: `psession=${session}` },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!resp.ok) return null;
	try {
		return JSON.parse(await resp.text());
	} catch {
		return null;
	}
}

function detectProfile(swagger) {
	if (!swagger) return "unknown";
	const paths = Object.keys(swagger.paths ?? {});
	if (paths.includes("/core/settings/api/config/update")) return "legacy";
	if (paths.includes("/core/auth/api/update")) return "current";
	return "unknown";
}
function detectCapabilities(swagger) {
	if (!swagger) return {};
	const paths = new Set(Object.keys(swagger.paths ?? {}));
	const has = (frag) => [...paths].some((p) => p.includes(frag));
	return {
		websites: has("/websites"),
		containers: has("/containers"),
		apps: has("/apps/installed"),
		cronjobs: has("/cronjobs"),
		runtimes: has("/runtimes"),
		nodes: has("/core/nodes"),
		databases: has("/databases"),
		monitoring: has("/dashboard"),
	};
}

async function enableApiAndGenKey(siteAuth, sess, profile) {
	const base = siteAuth.baseUrl.replace(/\/+$/, "");
	const headers = { "Content-Type": "application/json", Cookie: `psession=${sess.session}` };
	if (sess.csrf) headers["X-CSRF-Token"] = sess.csrf;
	const cfgBase = { apiInterfaceStatus: "Enable", ipWhiteList: "0.0.0.0/0" };
	const pairs =
		profile === "current"
			? [["core/auth/api/update", "core/auth/api/generate"]]
			: profile === "legacy"
				? [["core/settings/api/config/update", "core/settings/api/config/generate/key"]]
				: [
						["core/settings/api/config/update", "core/settings/api/config/generate/key"],
						["core/auth/api/update", "core/auth/api/generate"],
					];
	let lastErr;
	for (const [up, gen] of pairs) {
		try {
			// 版本差异: current 的 core/auth 路由要求 apiKeyValidityTime 为 int, legacy 接受 string
			const cfg = { ...cfgBase, apiKeyValidityTime: up.startsWith("core/auth") ? 0 : "0" };
			const r = await fetch(`${base}/api/v2/${up}`, { method: "POST", headers, body: JSON.stringify(cfg), signal: AbortSignal.timeout(TIMEOUT_MS) });
			const t = await r.text();
			let j;
			try {
				j = JSON.parse(t);
			} catch {
				throw new Error(`${up}: 非 JSON 响应(${t.slice(0, 80)})`);
			}
			if ((j.code ?? 0) !== 0 && j.code !== 200) throw new Error(`${up}: ${j.message || j.msg}`);
			const g = await fetch(`${base}/api/v2/${gen}`, { method: "POST", headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
			const gt = await g.text();
			const gj = JSON.parse(gt);
			const key = gj.data;
			if (!key) throw new Error(`${gen}: 未返回 key`);
			const resolved = profile === "unknown" ? (up.startsWith("core/settings") ? "legacy" : "current") : profile;
			return { key, profile: resolved };
		} catch (err) {
			lastErr = err;
		}
	}
	throw new Error(`开启 API 接口失败: ${lastErr?.message}`);
}

/* ============================== 子命令 ============================== */

function print(data) {
	console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

async function cmdList() {
	const s = loadSites();
	if (!s.sites.length) {
		console.log("暂无站点。add-site --key <名称> --url <地址> --user <用户名> --entrance <入口码> --password-env <环境变量名>");
		return;
	}
	console.log("站点列表:");
	for (const site of s.sites) {
		console.log(`  [${site.key}] ${site.name ?? "-"}  ${site.baseUrl}  profile=${site.profile}`);
	}
}

async function cmdStatus({ site }) {
	const st = getSite(site);
	const osInfo = await apiCall(st, "dashboard/base/os");
	let node = null;
	try {
		node = await apiCall(st, "dashboard/current/node");
	} catch {}
	// 自动刷新 hostInfo(看情况自动保存)
	const s = loadSites();
	const t = s.sites.find((x) => x.key === site);
	if (t) {
		t.hostInfo = { os: osInfo.os, platform: osInfo.platform, kernel: osInfo.kernelVersion, arch: osInfo.kernelArch, cpu: node?.cpuTotal ?? null, mem: node?.memoryTotal ?? null, ...t.hostInfo };
		appendNote(t, "status: 刷新 hostInfo");
		saveSites(s);
	}
	print({ osInfo, node });
}

async function cmdQuery(args) {
	const st = getSite(args.site);
	const module = args._sub ?? args.module;
	const page = args.page ? Number(args.page) : undefined;
	const pageSize = args.pageSize ? Number(args.pageSize) : undefined;
	const id = args.id !== undefined ? Number(args.id) : undefined;
	switch (module) {
		case "dashboard": {
			const [osInfo, node, topCpu, topMem] = await Promise.all([
				apiCall(st, "dashboard/base/os"),
				apiCall(st, "dashboard/current/node").catch(() => null),
				apiCall(st, "dashboard/current/top/cpu").catch(() => null),
				apiCall(st, "dashboard/current/top/mem").catch(() => null),
			]);
			return print({ osInfo, node, topCpu, topMem });
		}
		case "websites":
			return print(await apiCall(st, "websites/search", { method: "POST", body: searchBody("websites", { page, pageSize, name: args.name }) }));
		case "website": {
			if (!id) throw new Error("website 详情需要 --id");
			if (args.nginx) {
				// 只读: 读取网站 nginx 配置片段（排查 root/rewrite 用）--nginx <type>
				const t = args.nginx === true ? "websites" : args.nginx;
				return print(await apiCall(st, `websites/${id}/config/${t}`, { method: "GET" }).catch((e) => ({ error: e.message, tried: t })));
			}
			const [detail, domains] = await Promise.all([
				apiCall(st, `websites/${id}`),
				apiCall(st, `websites/domains/${id}`).catch(() => null),
			]);
			return print({ detail, domains });
		}
		case "containers":
			return print(await apiCall(st, "containers/search", { method: "POST", body: searchBody("containers", { page, pageSize, name: args.name }) }));
		case "apps":
			return print(await apiCall(st, "apps/installed/search", { method: "POST", body: { page: page ?? 1, pageSize: pageSize ?? 50, ...(args.name ? { name: args.name } : {}) } }));
		case "cronjobs":
			return print(await apiCall(st, "cronjobs/search", { method: "POST", body: searchBody("cronjobs", { page, pageSize, name: args.name }) }));
		case "runtimes":
			return print(await apiCall(st, "runtimes/search", { method: "POST", body: { page: page ?? 1, pageSize: pageSize ?? 50, ...(args.type ? { type: args.type } : {}), ...(args.name ? { name: args.name } : {}) } }));
		case "databases": {
			const res = await apiCall(st, "databases/search", { method: "POST", body: { page: page ?? 1, pageSize: pageSize ?? 50, info: args.name ?? "", database: args.db ?? "mysql", orderBy: "createdAt", order: "null" } });
			const items = (res.items ?? []).map((x) => ({ id: x.id, name: x.name, username: x.username, permission: x.permission, format: x.format, from: x.from, description: x.description, createdAt: x.createdAt }));
			return print({ total: res.total, items });
		}
		case "groups":
			return print(await apiCall(st, "groups/search", { method: "POST", body: { page: page ?? 1, pageSize: pageSize ?? 50 } }));
		case "acme":
			return print(await apiCall(st, "websites/acme/search", { method: "POST", body: { page: page ?? 1, pageSize: pageSize ?? 50 } }));
		case "ssl": {
			const res = await apiCall(st, "websites/ssl/search", { method: "POST", body: { page: page ?? 1, pageSize: pageSize ?? 50, domain: args.name ?? "", orderBy: "created_at", order: "null" } });
			const items = (res.items ?? []).map((x) => ({ id: x.id, primaryDomain: x.primaryDomain, status: x.status, provider: x.provider, keyType: x.keyType, autoRenew: x.autoRenew, startDate: x.startDate, expireDate: x.expireDate, acmeAccountId: x.acmeAccountId, dnsAccountId: x.dnsAccountId }));
			return print({ total: res.total, items });
		}
		default:
			throw new Error(`未知查询模块: ${module}。可用: dashboard|websites|website|containers|apps|cronjobs|runtimes|databases|groups|acme|ssl`);
	}
}

async function cmdLogs(args) {
	const st = getSite(args.site);
	const kind = args._sub ?? args.kind;
	if (kind === "panel") {
		const logType = args.type === "login" ? "login" : "operation";
		return print(await apiCall(st, `core/logs/${logType}`, { method: "POST", body: { page: 1, pageSize: Math.min(Number(args.tail ?? 50) || 50, 200) } }));
	}
	if (kind === "website") {
		if (!args.name) throw new Error("网站日志需要 --name <网站名/主域名>");
		return print(await readSiteLogs(st, { type: "website", name: args.name, pageSize: Math.min(Number(args.tail ?? 100) || 100, 500), latest: true }));
	}
	throw new Error("日志类型: panel(--type operation|login) 或 website(--name)");
}

const OPERATE_DEFS = {
	container: {
		path: "containers/operate",
		safe: new Set(["start", "restart", "unpause", "pause"]),
		notice: new Set(["stop"]),
		danger: new Set(["kill", "remove"]),
		buildBody: (p) => ({ names: p.names, operation: p.action }),
	},
	website: {
		path: "websites/operate",
		safe: new Set(["restart", "start"]),
		notice: new Set(["stop"]),
		danger: new Set(["delete"]),
		buildBody: (p) => {
			if (p.action === "delete") {
				return {
					id: p.id,
					deleteApp: p.deleteApp === true || p.deleteApp === "true",
					forceDelete: p.forceDelete !== false && p.forceDelete !== "false",
					deleteBackup: p.deleteBackup === true || p.deleteBackup === "true",
				};
			}
			return { id: p.id, operate: p.action };
		},
	},
	app: {
		path: "apps/installed/op",
		safe: new Set(["restart", "start"]),
		notice: new Set(["stop", "upgrade"]),
		danger: new Set(["delete"]),
		buildBody: (p) => ({ installId: p.installId, operate: p.action }),
	},
	runtime: {
		path: "runtimes/operate",
		safe: new Set(["restart", "start"]),
		notice: new Set(["stop"]),
		danger: new Set(["delete"]),
		buildBody: (p) => {
			if (p.action === "delete") return { id: p.id, forceDelete: p.forceDelete !== false && p.forceDelete !== "false" };
			return { ID: p.id, operate: p.action };
		},
	},
	database: {
		// PostgreSQL 用户权限(1Panel v2); 非本仓库 CLI DB 动作
		path: "databases/pg/privileges",
		safe: new Set(["set-superuser"]),
		notice: new Set(),
		danger: new Set(),
		buildBody: (p) => ({ name: p.name, database: p.database ?? "postgresql", username: p.username, superUser: p.super === true || p.super === "true" }),
	},
};

async function cmdOperate(args) {
	const st = getSite(args.site);
	const target = args._sub ?? args.target;
	const def = OPERATE_DEFS[target];
	if (!def) throw new Error(`操作对象: ${Object.keys(OPERATE_DEFS).join("|")}`);
	const action = args.action;
	if (!action) throw new Error("需要 --action");
	if (!def.safe.has(action) && !def.notice.has(action) && !def.danger.has(action)) {
		throw new Error(`不支持的操作 "${action}"。可用: ${[...def.safe, ...def.notice, ...def.danger].join("|")}`);
	}
	if (def.danger.has(action) && args.confirm !== true) {
		throw new Error(`危险操作(${target} ${action})必须显式 --confirm。先向用户说明方案并确认后再执行。`);
	}
	if (def.notice.has(action)) {
		console.error(`[NOTICE] ${target} ${action}: 注意级操作, 执行前应先向用户说明意图。`);
	}
	let names, id, installId;
	if (Array.isArray(args.names)) names = args.names;
	else if (typeof args.names === "string") names = args.names.split(",").map((s) => s.trim()).filter(Boolean);
	id = args.id !== undefined ? Number(args.id) : undefined;
	installId = args.installId !== undefined ? Number(args.installId) : undefined;
	const body = def.buildBody({ ...args, names, id, installId, action });
	if (def.danger.has(action) && !body) throw new Error("参数不完整");
	const operatePath = target === "website" && action === "delete" ? "websites/del" : target === "runtime" && action === "delete" ? "runtimes/del" : def.path;
	const data = await apiCall(st, operatePath, { method: "POST", body });
	print(data);
	// 操作自动记录到站点 notes(进 git 可追溯)
	const s = loadSites();
	const t = s.sites.find((x) => x.key === args.site);
	if (t) {
		appendNote(t, `operate: ${target} ${action} ${names ? names.join(",") : id ?? installId}`);
		saveSites(s);
	}
}

/* ---------- create(基础原子创建, 一律 --confirm) ---------- */

const PHP_EXTENSIONS_DEFAULT =
	"bcmath,ftp,gd,gettext,intl,mysqli,pcntl,pdo_mysql,shmop,soap,sockets,sysvsem,xmlrpc,zip,exif,igbinary,imagick,apcu,memcached,opcache,redis,bc,image,dom,iconv,mbstring,mysqlnd,openssl,pdo,tokenizer,xml,curl,bz2,yaf,imap,xdebug,swoole,pdo_pgsql,fileinfo,pgsql,calendar,gmp";

// Node 运行环境画像(参考现有 node runtime, 如 wzhyglxt: appDetailID=1154 image=1panel/node:25.9.0)
function nodeRuntimeParams(name, port) {
	return {
		CODE_DIR: "/opt/1panel/apps/" + name,
		CONTAINER_NAME: name,
		CONTAINER_PACKAGE_URL: "https://registry.npmjs.org/",
		CONTAINER_PORT_0: "3000",
		CUSTOM_SCRIPT: "0",
		EXEC_SCRIPT: "start",
		HOST_IP: "0.0.0.0",
		HOST_IP_0: "",
		HOST_PORT_0: String(port),
		NODE_VERSION: "25.9.0",
		PACKAGE_MANAGER: "npm",
		RUN_INSTALL: "1",
	};
}

function confirmCreate(sub, args) {
	if (args.confirm !== true) {
		throw new Error(`create ${sub} 为写操作, 必须先向用户说明方案并确认, 再带 --confirm 执行。`);
	}
	console.error(`[CONFIRMED] create ${sub}: 用户已确认, 开始执行`);
}

async function cmdCreate(args) {
	const st = getSite(args.site);
	const sub = args._sub;
	switch (sub) {
		case "runtime": {
			confirmCreate(sub, args);
			const name = args.name;
			const port = args.port !== undefined ? Number(args.port) : undefined;
			const appDetailId = args.appDetailId !== undefined ? Number(args.appDetailId) : undefined;
			const image = args.image;
			const type = args.type ?? "php";
			if (!name || !port || !appDetailId || !image) {
				throw new Error(`create runtime 需要 --name --port --appDetailId --image (参考现有 php73: appDetailId=172 image=1panel-php-fpm:7.3.33; node: appDetailId=1154 image=1panel/node:25.9.0; go: appDetailId=445 image=golang:1.26)`);
			}
			const isNode = type === "node";
			const isGo = type === "go";
			if (!isNode && !isGo && type !== "php") throw new Error(`create runtime --type 仅支持 php|node|go`);
			const params = isNode
				? nodeRuntimeParams(name, port)
				: isGo
					? {
							CONTAINER_NAME: name,
							CONTAINER_PORT_0: "8080",
							EXEC_SCRIPT: args.execScript ?? "./server",
							GO_VERSION: args.version ?? "1.26",
							HOST_IP: "0.0.0.0",
							HOST_IP_0: "",
							HOST_PORT_0: String(port),
						}
					: {
							CONTAINER_NAME: name,
							CONTAINER_PACKAGE_URL: "https://mirrors.ustc.edu.cn",
							IMAGE_NAME: image,
							PANEL_APP_PORT_HTTP: port,
							PANEL_WEBSITE_DIR: args.websiteDir ?? "/opt/1panel/www",
							PHP_EXTENSIONS: args.phpExtensions ?? PHP_EXTENSIONS_DEFAULT,
							PHP_VERSION: args.version ?? "7.3.33",
							TZ: "Asia/Shanghai",
						};
			const body = {
				appDetailId,
				name,
				resource: "appstore",
				image,
				type: isNode ? "node" : isGo ? "go" : "php",
				version: isNode ? args.version ?? "25.9.0" : isGo ? args.version ?? "1.26" : args.version ?? "7.3.33",
				codeDir: args.codeDir ?? (isNode || isGo ? "/opt/1panel/apps/" + name : ""),
				remark: args.remark ?? "",
				taskID: randomUUID(),
				params,
			};
			if (isNode) {
				// Node runtime 用容器端口直映: 1Panel 按 exposedPorts 映射, 容器内固定 3000
				body.exposedPorts = [{ hostPort: port, containerPort: 3000, hostIP: "0.0.0.0", protocol: "tcp" }];
				body.install = false;
			}
			if (isGo) {
				// Go runtime 使用固定 8080 容器端口并映射到宿主端口。
				body.exposedPorts = [{ hostPort: port, containerPort: 8080, hostIP: "", protocol: "tcp" }];
				body.install = false;
			}
			console.log(`创建 ${isNode ? "Node" : isGo ? "Go" : "PHP"} 运行环境: name=${name} port=${port} image=${image}`);
			return print(await apiCall(st, "runtimes", { method: "POST", body }));
		}
		case "website": {
			confirmCreate(sub, args);
			const domain = args.domain;
			const type = args.type ?? "runtime";
			const runtimeId = args.runtimeId !== undefined ? Number(args.runtimeId) : undefined;
			if (!domain) throw new Error(`create website 需要 --domain`);
			if (!new Set(["runtime", "static"]).has(type)) throw new Error(`create website --type 仅支持 runtime|static`);
			if (type === "runtime" && !runtimeId) throw new Error(`create website --type runtime 需要 --runtimeId`);
			const body = {
				type,
				alias: args.alias ?? domain,
				remark: args.remark ?? "",
				proxy: "",
				appType: "installed",
				webSiteGroupID: args.groupId !== undefined ? Number(args.groupId) : 1,
				IPV6: args.ipv6 !== false,
				domains: [{ domain, port: 80, ssl: false }],
				taskID: randomUUID(),
			};
			if (type === "runtime") {
				body.runtimeID = runtimeId;
				// Node 运行时建站必须传 port(=runtime 端口), 后端取 create.Port 生成反代 upstream
				if (args.port !== undefined) body.port = Number(args.port);
			}
			console.log(`创建${type === "static" ? "静态" : "运行时"}网站: ${domain}${runtimeId ? ` runtimeId=${runtimeId}` : ""}${body.port ? ` port=${body.port}` : ""}`);
			return print(await apiCall(st, "websites", { method: "POST", body }));
		}
		case "database": {
			confirmCreate(sub, args);
			const name = args.name;
			const username = args.username;
			const password = args.password;
			if (!name || !username || !password) throw new Error(`create database 需要 --name --username --password`);
			const dbType = args.type ?? args.db ?? "mysql";
			if (dbType === "postgresql" || dbType === "postgres") {
				// 1Panel v2: PostgreSQL 独立端点 /databases/pg; database=应用实例名(如 postgresql)
				const body = {
					name,
					from: "local",
					database: "postgresql",
					format: "",
					username,
					password: Buffer.from(password, "utf8").toString("base64"),
					superUser: false,
					description: args.description ?? "",
				};
				console.log(`创建 PostgreSQL 数据库: ${name} user=${username} (instance=postgresql)`);
				return print(await apiCall(st, "databases/pg", { method: "POST", body }));
			}
			const body = {
				name,
				from: "local",
				database: args.db ?? "mysql",
				format: args.format ?? "utf8mb4",
				collation: args.collation ?? "utf8mb4_general_ci",
				username,
				password: Buffer.from(password, "utf8").toString("base64"),
				permission: args.permission ?? "%",
				description: args.description ?? "",
			};
			console.log(`创建数据库: ${body.database} user=${username} format=${body.format}`);
			return print(await apiCall(st, "databases", { method: "POST", body }));
		}
		case "acme": {
			confirmCreate(sub, args);
			if (!args.email) throw new Error(`create acme 需要 --email`);
			const body = { email: args.email, type: "letsencrypt", keyType: args.keyType ?? "EC256" };
			console.log(`创建 ACME 账户: ${args.email} (letsencrypt)`);
			return print(await apiCall(st, "websites/acme", { method: "POST", body }));
		}
		case "ssl": {
			confirmCreate(sub, args);
			const domain = args.domain;
			const acmeId = args.acmeId !== undefined ? Number(args.acmeId) : undefined;
			const provider = args.provider ?? "http";
			const dnsAccountId = args.dnsAccountId !== undefined ? Number(args.dnsAccountId) : undefined;
			if (!domain || !acmeId) throw new Error(`create ssl 需要 --domain --acmeId`);
			if (!new Set(["http", "dnsAccount"]).has(provider)) {
				throw new Error(`create ssl --provider 仅支持 http|dnsAccount`);
			}
			if (provider === "dnsAccount" && !dnsAccountId) {
				throw new Error(`create ssl --provider dnsAccount 需要 --dns-account-id`);
			}
			const body = {
				primaryDomain: domain,
				otherDomains: args.otherDomains ?? "",
				provider,
				acmeAccountId: acmeId,
				autoRenew: args.autoRenew !== false,
				keyType: args.keyType ?? "EC256",
				apply: true,
			};
			if (provider === "dnsAccount") body.dnsAccountId = dnsAccountId;
			console.log(`创建 SSL 证书条目并自动签发: ${domain} provider=${provider} acmeAccountId=${acmeId}${dnsAccountId ? ` dnsAccountId=${dnsAccountId}` : ""}`);
			const res = await apiCall(st, "websites/ssl", { method: "POST", body });
			console.log("证书签发为后台任务, 稍后用 query ssl --site 检查状态; 若返回 ID 可继续 configure https 绑定");
			return print(res);
		}
		default:
			throw new Error(`create 子命令: runtime|website|database|acme|ssl`);
	}
}

/* ---------- configure(基础配置变更, 一律 --confirm) ---------- */

async function cmdConfigure(args) {
	const st = getSite(args.site);
	const sub = args._sub;
	if (sub === "https") {
		if (args.confirm !== true) throw new Error(`configure https 为写操作, 必须先向用户说明方案并确认, 再带 --confirm 执行。`);
		const websiteId = args.websiteId !== undefined ? Number(args.websiteId) : undefined;
		const sslId = args.sslId !== undefined ? Number(args.sslId) : undefined;
		if (!websiteId || !sslId) throw new Error(`configure https 需要 --websiteId --sslId`);
		const body = {
			websiteId,
			enable: true,
			type: "existed",
			websiteSSLId: sslId,
			httpConfig: args.httpConfig ?? "HTTPSOnly",
			hsts: args.hsts !== false,
			hstsIncludeSubDomains: args.hstsSub !== false,
		};
		console.log(`为网站 id=${websiteId} 启用 HTTPS(证书 id=${sslId}, 模式=${body.httpConfig})`);
		return print(await apiCall(st, `websites/${websiteId}/https`, { method: "POST", body }));
	}
	throw new Error(`configure 子命令: https`);
}

/* ---------- rewrite(网站伪静态配置) ---------- */

async function cmdRewrite(args) {
	const st = getSite(args.site);
	const sub = args._sub;
	const websiteId = args.websiteId !== undefined ? Number(args.websiteId) : undefined;
	const name = args.name ?? "current";
	if (!websiteId) throw new Error(`rewrite 需要 --websiteId <网站ID>`);
	if (sub === "get") {
		const data = await apiCall(st, "websites/rewrite", { method: "POST", body: { websiteId, name } });
		print(data ?? {});
		return;
	}
	if (sub === "set") {
		if (args.confirm !== true) {
			throw new Error(`rewrite set 为写操作, 必须先向用户说明方案并确认, 再带 --confirm 执行。`);
		}
		const contentFile = args.contentFile ?? args.file;
		let content = args.content;
		if (content === undefined && contentFile !== undefined) {
			content = readFileSync(contentFile, "utf8");
		}
		if (content === undefined) throw new Error(`rewrite set 需要 --content 或 --content-file <文件>`);
		const body = { websiteId, name, content };
		console.log(`更新网站 id=${websiteId} 的伪静态配置(name=${name})`);
		const data = await apiCall(st, "websites/rewrite/update", { method: "POST", body });
		print(data ?? {});
		return;
	}
	throw new Error(`rewrite 子命令: get|set`);
}

/* ---------- site chown (网站 index 目录 chown -R, 修复 PHP 运行用户权限) ---------- */

async function cmdSiteChown(args) {
	const st = getSite(args.site);
	if (args.confirm !== true) {
		throw new Error(`site chown 为写操作(递归修改网站目录属主), 必须先向用户说明方案并确认, 再带 --confirm 执行。`);
	}
	const websiteId = args.websiteId !== undefined ? Number(args.websiteId) : undefined;
	const user = args.user ?? "1000";
	const group = args.group ?? "1000";
	if (!websiteId) throw new Error(`site chown 需要 --websiteId <网站ID>`);
	const body = { id: websiteId, user, group };
	console.log(`网站 id=${websiteId}: 将 index 目录属主改为 ${user}:${group} (chown -R)`);
	const data = await apiCall(st, `websites/dir/permission`, { method: "POST", body });
	console.log("完成:", JSON.stringify(data ?? {}) .slice(0, 200));
	return;
}

/* ---------- add-site ---------- */

async function cmdAddSite(args) {
	const { key, name, url, user, entrance, captchaID } = args;
	if (!key || !url || !user) throw new Error("add-site 需要 --key --url --user [--entrance] [--password|--password-env]");
	let pw = args.password ?? (args.passwordEnv ? process.env[args.passwordEnv] : undefined);
	if (!pw) {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		pw = (await rl.question("面板密码: ")).trim();
		rl.close();
	}
	if (!pw) throw new Error("未提供密码");
	const base = url.replace(/\/+$/, "");
	const siteAuth = { baseUrl: base, username: user, password: pw, entrance: entrance ?? "" };
	console.log(`[1/6] 探测 ${base} ...`);
	const settingResp = await fetch(`${base}/api/v2/core/auth/setting`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
	await settingResp.text();
	if (!settingResp.ok) throw new Error(`面板探测失败: HTTP ${settingResp.status}`);
	console.log("     面板在线(API v2)。");
	// 验证码: 已有 --captcha-id/--captcha 则直接用, 否则拉新验证码并提示模型视觉读取
	let capId = captchaID;
	let myCaptcha = args.captcha;
	if (!capId) {
		console.log("[2/6] 拉取验证码 ...");
		const capResp = await fetch(`${base}/api/v2/core/auth/captcha`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		const capJson = JSON.parse(await capResp.text());
		capId = capJson.data?.captchaID;
		const capImg = capJson.data?.imagePath ?? "";
		if (!capId || !capImg) throw new Error(`验证码响应异常: ${JSON.stringify(capJson).slice(0, 200)}`);
		const capFile = path.join(os.tmpdir(), `panel1-captcha-${capId}.png`);
		writeFileSync(capFile, Buffer.from(capImg.split(",")[1] ?? "", "base64"));
		console.log(`     验证码图片已保存: ${capFile}`);
		console.log(`     captchaID=${capId}`);
		if (!myCaptcha) {
			console.log("     请用 read 工具查看图片, 然后重新运行并附上: --captcha-id <id> --captcha <code>");
			return;
		}
	} else if (!myCaptcha) {
		throw new Error("提供了 --captcha-id 但缺少 --captcha <code>");
	}
	console.log("[3/6] 登录 ...");
	const sess = await panelLogin(siteAuth, { captchaID: capId, captcha: myCaptcha });
	console.log("     登录成功。");
	console.log("[4/6] 拉取 swagger 判定版本画像 ...");
	const sw = await fetchSwagger(base, sess.session);
	const profileGuess = detectProfile(sw);
	const caps = detectCapabilities(sw);
	console.log(`     profile=${profileGuess}${sw ? "" : "(swagger 不可用, 将尝试双路由)"}`);
	console.log("[5/6] 开启 API 接口并生成 Key ...");
	const genResult = await enableApiAndGenKey(siteAuth, sess, profileGuess);
	console.log(`     Key 已生成: ****${genResult.key.slice(-4)} (profile=${genResult.profile})`);
	console.log("[6/6] 签名自检 ...");
	const osInfo = await apiCall({ baseUrl: base, apiKey: genResult.key, profile: genResult.profile }, "dashboard/base/os");
	console.log(`     自检通过 (${osInfo.os} ${osInfo.kernelArch ?? ""})`);
	const s = loadSites();
	const entry = {
		key, name: name ?? key,
		baseUrl: base, apiKey: genResult.key,
		username: user, password: pw, entrance: entrance ?? "",
		profile: genResult.profile, capabilities: caps,
		hostInfo: { os: osInfo.os, kernel: osInfo.kernelVersion, arch: osInfo.kernelArch },
		notes: `add-site 自动初始化`,
		updatedAt: now(),
	};
	const existing = s.sites.find((x) => x.key === key);
	if (existing) Object.assign(existing, entry);
	else s.sites.push(entry);
	saveSites(s);
	console.log(`已保存(${SITES_FILE}) 站点 key="${key}"${name ? ` 名称="${name}"` : ""}`);
}

/* ---------- project ---------- */

function normalizeRemotePath(value) {
	if (typeof value !== "string") return value;
	// Git Bash 会把传给 Node 的 /opt/... 改写为 C:/Program Files/Git/opt/...
	const match = value.match(/^[A-Za-z]:[\\/]Program Files[\\/]Git(?:[\\/](.*))?$/i);
	return match ? `/${(match[1] ?? "").replaceAll("\\", "/")}` : value;
}

function normalizeRepoUrl(value) {
	const input = projectText(value, "远程地址");
	if (/^(?:[./~\\]|[a-zA-Z]:[\\/])/.test(input)) throw new Error("远程地址不能是本地目录");
	// 归一化 HTTPS / SSH / scp 格式，保留仓库路径大小写，避免合并不同仓库。
	const scp = input.match(/^[^/@:\s]+@([^/:\s]+):(.+)$/);
	const bare = !scp && !input.includes("://");
	// 裸 canonical 地址用无默认端口的临时协议解析，避免把 SSH :443 当作 HTTPS 默认端口吞掉。
	const source = scp ? `ssh://${scp[1]}/${scp[2]}` : bare ? `repo://${input}` : input;
	let url;
	try { url = new URL(source); } catch { throw new Error(`无效远程地址: ${input}`); }
	const repoPath = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
	if (!(bare || ["https:", "http:", "ssh:", "git:"].includes(url.protocol)) || !url.hostname || !repoPath || repoPath === "/" || url.search || url.hash || /\s|\\/.test(input)) {
		throw new Error("远程地址需要 host/owner/repo、HTTPS 或 SSH Git 地址，不接受本地目录/仓库简称");
	}
	const port = (url.protocol === "ssh:" && url.port === "22") || (url.protocol === "git:" && url.port === "9418") ? "" : url.port;
	return `${url.hostname.toLowerCase()}${port ? `:${port}` : ""}${repoPath}`;
}
function detectRemote() {
	try {
		return execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim() || null;
	} catch {
		return null;
	}
}

const PROJECT_KINDS = new Set(["website", "container", "app", "runtime"]);
const PROJECT_ID_KINDS = new Set(["website", "app", "runtime"]);

function projectText(value, label) {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 需要非空文本`);
	return value.trim();
}
function repoBasename(value) {
	return value.split("/").filter(Boolean).pop() ?? "";
}
function sameRepo(a, b) {
	try { return normalizeRepoUrl(a) === normalizeRepoUrl(b); } catch { return false; }
}
function projectSelector(args) {
	const selector = args.key ?? args.repo ?? detectRemote();
	if (!selector) throw new Error("需要 --key <项目key> 或 --repo <远程地址/名称>，当前目录没有 origin");
	return projectText(selector, "项目选择器");
}
function findProject(projects, selector) {
	const raw = projectText(selector, "项目选择器");
	const isUrl = /[/:@]/.test(raw);
	const norm = isUrl ? normalizeRepoUrl(raw) : null;
	const matches = projects.projects.filter((proj) => isUrl
		? proj.repoUrls?.some((url) => sameRepo(url, norm))
		: proj.key === raw || proj.name === raw);
	if (matches.length > 1) throw new Error(`项目匹配不唯一: ${raw}，请指定完整远程地址或唯一 key`);
	return matches[0];
}
function requireProject(projects, args) {
	const selector = projectSelector(args);
	// 显式 --key 必须只匹配 key，绝不回退到另一项目的显示名称。
	const keyMatches = args.key !== undefined ? projects.projects.filter((proj) => proj.key === selector) : null;
	if (keyMatches?.length > 1) throw new Error(`项目 key 重复: ${selector}，请先核对登记数据`);
	const proj = keyMatches ? keyMatches[0] : findProject(projects, selector);
	if (!proj) throw new Error(`未找到项目: ${selector}(先 project add 登记)`);
	return proj;
}
function buildProjectDeployment(args) {
	if (!args.site) throw new Error("项目部署关联需要 --site <站点key>");
	const kind = args.kind ?? "website";
	if (!PROJECT_KINDS.has(kind)) throw new Error(`--kind 仅支持 ${[...PROJECT_KINDS].join("|")}`);
	getSite(args.site);
	const dep = { site: args.site, kind };
	if (PROJECT_ID_KINDS.has(kind)) dep.id = projectResourceId(args.id);
	if (kind === "container") dep.container = projectText(args.container, "--container");
	if (args.domain !== undefined) dep.domain = projectText(args.domain, "--domain");
	if (args.path !== undefined) dep.path = normalizeRemotePath(projectText(args.path, "--path"));
	if (args.container !== undefined) dep.container = projectText(args.container, "--container");
	return dep;
}
function deploymentMatches(left, right) {
	if (left.site !== right.site || left.kind !== right.kind) return false;
	return right.kind === "container" ? left.container === right.container : Number(left.id) === Number(right.id);
}
function upsertProjectDeployment(proj, dep) {
	const deployments = Array.isArray(proj.deployments) ? proj.deployments : [];
	const matches = deployments.filter((item) => deploymentMatches(item, dep));
	if (matches.length > 1) throw new Error("存在重复关联，请先核对登记数据");
	const index = deployments.indexOf(matches[0]);
	if (index < 0) {
		proj.deployments = [...deployments, dep];
		return "added";
	}
	deployments[index] = { ...deployments[index], ...dep };
	proj.deployments = deployments;
	return "updated";
}
function deploymentLabel(dep) {
	return `${dep.site}/${dep.kind}${dep.id !== undefined ? `#${dep.id}` : dep.container ? `/${dep.container}` : dep.domain ? `/${dep.domain}` : ""}`;
}
function projectResourceId(value) {
	if (typeof value === "boolean" || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new Error("资源 --id 必须是正整数");
	return Number(value);
}
function ensureProjectName(name) {
	return projectText(name, "项目名称");
}
function projectHasDeploymentArgs(args) {
	return ["site", "kind", "id", "domain", "path", "container"].some((key) => args[key] !== undefined);
}
function ensureUniqueRepo(projects, norm, current) {
	const owner = projects.projects.find((proj) => proj !== current && proj.repoUrls?.some((url) => sameRepo(url, norm)));
	if (owner) throw new Error(`远程地址已属于项目 ${owner.key}，不能重复登记`);
}
function validateProjectArgs(args, sub) {
	const selector = ["key", "repo"];
	const deployment = ["site", "kind", "id", "domain", "path", "container"];
	const flags = {
		add: [...selector, "name", ...deployment, "confirm"],
		edit: [...selector, "name", "addRepo", "removeRepo", "confirm"],
		bind: [...selector, ...deployment, "confirm"],
		unbind: [...selector, "site", "kind", "id", "container", "confirm"],
		remove: [...selector, "confirm"],
		show: selector,
		list: ["site", "name", "repo"],
		check: [],
		note: [...selector, "text", "confirm"],
		refresh: [...selector, "save", "confirm"],
	};
	if (!flags[sub]) throw new Error(`project 子命令: ${Object.keys(flags).join("|")}`);
	for (const key of Object.keys(args)) {
		if (!key.startsWith("_") && args[key] !== undefined && !flags[sub].includes(key)) throw new Error(`project ${sub} 不支持参数 --${key}`);
	}
	if (args.key !== undefined && args.repo !== undefined && sub !== "add") throw new Error("--key 和 --repo 只能指定一个项目选择器");
	for (const flag of ["save", "confirm"]) {
		if (args[flag] !== undefined && typeof args[flag] !== "boolean") throw new Error(`--${flag} 只能是 true/false`);
	}
	const writes = ["add", "edit", "bind", "unbind", "remove", "note"].includes(sub) || (sub === "refresh" && args.save === true);
	if (writes && args.confirm !== true) throw new Error(`project ${sub} 会修改本地登记，请先取得用户明确授权再带 --confirm`);
}
function projectCheck(projects) {
	const sites = new Set(loadSites().sites.map((site) => site.key));
	const issues = [];
	const keys = new Set();
	const repos = new Map();
	for (const proj of projects.projects) {
		if (!proj || typeof proj !== "object") { issues.push("存在无效项目记录"); continue; }
		if (typeof proj.key !== "string" || !proj.key.trim()) issues.push("存在缺少 key 的项目");
		else if (keys.has(proj.key)) issues.push(`项目 key 重复: ${proj.key}`);
		else keys.add(proj.key);
		if (typeof proj.name !== "string" || !proj.name.trim()) issues.push(`${proj.key}: 缺少 name`);
		if (!Array.isArray(proj.repoUrls) || !proj.repoUrls.length) issues.push(`${proj.key}: 缺少 repoUrls`);
		for (const url of Array.isArray(proj.repoUrls) ? proj.repoUrls : []) {
			try {
				const norm = normalizeRepoUrl(url);
				if (repos.has(norm)) issues.push(`${proj.key}: 远程地址重复，与 ${repos.get(norm)} 冲突: ${norm}`);
				else repos.set(norm, proj.key);
			} catch (err) { issues.push(`${proj.key}: ${err.message}`); }
		}
		if (!Array.isArray(proj.deployments)) issues.push(`${proj.key}: deployments 不是数组`);
		const seen = new Set();
		for (const dep of Array.isArray(proj.deployments) ? proj.deployments : []) {
			if (!dep || typeof dep !== "object") { issues.push(`${proj.key}: 无效部署记录`); continue; }
			if (!PROJECT_KINDS.has(dep.kind)) issues.push(`${proj.key}: 未知部署类型 ${dep.kind}`);
			if (!sites.has(dep.site)) issues.push(`${proj.key}: 关联了不存在的站点 ${dep.site}`);
			if (PROJECT_ID_KINDS.has(dep.kind)) {
				try { projectResourceId(dep.id); } catch { issues.push(`${proj.key}: ${dep.kind} 缺少有效 id`); }
			}
			if (dep.kind === "container" && (typeof dep.container !== "string" || !dep.container.trim())) issues.push(`${proj.key}: container 缺少名称`);
			const identity = deploymentLabel(dep);
			if (seen.has(identity)) issues.push(`${proj.key}: 重复部署关联 ${identity}`);
			seen.add(identity);
		}
	}
	return { ok: issues.length === 0, projects: projects.projects.length, issues };
}

async function cmdProject(args) {
	const projects = loadProjects();
	const sub = args._sub;
	validateProjectArgs(args, sub);
	switch (sub) {
		case "add": {
			const repoUrl = args.repo ?? detectRemote();
			if (!repoUrl) throw new Error("无法识别 git remote, 请用 --repo <url> 指定");
			const norm = normalizeRepoUrl(repoUrl);
			const key = args.key === undefined ? repoBasename(norm) : projectText(args.key, "项目 key");
			if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(key)) throw new Error("项目 key 仅允许字母、数字、点、下划线和短横线，请用 --key 指定");
			if (projects.projects.some((proj) => proj.key === key)) throw new Error(`项目 key 已存在: ${key}，新项目请指定不同 --key；修改请用 edit/bind`);
			ensureUniqueRepo(projects, norm);
			const proj = { key, repoUrls: [norm], name: args.name === undefined ? key : ensureProjectName(args.name), deployments: [], notes: "", updatedAt: now() };
			projects.projects.push(proj);
			if (projectHasDeploymentArgs(args)) {
				if (!args.site) throw new Error("提供部署参数时必须同时指定 --site");
				const dep = buildProjectDeployment(args);
				const action = upsertProjectDeployment(proj, dep);
				appendNote(proj, `${action} deployment ${deploymentLabel(dep)}`);
			}
			proj.updatedAt = now();
			saveProjects(projects);
			print(proj);
			return;
		}
		case "edit": {
			const proj = requireProject(projects, args);
			const changes = [];
			if (args.name !== undefined) {
				const name = ensureProjectName(args.name);
				if (name !== proj.name) {
					proj.name = name;
					changes.push(`name=${name}`);
				}
			}
			const addRepo = args.addRepo;
			if (addRepo !== undefined) {
				const norm = normalizeRepoUrl(addRepo);
				ensureUniqueRepo(projects, norm, proj);
				if (!Array.isArray(proj.repoUrls)) proj.repoUrls = [];
				if (!proj.repoUrls.some((url) => sameRepo(url, norm))) {
					proj.repoUrls.push(norm);
					changes.push(`add repo=${norm}`);
				}
			}
			if (args.removeRepo !== undefined) {
				// 允许按原值删除错误地址，但不自动修复已有数据。
				const norm = projectText(args.removeRepo, "--remove-repo");
				const before = proj.repoUrls.length;
				proj.repoUrls = proj.repoUrls.filter((url) => url !== norm && !sameRepo(url, norm));
				if (proj.repoUrls.length === before) throw new Error(`项目未登记远程地址: ${args.removeRepo}`);
				if (proj.repoUrls.length === 0) throw new Error("项目至少要保留一个远程地址");
				changes.push(`remove repo=${norm}`);
			}
			if (changes.length === 0) throw new Error("project edit 需要 --name、--add-repo 或 --remove-repo");
			appendNote(proj, `edit project: ${changes.join(", ")}`);
			proj.updatedAt = now();
			saveProjects(projects);
			print(proj);
			return;
		}
		case "bind": {
			const proj = requireProject(projects, args);
			const dep = buildProjectDeployment(args);
			const action = upsertProjectDeployment(proj, dep);
			appendNote(proj, `${action} deployment ${deploymentLabel(dep)}`);
			proj.updatedAt = now();
			saveProjects(projects);
			print(proj);
			return;
		}
		case "unbind": {
			const proj = requireProject(projects, args);
			projectText(args.site, "--site");
			if (!PROJECT_KINDS.has(args.kind)) throw new Error("project unbind 需要有效 --kind");
			// 解除失效关联不要求站点仍然存在，但必须给出精确资源身份。
			const id = args.kind === "container" ? undefined : projectResourceId(args.id);
			const container = args.kind === "container" ? projectText(args.container, "--container") : undefined;
			const candidates = (proj.deployments ?? []).map((dep, index) => ({ dep, index })).filter(({ dep }) =>
				dep.site === args.site && dep.kind === args.kind && (args.kind === "container" ? dep.container === container : Number(dep.id) === id));
			if (candidates.length === 0) throw new Error(`未找到关联: ${args.site}/${args.kind}`);
			if (candidates.length > 1) throw new Error("存在重复关联，请先核对登记数据");
			const [{ dep, index }] = candidates;
			proj.deployments.splice(index, 1);
			appendNote(proj, `unbind deployment ${deploymentLabel(dep)}`);
			proj.updatedAt = now();
			saveProjects(projects);
			console.log(`已解除本地关联 ${deploymentLabel(dep)}(未删除 1Panel 资源)`);
			return;
		}
		case "remove": {
			const proj = requireProject(projects, args);
			const index = projects.projects.indexOf(proj);
			projects.projects.splice(index, 1);
			saveProjects(projects);
			console.log(`已删除项目登记 ${proj.key}(未删除任何 1Panel 资源)`);
			return;
		}
		case "show":
			print(requireProject(projects, args));
			return;
		case "list": {
			let result = projects.projects;
			if (args.site !== undefined) {
				const site = projectText(args.site, "--site");
				result = result.filter((proj) => proj.deployments?.some((dep) => dep.site === site));
			}
			if (args.name !== undefined) {
				const name = projectText(args.name, "--name");
				result = result.filter((proj) => proj.name?.includes(name) || proj.key?.includes(name));
			}
			if (args.repo !== undefined) {
				const norm = normalizeRepoUrl(args.repo);
				result = result.filter((proj) => proj.repoUrls?.some((url) => sameRepo(url, norm)));
			}
			// 列表只给摘要，避免把所有项目的部署历史塞进上下文。
			print({ total: result.length, projects: result.map(({ key, name, repoUrls, deployments }) => ({ key, name, repoUrls, deployments })) });
			return;
		}
		case "check": {
			const result = projectCheck(projects);
			print(result);
			if (!result.ok) process.exitCode = 1;
			return;
		}
		case "note": {
			const proj = requireProject(projects, args);
			const text = projectText(args.text, "--text");
			appendNote(proj, text);
			saveProjects(projects);
			console.log(`已记录到 ${proj.key}: ${args.text}`);
			return;
		}
		case "refresh": {
			const proj = requireProject(projects, args);
			const errors = [];
			for (const dep of proj.deployments ?? []) {
				try {
					const st = getSite(dep.site);
					const signal = AbortSignal.timeout(TIMEOUT_MS);
					if (dep.kind === "website") {
						const detail = await apiCall(st, `websites/${projectResourceId(dep.id)}`, { signal });
						if (!detail || typeof detail !== "object") throw new Error("网站详情为空");
						dep.domain = detail.primaryDomain ?? dep.domain;
						// sitePath 不是运行时 CODE_DIR/部署目录，不覆盖人工确认的 path。
						dep.sitePath = detail.sitePath ?? dep.sitePath;
						dep.status = detail.status ?? dep.status;
						dep.appName = detail.appName ?? dep.appName;
					} else {
						const endpoint = { container: "containers/search", runtime: "runtimes/search", app: "apps/installed/search" }[dep.kind];
						if (!endpoint) throw new Error(`不支持的部署类型 ${dep.kind}`);
						if (dep.kind === "container") projectText(dep.container, "container");
						else projectResourceId(dep.id);
						let item;
						for (let page = 1; page <= 100; page++) {
							const body = dep.kind === "container" ? searchBody("containers", { page, pageSize: 200, name: dep.container }) : { page, pageSize: 200 };
							const list = await apiCall(st, endpoint, { method: "POST", body, signal });
							if (!Array.isArray(list?.items)) throw new Error("资源列表格式不正确");
							item = list.items.find((resource) => dep.kind === "container" ? resource.name === dep.container : Number(resource.id ?? resource.installId) === Number(dep.id));
							if (item || !list.items.length || (list.total != null ? page * 200 >= Number(list.total) : list.items.length < 200)) break;
						}
						if (!item) throw new Error("资源未找到，关联未自动删除");
						dep.name = item.name ?? dep.name;
						dep.status = item.status ?? item.state ?? dep.status;
						if (dep.kind === "container") dep.image = item.imageName ?? dep.image;
						if (dep.kind === "runtime") dep.codeDir = item.codeDir ?? dep.codeDir;
					}
					dep.updatedAt = now();
				} catch (err) {
					errors.push({ deployment: deploymentLabel(dep), error: err.message.slice(0, 200) });
				}
			}
			// 部分失败不落盘，防止把旧状态当成一次成功刷新；查询也不追加 notes。
			const saved = args.save === true && errors.length === 0;
			if (saved) { proj.updatedAt = now(); saveProjects(projects); }
			print({ saved, project: proj, errors });
			if (errors.length) process.exitCode = 1;
			return;
		}
		default:
			throw new Error("project 子命令: add|edit|bind|unbind|remove|show|list|check|note|refresh");
	}
}

async function cmdSiteNote(args) {
	if (!args.text) throw new Error("site note 需要 --text");
	const s = loadSites();
	const t = s.sites.find((x) => x.key === args.site);
	if (!t) throw new Error(`未找到站点: ${args.site}`);
	appendNote(t, args.text);
	saveSites(s);
	console.log(`已记录到站点 ${args.site}: ${args.text}`);
}

/* ============================== 参数解析 & 主入口 ============================== */

const HELP = `panel1 CLI —— 多站点 1Panel 管理
用法: node client.mjs <命令> [<位置参数>] [选项]

命令:
  list                                                   列出所有站点
  status --site <key>                                    连接自检(自动刷新 hostInfo)
  add-site --key <k> --url <url> --user <u> [--name n] [--entrance c]
           [--password pw|--password-env VAR] [--captcha-id id --captcha code]
           首次运行会输出验证码图片路径(模型用 read 读取后带参数重跑完成初始化)
  query <模块> --site <key> [--id N] [--name x] [--page 1] [--pageSize 50] [--type t]
           模块: dashboard|websites|website(需--id)|containers|apps|cronjobs|runtimes|databases|groups|acme|ssl
  logs <类型> --site <key> (类型参数见下)
           logs website --name <网站名> [--tail 100]
           logs panel   [--type operation|login]
  operate <对象> --site <key> --action <动作> [--confirm]
           对象/动作: container(--names n1,n2: start|restart|stop|pause|unpause|kill*|remove*)
                      website(--id: start|restart|stop|delete*)
                      app(--install-id N: start|restart|stop|upgrade|delete*)
                      runtime(--id: start|restart|stop|delete*)
           *=危险操作, 必须 --confirm(先向用户说明方案并确认)
  create <对象> --site <key> --confirm        (基础原子命令, 全部必须 --confirm)
           runtime --name n --port 19001 --appDetailId 172 --image 1panel-php-fpm:7.3.33 [--version 7.3.33] [--type php|node|go]
           website --domain xxx.com --runtimeId N [--alias a] [--groupId 1] [--ipv6 true]
           website --domain xxx.com --type static [--alias a] [--groupId 1] [--ipv6 true]
           database --name db --username u --password p [--type mysql|postgresql] [--format utf8mb4] [--collation utf8mb4_general_ci] [--permission %%]
           acme --email x@y.com
           ssl --domain xxx.com --acmeId N [--provider http|dnsAccount] [--dns-account-id N] [--keyType EC256] [--autoRenew true]
  configure https --site <key> --websiteId N --sslId N --confirm
           [--httpConfig HTTPSOnly|HTTPAlso|HTTPToHTTPS] [--hsts true]
  rewrite get --site <key> --websiteId N [--name current]
  rewrite set --site <key> --websiteId N --content-file <文件> --confirm
  project list [--name <关键词>] [--site <key>] [--repo <完整远程地址>]
  project show [--key <key>|--repo <完整远程地址/名称>]
  project check                                          只读检查登记结构与站点引用
  project add [--repo <url>] [--key <唯一key>] [--name <名称>] --confirm
           [--site k --kind website|container|app|runtime --id N --domain d --path p --container c]
           (仅新建；缺省读取当前 origin，key 默认仓库名；可不绑定部署)
  project edit --key <key> [--name n] [--add-repo url] [--remove-repo url] --confirm
  project bind --key <key> --site k --kind website|container|app|runtime --confirm
           --id N (website/runtime/app) 或 --container c (container) [--domain d] [--path p]
           (同一资源更新本地绑定；不会操作远端资源)
  project unbind --key <key> --site k --kind <kind> --id N|--container c --confirm
  project remove --key <key> --confirm                     仅删除登记、关联和备注
  project note --key <key> --text "..." --confirm
  project refresh --key <key> [--save --confirm]           默认只查询，不回写
           (--key 可换 --repo，省略选择器时只取当前 origin；不按同名仓库猜测)
           (所有项目写命令须用户明确授权；删除/解绑须说明范围并再次确认)
  site note --site <key> --text "..."
  api --site <k> --path runtimes/update --method POST --body '<json>' [--confirm]
           (低层直通: 仅用于 CLI 尚未封装的面板接口; 非 GET 必须 --confirm)
  site chown --site <k> --websiteId N --user 1000 --group 1000 --confirm
           (把网站 index 目录 chown -R 为 user:group, 修复 PHP 容器 Access denied)
  files upload --site <k> --file <本地文件> --path <远端目录> [--name n]
  files decompress --site <k> --path <压缩包> --dst <目标目录> [--type zip|tar.gz]
  files wget --site <k> --url <x> --path <目录> [--name n]
  files cat --site <k> --path <文件>              (读取单个文件内容)
  files save --site <k> --path <文件> --content <文本>|--file <本地文件>  (写入文件)
  files mkdir --site <k> --path <目录>            (创建远端目录)
  files ls --site <k> --path <目录>
  files del --site <k> --path <文件或目录> --confirm
           (危险: 递归删除, 必须 --confirm; 删除前先说明将删的路径清单)
  (部署流: 本地构建产物 zip → files upload → files decompress → operate runtime/container restart)
`;

/* ---------- files: 文件管理(部署链路核心: 上传/解压/服务器下载) ---------- */

async function cmdApi(args) {
	const st = getSite(args.site);
	if (!args.path) throw new Error("api 需要 --path <接口路径> (相对 /api/v2，如 runtimes/update)");
	const method = String(args.method ?? "GET").toUpperCase();
	if (!new Set(["GET", "POST", "PUT", "DELETE"]).has(method)) throw new Error("api --method 支持 GET|POST|PUT|DELETE");
	let body;
	if (args.body !== undefined) {
		try { body = typeof args.body === "string" ? JSON.parse(args.body) : args.body; }
		catch { throw new Error("api --body 需要合法 JSON"); }
	}
	if (method !== "GET" && args.confirm !== true) {
		throw new Error("api 非 GET 请求为写操作: 先核实接口路径与 body, 再带 --confirm 执行。");
	}
	const data = await apiCall(st, args.path, { method, body });
	print(data ?? {});
}

async function cmdFiles(args) {
	const sub = args._sub;
	const st = getSite(args.site);
	args.path = normalizeRemotePath(args.path);
	args.dst = normalizeRemotePath(args.dst);
	if (sub === "upload") {
		if (!args.file || !args.path) throw new Error("files upload 需要 --file <本地文件> --path <远端目录> [--name 重命名]");
		const { readFileSync, statSync } = await import("node:fs");
		const fileBuf = readFileSync(args.file);
		const fileName = args.name ?? fileBuf.name ?? args.file.split(/[\\/]/).pop();
		const fd = new FormData();
		fd.append("file", new Blob([fileBuf]), fileName);
		// 表单附加字段(按面板前端约定)
		for (const [k, v] of Object.entries({ path: args.path, name: fileName, taskID: "" })) fd.append(k, v);
		const baseUrl = st.baseUrl.replace(/\/+$/, "");
		const ts = String(Math.floor(Date.now() / 1000));
		const token = createHash("md5").update(`1panel${st.apiKey}${ts}`).digest("hex");
		const resp = await fetch(`${baseUrl}/api/v2/files/upload`, {
			method: "POST",
			headers: { "1Panel-Timestamp": ts, "1Panel-Token": token },
			body: fd,
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const raw = await resp.text();
		let j;
		try { j = JSON.parse(raw); } catch { throw new Error(`上传响应非 JSON: ${raw.slice(0, 200)}`); }
		if ((j.code ?? 0) !== 0 && j.code !== 200) throw new Error(`上传失败: ${j.msg ?? j.message}`);
		console.log(`已上传 ${args.file} → ${args.path}/${fileName}`);
		print(j.data ?? {});
		return;
	}
	if (sub === "decompress") {
		if (!args.path || !args.dst) throw new Error("files decompress 需要 --path <压缩包路径> --dst <目标目录> [--type zip|tar.gz|...]");
		const type = args.type ?? (args.path.endsWith(".zip") ? "zip" : args.path.endsWith(".gz") || args.path.endsWith(".tar.gz") ? "tar.gz" : "zip");
		const data = await apiCall(st, "files/decompress", { method: "POST", body: { path: args.path, dst: args.dst, type, secret: args.secret ?? "", taskID: "" } });
		console.log(`解压任务已提交: ${args.path} → ${args.dst} (type=${type})`);
		console.log("返回:", JSON.stringify(data ?? {}).slice(0, 300));
		return;
	}
	if (sub === "wget") {
		if (!args.url || !args.path) throw new Error("files wget 需要 --url <x> --path <目录> [--name <n>]");
		const data = await apiCall(st, "files/wget", { method: "POST", body: { url: args.url, name: args.name ?? "", path: args.path, ignoreCertificate: false, useProxy: false } });
		console.log("wget 任务已提交:", JSON.stringify(data ?? {}).slice(0, 200));
		console.log("(进度可在面板文件页查看, 或稍后 refresh 检查)");
		return;
	}
	if (sub === "del") {
		if (!args.path) throw new Error("files del 需要 --path <文件或目录>");
		if (args.confirm !== true) throw new Error("危险操作(files del 递归删除)必须显式 --confirm。先向用户说明方案并确认后再执行。");
		// 1Panel 删除端点随版本差异: files/del(body path) / files/batch/delete(body paths) / files/delete; 按 profile 依次尝试(见 version-compat.md)
		const tryPaths = st.profile === "current" ? ["files/del", "files/batch/delete", "files/delete"] : ["files/delete", "files/del", "files/batch/delete"];
		let lastErr;
		for (const p of tryPaths) {
			try {
				const opts = p === "files/batch/delete"
					? { method: "POST", body: { paths: [args.path], secret: "" } }
					: { method: "POST", body: { path: args.path, secret: "" } };
				const data = await apiCall(st, p, opts);
				console.log(`已删除: ${args.path}`);
				print(data ?? {});
				return;
			} catch (err) {
				lastErr = err;
				if (!String(err.message).includes("404")) throw err;
			}
		}
		throw new Error(`删除失败(尝试 ${tryPaths.join("|")}): ${lastErr?.message}`);
	}
	if (sub === "mkdir") {
		// 创建目录(files 创建接口: 1Panel v2 POST /files, body.path+isDir=true)
		if (!args.path) throw new Error("files mkdir 需要 --path <目录>");
		const data = await apiCall(st, "files", { method: "POST", body: { path: args.path, content: "", isDir: true, mode: 0, isLink: false, isSymlink: false, linkPath: "", sub: false } });
		console.log(`已创建目录: ${args.path}`);
		print(data ?? {});
		return;
	}
	if (sub === "ls") {
		if (!args.path) throw new Error("files ls 需要 --path <目录>");
		const body = { path: args.path, page: 1, pageSize: 200, sortBy: "name", sortOrder: "asc", expand: true };
		if (args.search) { body.search = args.search; body.containSub = true; } // 递归文件名搜索(find -name)
		if (args.container) body.container = args.container; // 容器内文件
		const data = await apiCall(st, "files/search", { method: "POST", body });
		if (Array.isArray(data?.items) && data.items.length) print(data.items);
		else if (data?.itemTotal > 0) print(data.items ?? data);
		else print(data);
		return;
	}
	if (sub === "tree") {
		// 只读: 列出目录树(files/tree)
		if (!args.path) throw new Error("files tree 需要 --path <目录>");
		const data = await apiCall(st, "files/tree", { method: "POST", body: { path: args.path } });
		print(data);
		return;
	}
	if (sub === "cat") {
		// 只读: 读取单个文件内容(files/content)
		if (!args.path) throw new Error("files cat 需要 --path <文件>");
		const body = { path: args.path };
		if (args.container) body.container = args.container; // 容器内文件
		const data = await apiCall(st, "files/content", { method: "POST", body });
		if (typeof data === "string") return console.log(data);
		if (data && typeof data.content === "string") return console.log(data.content);
		print(data);
		return;
	}
	if (sub === "save") {
		// 写文件(files/save): --path <文件> --content <文本> 或 --file <本地文件>
		if (!args.path) throw new Error("files save 需要 --path <文件> 且 --content 或 --file 之一");
		let content = args.content;
		if (content === undefined && args.file !== undefined) {
			content = (await import("node:fs")).readFileSync(args.file, "utf8");
		}
		if (content === undefined) throw new Error("files save 需要 --content <文本> 或 --file <本地文件>");
		const data = await apiCall(st, "files/save", { method: "POST", body: { path: args.path, content } });
		console.log(`已保存: ${args.path}`);
		print(data ?? {});
		return;
	}
	throw new Error("files 子命令: upload|decompress|wget|ls|mkdir|cat|save");
}

function parseArgs(argv) {
	const flags = {};
	const positionals = [];
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i];
		if (tok === "-h" || tok === "--help") return { help: true };
		if (tok.startsWith("-")) {
			// --password-env → passwordEnv (驼峰), 兼容大小写 ID 变体
			let key = tok.replace(/^--?/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
			key = key.replace(/^Id$/, "ID");
			const next = argv[i + 1];
			// 数学验证码答案可能是负数(如 -24)，不能当成新 flag
			const nextIsValue = next !== undefined && (!next.startsWith("-") || /^-\d+(\.\d+)?$/.test(next));
			if (nextIsValue) {
				flags[key] = /^(true|false)$/.test(next) ? next === "true" : next;
				i++;
			} else {
				flags[key] = true;
			}
		} else {
			positionals.push(tok);
		}
	}
	return { flags, positionals };
}

async function main() {
	const raw = process.argv.slice(2);
	const { help, flags, positionals } = parseArgs(raw);
	if (help || positionals.length === 0) {
		console.log(HELP);
		return;
	}
	const cmd = positionals[0];
	if (cmd === "project" && positionals.length > 2) throw new Error("project 不接受额外位置参数，请用 --key 或 --repo 指定项目");
	const args = { ...flags, _cmd: cmd, _sub: positionals[1] };
	// 别名归一: --captcha-id 用户可能写 captchaID/captchaId 两种大小写
	args.captchaID = args.captchaID ?? args.captchaId;
	args.installId = args.installId ?? args.installID;
	switch (cmd) {
		case "list": return cmdList();
		case "status": return cmdStatus(args);
		case "add-site": return cmdAddSite(args);
		case "query": return cmdQuery(args);
		case "logs": return cmdLogs(args);
		case "operate": return cmdOperate(args);
		case "create": return cmdCreate(args);
		case "configure": return cmdConfigure(args);
		case "rewrite": return cmdRewrite(args);
		case "site":
			if (args._sub === "chown") return cmdSiteChown(args);
			if (args._sub === "note") return cmdSiteNote(args);
			throw new Error(`site 子命令: chown|note`);
		case "files": return cmdFiles(args);
		case "api": return cmdApi(args);
		case "project": return cmdProject(args);
		default:
			console.log(HELP);
			throw new Error(`未知命令: ${cmd}`);
	}
}

main().catch((err) => {
	console.error(`[ERROR] ${err.message}`);
	process.exit(1);
});
