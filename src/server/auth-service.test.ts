import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "./auth-service.js";

const PASSWORD = "jarvis-test-password";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

let directory: string;
let authPath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jarvis-auth-test-"));
  authPath = join(directory, "auth.json");
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(directory, { force: true, recursive: true });
});

async function createService(): Promise<AuthService> {
  const auth = new AuthService(authPath);
  await auth.initialize();
  return auth;
}

describe("AuthService", () => {
  it("starts disabled and lets everything through", async () => {
    const auth = await createService();

    expect(auth.enabled()).toBe(false);
    expect(auth.status(undefined)).toEqual({ required: false, authenticated: true });
    expect(auth.verifyToken("anything")).toEqual({ state: "valid" });
  });

  it("stores only a salted scrypt hash", async () => {
    const auth = await createService();
    const { token } = await auth.setPassword(PASSWORD);

    expect(auth.enabled()).toBe(true);
    const stored = JSON.parse(await readFile(authPath, "utf8")) as { password: { hash: string; salt: string } };
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    expect(Buffer.from(stored.password.hash, "base64")).toHaveLength(32);
    expect(await auth.verifyPassword(PASSWORD)).toBe(true);
    expect(await auth.verifyPassword(`${PASSWORD}!`)).toBe(false);
    expect(auth.status(token)).toEqual({ required: true, authenticated: true });
  });

  it("rejects forged, tampered and stale tokens", async () => {
    const auth = await createService();
    // 未启用认证时签发的会话，在启用后因版本号不同而失效。
    const before = await auth.login(PASSWORD, "127.0.0.1");
    if (!before.ok) throw new Error("Expected an unrestricted login");
    await auth.setPassword(PASSWORD);
    const session = await auth.login(PASSWORD, "127.0.0.1");
    if (!session.ok) throw new Error("Expected a successful login");

    expect(auth.verifyToken(session.session.token).state).toBe("valid");
    expect(auth.verifyToken(`${session.session.token}x`).state).toBe("invalid");
    expect(auth.verifyToken(session.session.token.split(".")[0] ?? "").state).toBe("invalid");
    expect(auth.verifyToken("not-a-token").state).toBe("invalid");
    expect(auth.verifyToken(undefined).state).toBe("invalid");
    expect(auth.verifyToken(before.session.token).state).toBe("invalid");

    await auth.revokeAllSessions();
    expect(auth.verifyToken(session.session.token).state).toBe("invalid");
  });

  it("keeps sessions valid across a restart", async () => {
    const auth = await createService();
    await auth.setPassword(PASSWORD);
    const session = await auth.login(PASSWORD, "127.0.0.1");
    if (!session.ok) throw new Error("Expected a successful login");

    const restarted = await createService();
    expect(restarted.enabled()).toBe(true);
    expect(restarted.verifyToken(session.session.token).state).toBe("valid");
  });

  it("renews a session once it is older than a day", async () => {
    const auth = await createService();
    await auth.setPassword(PASSWORD);
    const session = await auth.login(PASSWORD, "127.0.0.1");
    if (!session.ok) throw new Error("Expected a successful login");

    expect(auth.verifyToken(session.session.token)).toEqual({ state: "valid" });

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    const renewed = auth.verifyToken(session.session.token);
    expect(renewed.state).toBe("valid");
    if (renewed.state !== "valid" || renewed.token === undefined) throw new Error("Expected a renewed session");
    expect(renewed.token).not.toBe(session.session.token);
    expect(auth.verifyToken(renewed.token)).toEqual({ state: "valid" });

    // 超过有效期后必须重新登录。
    vi.setSystemTime(Date.now() + TTL_MS);
    expect(auth.verifyToken(renewed.token).state).toBe("invalid");
  });

  it("backs off repeated failures per client", async () => {
    const auth = await createService();
    await auth.setPassword(PASSWORD);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(auth.login("wrong-password", "10.0.0.1")).resolves.toEqual({ ok: false, reason: "invalid" });
    }
    const locked = await auth.login("wrong-password", "10.0.0.1");
    expect(locked).toMatchObject({ ok: false, reason: "locked" });

    // 锁定期内即使密码正确也被拒绝；其他来源不受影响。
    expect(await auth.login(PASSWORD, "10.0.0.1")).toMatchObject({ ok: false, reason: "locked" });
    expect((await auth.login(PASSWORD, "10.0.0.2")).ok).toBe(true);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000);
    expect((await auth.login(PASSWORD, "10.0.0.1")).ok).toBe(true);
  });

  it("guards password changes and can disable authentication", async () => {
    const auth = await createService();
    await auth.setPassword(PASSWORD);

    await expect(auth.setPassword("next-password-value")).rejects.toMatchObject({ code: "AUTH_INVALID_PASSWORD" });
    await expect(auth.setPassword("next-password-value", "wrong-password")).rejects.toMatchObject({ code: "AUTH_INVALID_PASSWORD" });
    await expect(auth.setPassword("short", PASSWORD)).rejects.toMatchObject({ code: "AUTH_PASSWORD_TOO_SHORT" });

    const rotated = await auth.setPassword("next-password-value", PASSWORD);
    expect(rotated.token).toBeDefined();
    expect(await auth.verifyPassword("next-password-value")).toBe(true);

    await auth.setPassword(null, "next-password-value");
    expect(auth.enabled()).toBe(false);
    expect(auth.status(undefined)).toEqual({ required: false, authenticated: true });
  });

  it("reports an unsupported config instead of silently disabling authentication", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(authPath, JSON.stringify({ version: 99 }), "utf8");
    await expect(createService()).rejects.toMatchObject({ code: "AUTH_CONFIG_INVALID" });
  });
});
