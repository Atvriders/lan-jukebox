import { describe, it, expect, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import { MemorySessionStore } from "../auth/session-store.js";
import { registerAuthRoutes } from "../auth/password.js";
import { registerRest, type RestDeps } from "./rest.js";
import { YtError, YtErrorKind } from "../youtube/errors.js";
import type { WebConfig } from "../config.js";

const meta = (id: string, title = id) => ({
  videoId: id,
  title,
  channel: "c",
  durationSec: 100,
  isLive: false,
  thumbnailUrl: null,
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

function fakeStation() {
  return {
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
    enqueue: vi.fn(async () => ({ id: "i1" })),
    pause: vi.fn(),
    resume: vi.fn(),
    skip: vi.fn(),
    seek: vi.fn(async () => true),
    setVolume: vi.fn(),
    shuffle: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    remove: vi.fn(async () => true),
    reorder: vi.fn(async () => true),
    jump: vi.fn(async () => true),
    updateSettings: vi.fn((p: Record<string, unknown>) => ({
      repeat: "off",
      autoplay: true,
      autoplaySource: "radio",
      volume: 100,
      maxTrackDurationSec: 0,
      ...p,
    })),
  };
}
function fakeRegistry() {
  // REST /api/speaker reaches only the sink-free actions; claim is WS-only (needs a socket sink).
  return {
    activePlayerDeviceId: null as string | null,
    isSpeaker: vi.fn((d: string) => d === "dev-1"),
    release: vi.fn(() => ({ activePlayerDeviceId: null })),
    remember: vi.fn((d: string) => ({ activePlayerDeviceId: d })),
    forget: vi.fn(() => ({ activePlayerDeviceId: null })),
  };
}
function fakeRadio() {
  return { reset: vi.fn() };
}

async function build(over: Partial<RestDeps> = {}, c = cfg()) {
  const station = fakeStation();
  const registry = fakeRegistry();
  const youtube = {
    resolve: vi.fn(async (id: string) => meta(id)),
    search: vi.fn(async () => [meta("aaaaaaaaaaa")]),
  };
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
  const deps = {
    station,
    youtube,
    registry,
    radio: fakeRadio(),
    searchLimit: 5,
    cfg: c,
    ...over,
  } as unknown as RestDeps;
  registerRest(app, deps);
  return { app, station, registry, youtube, deps };
}

async function login(app: FastifyInstance, c = cfg(), deviceId = "dev-1"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { password: c.viewerPassword, displayName: "Ada", deviceId },
  });
  const set = res.headers["set-cookie"];
  const raw = Array.isArray(set) ? (set[0] as string) : (set as string);
  return raw.split(";")[0]!;
}

describe("GET /api/state", () => {
  it("401s when logged out", async () => {
    const { app } = await build();
    expect((await app.inject({ method: "GET", url: "/api/state" })).statusCode).toBe(401);
    await app.close();
  });
  it("returns the snapshot + isThisDeviceSpeaker for the session device", async () => {
    const { app, registry } = await build();
    const c = await login(app);
    const res = await app.inject({ method: "GET", url: "/api/state", headers: { cookie: c } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.seed).toBeNull();
    expect(body.isThisDeviceSpeaker).toBe(true);
    expect(registry.isSpeaker).toHaveBeenCalledWith("dev-1");
    await app.close();
  });
});

describe("POST /api/add", () => {
  it("queues a YouTube link, resets the radio de-dup window, returns queued", async () => {
    const { app, station, youtube, deps } = await build();
    const c = await login(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/add",
      headers: { cookie: c },
      payload: { urlOrQuery: "https://youtu.be/dQw4w9WgXcQ" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().queued).toEqual({ id: "i1", title: "dQw4w9WgXcQ" });
    expect(youtube.resolve).toHaveBeenCalledWith("dQw4w9WgXcQ");
    expect(station.enqueue).toHaveBeenCalledOnce();
    expect(
      (deps as unknown as { radio: { reset: ReturnType<typeof vi.fn> } }).radio.reset,
    ).toHaveBeenCalledOnce();
    await app.close();
  });
  it("returns search candidates for a free-text query", async () => {
    const { app } = await build();
    const c = await login(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/add",
      headers: { cookie: c },
      payload: { urlOrQuery: "lofi beats" },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().candidates)).toBe(true);
    await app.close();
  });
  it("400s an over-long input", async () => {
    const { app } = await build();
    const c = await login(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/add",
      headers: { cookie: c },
      payload: { urlOrQuery: "x".repeat(2001) },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
  it("400s a search YtError with the kind (not stderr)", async () => {
    const youtube = {
      resolve: vi.fn(async (id: string) => meta(id)),
      search: vi.fn(async () => {
        throw new YtError(YtErrorKind.Private, "raw stderr");
      }),
    };
    const b = await build({ youtube } as never);
    const bc = await login(b.app);
    const res = await b.app.inject({
      method: "POST",
      url: "/api/add",
      headers: { cookie: bc },
      payload: { urlOrQuery: "anything" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("private");
    await b.app.close();
  });
});

describe("POST /api/pick", () => {
  it("400s a malformed candidateId", async () => {
    const { app } = await build();
    const c = await login(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/pick",
      headers: { cookie: c },
      payload: { candidateId: "nope" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
  it("400s an enqueue YtError with the kind (never the stderr-bearing message)", async () => {
    const station = fakeStation();
    station.enqueue = vi.fn(async () => {
      throw new YtError(
        YtErrorKind.TooLong,
        "yt-dlp failed (too_long): /home/kasm-user/.config secret path leak stderr blob",
      );
    });
    const { app } = await build({ station } as never);
    const c = await login(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/pick",
      headers: { cookie: c },
      payload: { candidateId: "dQw4w9WgXcQ" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("too_long");
    expect(res.body).not.toContain("/home/kasm-user");
    await app.close();
  });
  it("enqueues a valid candidateId", async () => {
    const { app, station } = await build();
    const c = await login(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/pick",
      headers: { cookie: c },
      payload: { candidateId: "dQw4w9WgXcQ" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().queued.id).toBe("i1");
    expect(station.enqueue).toHaveBeenCalledOnce();
    await app.close();
  });
});

describe("POST /api/control", () => {
  it("pause/resume/skip return ok and call the station", async () => {
    const { app, station } = await build();
    const c = await login(app);
    for (const action of ["pause", "play", "skip"] as const) {
      const res = await app.inject({
        method: "POST",
        url: "/api/control",
        headers: { cookie: c },
        payload: { action },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    }
    expect(station.pause).toHaveBeenCalled();
    expect(station.resume).toHaveBeenCalled();
    expect(station.skip).toHaveBeenCalled();
    await app.close();
  });
  it("seek 409s when nothing is playing", async () => {
    const { app } = await build();
    const c = await login(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/control",
      headers: { cookie: c },
      payload: { action: "seek", value: 1000 },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });
  it("seek 400s past the track duration", async () => {
    const station = fakeStation();
    station.snapshot.mockReturnValue({
      repeat: "off",
      autoplay: true,
      autoplaySource: "radio",
      volume: 100,
      maxTrackDurationSec: 0,
      current: {
        id: "x",
        meta: meta("vvvvvvvvvvv"),
        requester: { deviceId: "d", displayName: "n", source: "user" },
        addedAt: 0,
        audio: null,
        fromRadio: false,
        positionMs: 0,
        durationMs: 100000,
      },
      upcoming: [],
      upcomingRadio: [],
      history: [],
      seed: null,
      paused: false,
      preparing: null,
      activePlayerPresent: true,
      activePlayerLabel: "PC",
    } as never);
    const { app } = await build({ station } as never);
    const c = await login(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/control",
      headers: { cookie: c },
      payload: { action: "seek", value: 999999 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
  it("400s an out-of-range volume", async () => {
    const { app } = await build();
    const c = await login(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/control",
      headers: { cookie: c },
      payload: { action: "volume", value: 9999 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
  it("400s an invalid repeat value", async () => {
    const { app } = await build();
    const c = await login(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/control",
      headers: { cookie: c },
      payload: { action: "repeat", value: "weird" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
  it("400s remove/jump with a missing itemId", async () => {
    const { app } = await build();
    const c = await login(app);
    for (const action of ["remove", "jump"] as const) {
      const res = await app.inject({
        method: "POST",
        url: "/api/control",
        headers: { cookie: c },
        payload: { action },
      });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });
});

describe("POST /api/speaker", () => {
  it("remember returns ok + the active player id, keyed on the session device", async () => {
    const { app, registry } = await build();
    const c = await login(app, cfg(), "dev-9");
    const res = await app.inject({
      method: "POST",
      url: "/api/speaker",
      headers: { cookie: c },
      payload: { action: "remember" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, activePlayerDeviceId: "dev-9" });
    expect(registry.remember).toHaveBeenCalledWith("dev-9");
    await app.close();
  });
  it("release/forget dispatch to the registry keyed on the session device", async () => {
    const { app, registry } = await build();
    const c = await login(app, cfg(), "dev-9");
    for (const action of ["release", "forget"] as const) {
      const res = await app.inject({
        method: "POST",
        url: "/api/speaker",
        headers: { cookie: c },
        payload: { action },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    }
    expect(registry.release).toHaveBeenCalledWith("dev-9");
    expect(registry.forget).toHaveBeenCalledWith("dev-9");
    await app.close();
  });
  it("400s the WS-only 'claim' action (claim happens over the WS becomePlayer frame)", async () => {
    const { app } = await build();
    const c = await login(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/speaker",
      headers: { cookie: c },
      payload: { action: "claim" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
  it("400s an unknown speaker action", async () => {
    const { app } = await build();
    const c = await login(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/speaker",
      headers: { cookie: c },
      payload: { action: "zonk" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("GET /api/lyrics", () => {
  it("returns {lyrics:null} when nothing is playing", async () => {
    const { app } = await build();
    const c = await login(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/lyrics?trackId=abc",
      headers: { cookie: c },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ lyrics: null, source: "lyrics.ovh" });
    await app.close();
  });
  it("calls the injected lyrics resolver for the current track", async () => {
    const station = fakeStation();
    station.snapshot.mockReturnValue({
      repeat: "off",
      autoplay: true,
      autoplaySource: "radio",
      volume: 100,
      maxTrackDurationSec: 0,
      current: {
        id: "x",
        meta: meta("vvvvvvvvvvv", "Song"),
        requester: { deviceId: "d", displayName: "n", source: "user" },
        addedAt: 0,
        audio: null,
        fromRadio: false,
        positionMs: 0,
        durationMs: 1000,
      },
      upcoming: [],
      upcomingRadio: [],
      history: [],
      seed: null,
      paused: false,
      preparing: null,
      activePlayerPresent: true,
      activePlayerLabel: "PC",
    } as never);
    const lyrics = vi.fn(async () => ({ lyrics: "la la", source: "lyrics.ovh" }));
    const { app } = await build({ station, lyrics } as never);
    const c = await login(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/lyrics?trackId=vvvvvvvvvvv",
      headers: { cookie: c },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lyrics).toBe("la la");
    expect(lyrics).toHaveBeenCalledWith(expect.objectContaining({ videoId: "vvvvvvvvvvv" }));
    await app.close();
  });
});
