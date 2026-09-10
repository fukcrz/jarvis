import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AuthStatus } from "../shared/protocol.js";
import { AppError } from "./errors.js";

/** 浏览器会话 Cookie 名。 */
export const AUTH_COOKIE_NAME = "jarvis_auth";
/** 登录有效期：7 天，滑动过期（有访问就自动续期）。 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 距上次签发超过 24 小时才重发 Cookie，避免每个请求都 Set-Cookie。 */
const RENEW_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;

const SCRYPT_KEY_LENGTH = 32;
/** N=2^15 需要 128*N*r ≈ 33.5MB，必须放宽 Node 默认 32MB 的 maxmem。 */
const SCRYPT_OPTIONS = { N: 32_768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;

const FREE_FAILED_ATTEMPTS = 3;
const FAILURE_BASE_DELAY_MS = 5_000;
const FAILURE_MAX_DELAY_MS = 15 * 60 * 1000;
const FAILURE_ENTRY_TTL_MS = 60 * 60 * 1000;

interface StoredPassword {
  salt: string;
  hash: string;
  updatedAt: string;
}

interface StoredAuth {
  version: 1;
  /** HMAC 签名密钥（base64）；不落明文密码，改密码时轮换。 */
  secret: string;
  /** 递增后旧会话全部失效（改密码 / 退出所有设备）。 */
  tokenVersion: number;
  password: StoredPassword | null;
}

interface TokenPayload {
  v: number;
  iat: number;
  exp: number;
}

interface FailureRecord {
  count: number;
  until: number;
  updatedAt: number;
}

export interface AuthSession {
  token: string;
  expiresAt: string;
}

export type AuthLoginOutcome =
  | { ok: true; session: AuthSession }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "locked"; retryAfterMs: number };

export type AuthTokenState =
  /** valid：已认证；带 token 表示已续期，调用方应重发 Cookie。 */
  | { state: "valid"; token?: string }
  | { state: "invalid" };

/**
 * 单用户口令认证：密码（scrypt）存 ~/.jarvis/auth.json，
 * 会话用 HMAC 无状态 token（服务重启不掉线），滑动续期。
 * 未设置密码时认证未启用，行为与旧版本一致（不拦截任何请求）。
 */
export class AuthService {
  private readonly authPath: string;
  private stored: StoredAuth | undefined;
  private readonly failures = new Map<string, FailureRecord>();
  /** scrypt 串行队列：并发登录不占满 libuv 线程池（一次哈希约 100ms）。 */
  private scryptQueue: Promise<unknown> = Promise.resolve();

  constructor(authPath = join(process.env["JARVIS_HOME"] ?? join(homedir(), ".jarvis"), "auth.json")) {
    this.authPath = authPath;
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.authPath), { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.authPath, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.stored = createEmptyAuth();
      await this.persist();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new AppError("AUTH_CONFIG_INVALID", `认证配置不是合法 JSON：${this.authPath}`, 500);
    }
    this.stored = parseStoredAuth(parsed, this.authPath);
  }

  /** 是否已启用认证（设置了密码）。 */
  enabled(): boolean {
    return this.state().password !== null;
  }

  status(token: string | undefined): AuthStatus {
    if (!this.enabled()) return { required: false, authenticated: true };
    return { required: true, authenticated: this.verifyToken(token).state === "valid" };
  }

  /** 校验并（必要时）续期会话。未启用认证时一律放行。 */
  verifyToken(token: string | undefined): AuthTokenState {
    const stored = this.state();
    if (stored.password === null) return { state: "valid" };
    if (token === undefined || token === "") return { state: "invalid" };
    const payload = this.readToken(token, stored);
    if (payload === undefined) return { state: "invalid" };
    if (payload.v !== stored.tokenVersion || payload.exp <= Date.now()) return { state: "invalid" };
    if (Date.now() - payload.iat >= RENEW_INTERVAL_MS) return { state: "valid", token: this.issueSession(stored).token };
    return { state: "valid" };
  }

  async verifyPassword(password: string): Promise<boolean> {
    const stored = this.state().password;
    if (stored === null) return false;
    const expected = Buffer.from(stored.hash, "base64");
    const derived = await this.deriveQueued(password, Buffer.from(stored.salt, "base64"));
    return expected.length === derived.length && timingSafeEqual(expected, derived);
  }

  /** 登录：失败按来源地址指数退避，避免暴力破解。 */
  async login(password: string, clientKey: string): Promise<AuthLoginOutcome> {
    const stored = this.state();
    if (stored.password === null) return { ok: true, session: this.issueSession(stored) };
    const remaining = this.lockRemaining(clientKey);
    if (remaining > 0) return { ok: false, reason: "locked", retryAfterMs: remaining };
    if (!(await this.verifyPassword(password))) {
      this.recordFailure(clientKey);
      return { ok: false, reason: "invalid" };
    }
    this.failures.delete(clientKey);
    return { ok: true, session: this.issueSession(stored) };
  }

  /**
   * 设置、修改或关闭认证（next = null 表示关闭）。
   * 已启用认证时必须提供正确当前密码；成功后会签发本设备的新会话。
   */
  async setPassword(next: string | null, current?: string): Promise<{ token?: string }> {
    const stored = this.state();
    if (stored.password !== null) {
      if (current === undefined || current === "" || !(await this.verifyPassword(current))) {
        throw new AppError("AUTH_INVALID_PASSWORD", "当前密码不正确", 401);
      }
    }
    if (next === null) {
      this.stored = { ...createEmptyAuth(stored.tokenVersion + 1), password: null };
      await this.persist();
      return {};
    }
    validatePassword(next);
    const salt = randomBytes(16);
    const hash = await this.deriveQueued(next, salt);
    this.stored = {
      version: 1,
      // 改密码同时轮换签名密钥与版本号：所有旧会话立即失效。
      secret: randomBytes(32).toString("base64"),
      tokenVersion: stored.tokenVersion + 1,
      password: { salt: salt.toString("base64"), hash: hash.toString("base64"), updatedAt: new Date().toISOString() },
    };
    await this.persist();
    return { token: this.issueSession(this.stored).token };
  }

  /** 退出所有设备：递增版本号，已签发的会话全部失效。 */
  async revokeAllSessions(): Promise<void> {
    const stored = this.state();
    this.stored = { ...createEmptyAuth(stored.tokenVersion + 1), password: stored.password };
    await this.persist();
  }

  private state(): StoredAuth {
    if (this.stored === undefined) throw new AppError("AUTH_NOT_INITIALIZED", "认证服务尚未初始化", 500);
    return this.stored;
  }

  /** 串行化的 scrypt：排队执行，避免并发登录打满线程池。 */
  private deriveQueued(password: string, salt: Buffer): Promise<Buffer> {
    const task = this.scryptQueue.then(() => deriveKey(password, salt), () => deriveKey(password, salt));
    this.scryptQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private issueSession(stored: StoredAuth, now = Date.now()): AuthSession {
    const payload: TokenPayload = { v: stored.tokenVersion, iat: now, exp: now + SESSION_TTL_MS };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", Buffer.from(stored.secret, "base64")).update(encoded).digest("base64url");
    return { token: `${encoded}.${signature}`, expiresAt: new Date(payload.exp).toISOString() };
  }

  private readToken(token: string, stored: StoredAuth): TokenPayload | undefined {
    const separator = token.lastIndexOf(".");
    if (separator <= 0) return undefined;
    const encoded = token.slice(0, separator);
    const expected = createHmac("sha256", Buffer.from(stored.secret, "base64")).update(encoded).digest("base64url");
    const provided = Buffer.from(token.slice(separator + 1), "utf8");
    const wanted = Buffer.from(expected, "utf8");
    if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) return undefined;
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    } catch {
      return undefined;
    }
    if (typeof payload !== "object" || payload === null) return undefined;
    const record = payload as Record<string, unknown>;
    const { v, iat, exp } = record;
    if (typeof v !== "number" || typeof iat !== "number" || typeof exp !== "number") return undefined;
    if (!Number.isFinite(v) || !Number.isFinite(iat) || !Number.isFinite(exp)) return undefined;
    return { v, iat, exp };
  }

  private lockRemaining(clientKey: string): number {
    const record = this.failures.get(clientKey);
    if (record === undefined) return 0;
    if (record.updatedAt + FAILURE_ENTRY_TTL_MS < Date.now()) {
      this.failures.delete(clientKey);
      return 0;
    }
    return Math.max(0, record.until - Date.now());
  }

  private recordFailure(clientKey: string): void {
    this.pruneFailures();
    const previous = this.failures.get(clientKey);
    const count = (previous?.count ?? 0) + 1;
    const delay = count <= FREE_FAILED_ATTEMPTS
      ? 0
      : Math.min(FAILURE_MAX_DELAY_MS, FAILURE_BASE_DELAY_MS * (2 ** (count - FREE_FAILED_ATTEMPTS - 1)));
    this.failures.set(clientKey, { count, until: Date.now() + delay, updatedAt: Date.now() });
  }

  private pruneFailures(): void {
    const deadline = Date.now() - FAILURE_ENTRY_TTL_MS;
    for (const [key, record] of this.failures) if (record.updatedAt < deadline) this.failures.delete(key);
  }

  private async persist(): Promise<void> {
    const stored = this.state();
    const temporary = `${this.authPath}.${String(process.pid)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(stored, undefined, 2)}\n`, "utf8");
    await rename(temporary, this.authPath);
  }
}

/** 认证配置缺失时的默认内容（无密码 = 未启用认证）。 */
function createEmptyAuth(tokenVersion = 1): StoredAuth {
  return { version: 1, secret: randomBytes(32).toString("base64"), tokenVersion, password: null };
}

function parseStoredAuth(value: unknown, path: string): StoredAuth {
  const invalid = (): never => { throw new AppError("AUTH_CONFIG_INVALID", `认证配置格式不受支持：${path}`, 500); };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  if (record["version"] !== 1) return invalid();
  const { secret, tokenVersion, password } = record;
  if (typeof secret !== "string" || secret === "" || typeof tokenVersion !== "number" || !Number.isInteger(tokenVersion)) return invalid();
  if (password === null || password === undefined) return { version: 1, secret, tokenVersion, password: null };
  if (typeof password !== "object" || Array.isArray(password)) return invalid();
  const stored = password as Record<string, unknown>;
  if (typeof stored["salt"] !== "string" || typeof stored["hash"] !== "string") return invalid();
  return {
    version: 1,
    secret,
    tokenVersion,
    password: {
      salt: stored["salt"],
      hash: stored["hash"],
      updatedAt: typeof stored["updatedAt"] === "string" ? stored["updatedAt"] : new Date().toISOString(),
    },
  };
}

export function validatePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) throw new AppError("AUTH_PASSWORD_TOO_SHORT", `密码至少 ${String(MIN_PASSWORD_LENGTH)} 位`, 400);
  if (password.length > MAX_PASSWORD_LENGTH) throw new AppError("AUTH_PASSWORD_TOO_LONG", `密码不能超过 ${String(MAX_PASSWORD_LENGTH)} 位`, 400);
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS, (error, derived) => {
      if (error !== null) reject(error);
      else resolve(derived);
    });
  });
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown })["code"] === "ENOENT";
}
