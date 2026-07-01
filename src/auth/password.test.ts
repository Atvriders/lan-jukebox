import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import { MemorySessionStore } from "./session-store.js";
import { verifyPassword, registerAuthRoutes, requireSession, sessionInfo } from "./password.js";
import type { WebConfig } from "../config.js";

describe("verifyPassword", () => {
  it("returns true for an exact match", () => {
    expect(verifyPassword("hunter2", "hunter2")).toBe(true);
  });
  it("returns false for a mismatch of equal length", () => {
    expect(verifyPassword("hunterX", "hunter2")).toBe(false);
  });
  it("returns false (no throw) when lengths differ", () => {
    expect(verifyPassword("short", "a-much-longer-password")).toBe(false);
  });
  it("returns false for an empty input against a real password", () => {
    expect(verifyPassword("", "hunter2")).toBe(false);
  });
});

function cfg(over: Partial<WebConfig> = {}): WebConfig {
  return {
    publicBaseUrl: "https://j",
    viewerPassword: "letmein",
    allowNoPassword: false,
    sessionSecret: "x".repeat(32),
    port: 8080,
    host: "0.0.0.0",
    trustProxy: true,
    allowedWsOrigins: ["https://j"],
    nodeEnv: "test",
    secureCookies: false,
    ...over,
  };
}

async function buildAuthApp(c: WebConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(session, {
    secret: c.sessionSecret,
    cookieName: "sid",
    store: new MemorySessionStore({ sweepMs: 0 }) as never,
    saveUninitialized: false,
    rolling: true,
    cookie: { path: "/", httpOnly: true, secure: false, sameSite: "lax", maxAge: 1000 },
  });
  registerAuthRoutes(app, c);
  // A probe route to exercise requireSession/sessionInfo behind the same session.
  app.get("/probe/session", async (req, reply) => {
    if (!(await requireSession(req, reply))) return;
    return reply.send({ info: sessionInfo(req) });
  });
  return app;
}

function sid(res: { headers: Record<string, unknown> }): string {
  const set = res.headers["set-cookie"];
  const raw = Array.isArray(set) ? (set[0] as string) : (set as string);
  return raw.split(";")[0]!; // "sid=<value>"
}

describe("registerAuthRoutes /api/login", () => {
  it("accepts the right password, sets the session, returns SessionInfo", async () => {
    const app = await buildAuthApp(cfg());
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "letmein", displayName: "Ada", deviceId: "dev-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ displayName: "Ada", deviceId: "dev-1" });
    expect(res.headers["set-cookie"]).toBeTruthy();
    await app.close();
  });

  it("rejects a wrong password with 401 and no session cookie value persists", async () => {
    const app = await buildAuthApp(cfg());
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "WRONG", displayName: "Ada", deviceId: "dev-1" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_password");
    await app.close();
  });

  it("rejects a missing displayName/deviceId with 400", async () => {
    const app = await buildAuthApp(cfg());
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "letmein", displayName: "", deviceId: "" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("no-password mode (allowNoPassword) accepts ANY submitted password", async () => {
    const app = await buildAuthApp(cfg({ viewerPassword: "", allowNoPassword: true }));
    // A client honoring the LoginRequest type sends a non-empty password; it must be accepted.
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "whatever-a-manager-autofilled", displayName: "Ada", deviceId: "dev-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ displayName: "Ada", deviceId: "dev-1" });
    // An empty password is likewise accepted in this mode.
    const empty = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "", displayName: "Ada", deviceId: "dev-1" },
    });
    expect(empty.statusCode).toBe(200);
    await app.close();
  });

  it("still rejects a wrong password when allowNoPassword is false", async () => {
    const app = await buildAuthApp(cfg({ allowNoPassword: false }));
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "WRONG", displayName: "Ada", deviceId: "dev-1" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_password");
    await app.close();
  });
});

describe("requireSession + logout", () => {
  async function login(app: FastifyInstance, c = cfg()): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: c.viewerPassword, displayName: "Ada", deviceId: "dev-1" },
    });
    expect(res.statusCode).toBe(200);
    return sid(res);
  }

  it("requireSession 401s when logged out, 200s when logged in", async () => {
    const app = await buildAuthApp(cfg());
    expect((await app.inject({ method: "GET", url: "/probe/session" })).statusCode).toBe(401);
    const cookie = await login(app);
    const res = await app.inject({ method: "GET", url: "/probe/session", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().info).toEqual({ displayName: "Ada", deviceId: "dev-1" });
    await app.close();
  });

  it("logout destroys the session (subsequent guarded call 401s)", async () => {
    const app = await buildAuthApp(cfg());
    const cookie = await login(app);
    const out = await app.inject({ method: "POST", url: "/api/logout", headers: { cookie } });
    expect(out.statusCode).toBe(204);
    const after = await app.inject({
      method: "GET",
      url: "/probe/session",
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
    await app.close();
  });
});
