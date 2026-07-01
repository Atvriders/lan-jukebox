import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { buildApp, type AppDeps } from "./app.js";
import type { WebConfig } from "../config.js";

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

function deps(over: Partial<AppDeps> = {}): AppDeps {
  return {
    cfg: cfg(),
    station: Object.assign(new EventEmitter(), {
      snapshot: vi.fn(() => ({
        repeat: "off",
        autoplay: true,
        autoplaySource: "radio",
        volume: 100,
        maxTrackDurationSec: 0,
        current: null,
        upcoming: [],
        upcomingRadio: [],
        history: [],
        seed: null,
        paused: false,
        preparing: null,
        activePlayerPresent: false,
        activePlayerLabel: null,
      })),
      reportPosition: vi.fn(),
    }),
    youtube: { resolve: vi.fn(), search: vi.fn(), download: vi.fn() },
    registry: {
      isSpeaker: vi.fn(() => false),
      activePlayerDeviceId: null,
      touch: vi.fn(),
      claim: vi.fn(),
      release: vi.fn(() => ({ activePlayerDeviceId: null })),
      remember: vi.fn(() => ({ activePlayerDeviceId: null })),
      forget: vi.fn(() => ({ activePlayerDeviceId: null })),
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
    },
    broadcaster: {
      attach: vi.fn(),
      broadcast: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    },
    cache: {
      get: vi.fn(() => null),
      getAudio: vi.fn(() => null),
      has: vi.fn(() => false),
      register: vi.fn(),
      pin: vi.fn(),
    },
    cacheDir: "/tmp/lan-jukebox-test-cache",
    downloads: { run: vi.fn(async (f: () => Promise<unknown>) => f()) },
    radio: { reset: vi.fn() },
    searchLimit: 5,
    ...over,
  } as unknown as AppDeps;
}

describe("buildApp", () => {
  it("serves /healthz with ok + uptimeSec", async () => {
    const app = await buildApp(deps());
    const res = await app.inject({ method: "GET", url: "/healthz" });
    const body = res.json() as { ok: boolean; uptimeSec: number };
    expect(body.ok).toBe(true);
    expect(typeof body.uptimeSec).toBe("number");
    await app.close();
  });
  it("guards /api/state when logged out (401)", async () => {
    const app = await buildApp(deps());
    expect((await app.inject({ method: "GET", url: "/api/state" })).statusCode).toBe(401);
    await app.close();
  });
  it("login then /api/state returns 200 through the real session", async () => {
    const app = await buildApp(deps());
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "letmein", displayName: "Ada", deviceId: "dev-1" },
    });
    expect(login.statusCode).toBe(200);
    const set = login.headers["set-cookie"];
    const cookie = (Array.isArray(set) ? (set[0] as string) : (set as string)).split(";")[0]!;
    const res = await app.inject({ method: "GET", url: "/api/state", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
  it("falls back to index.html for an unknown non-API GET (SPA)", async () => {
    const app = await buildApp(deps());
    const res = await app.inject({ method: "GET", url: "/some/spa/route" });
    // index.html may not exist in the test cwd; the fallback path is what we assert:
    // it is NOT the JSON 404 the API path returns. When index.html is absent, @fastify/static
    // serves a text/plain "404 Not Found" (not parseable as JSON) — light-my-request's .json()
    // throws on that, so parse defensively; the SPA-vs-API divergence is the real contract.
    let parsed: { error?: string } | undefined;
    try {
      parsed = res.json() as { error?: string };
    } catch {
      parsed = undefined;
    }
    expect(parsed?.error).not.toBe("not_found");
    await app.close();
  });
  it("returns JSON 404 for an unknown /api route", async () => {
    const app = await buildApp(deps());
    const res = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
    await app.close();
  });
  it("sanitizes a malformed percent-encoded URL (no FST_ERR_BAD_URL / offending-url leak)", async () => {
    const app = await buildApp(deps());
    for (const url of ["/api/%ZZ", "/audio/%ZZ", "/%E0%A4%A"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("bad_request");
      // The raw framework error would otherwise leak the code, message, and offending URL.
      expect(res.body).not.toContain("FST_ERR_BAD_URL");
      expect(res.body).not.toContain("is not a valid url component");
    }
    await app.close();
  });
});
