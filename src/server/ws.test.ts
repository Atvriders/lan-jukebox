import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StationSnapshot } from "../types/index.js";
import { PlayerRegistry } from "../players/registry.js";
import { isAllowedOrigin, StationBroadcaster, registerWebsocket, type Send } from "./ws.js";

const SNAP: StationSnapshot = {
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
  paused: true,
  preparing: null,
  activePlayerPresent: false,
  activePlayerLabel: null,
};

describe("isAllowedOrigin", () => {
  it("accepts an exact match", () => {
    expect(isAllowedOrigin("https://radio.waterburp.com", ["https://radio.waterburp.com"])).toBe(
      true,
    );
  });
  it("rejects a mismatch and undefined", () => {
    expect(isAllowedOrigin("https://evil.example", ["https://radio.waterburp.com"])).toBe(false);
    expect(isAllowedOrigin(undefined, ["https://radio.waterburp.com"])).toBe(false);
  });
});

describe("StationBroadcaster fan-out", () => {
  it("broadcasts to every subscriber and stops after unsubscribe", () => {
    const b = new StationBroadcaster();
    const a = vi.fn<Send>();
    const c = vi.fn<Send>();
    b.subscribe(a);
    b.subscribe(c);
    b.broadcast({ type: "trackError", videoId: "v1", title: "T", reason: "blocked" });
    expect(a).toHaveBeenCalledWith({
      type: "trackError",
      videoId: "v1",
      title: "T",
      reason: "blocked",
    });
    expect(c).toHaveBeenCalledTimes(1);
    b.unsubscribe(a);
    b.broadcast({ type: "trackError", videoId: "v2", title: "T2", reason: "x" });
    expect(a).toHaveBeenCalledTimes(1); // not called again
    expect(c).toHaveBeenCalledTimes(2);
  });

  it("a throwing (dead) subscriber does not abort fan-out to the rest, and is pruned", () => {
    const b = new StationBroadcaster();
    const dead = vi.fn(() => {
      throw new Error("EPIPE: socket already closed");
    }) as unknown as Send;
    const alive = vi.fn<Send>();
    b.subscribe(dead);
    b.subscribe(alive);
    const msg = { type: "trackError", videoId: "v1", title: "T", reason: "x" } as const;
    expect(() => b.broadcast(msg)).not.toThrow();
    expect(alive).toHaveBeenCalledTimes(1);
    // the dead socket was pruned; a subsequent broadcast never calls it again
    (dead as unknown as ReturnType<typeof vi.fn>).mockClear();
    b.broadcast(msg);
    expect(dead).not.toHaveBeenCalled();
    expect(alive).toHaveBeenCalledTimes(2);
  });
});

describe("StationBroadcaster.attach", () => {
  it("broadcasts {type:'state'} on each station 'changed', once per attach", () => {
    const station = new EventEmitter() as EventEmitter & { snapshot: () => StationSnapshot };
    station.snapshot = () => SNAP;
    const b = new StationBroadcaster();
    const sub = vi.fn<Send>();
    b.subscribe(sub);
    b.attach(station as never);
    b.attach(station as never); // idempotent — must not double-wire
    station.emit("changed");
    expect(sub).toHaveBeenCalledTimes(1);
    expect(sub).toHaveBeenCalledWith({ type: "state", state: SNAP });
  });
});

// Minimal sink stub matching BrowserPlayerSink's structural surface used by the handler.
function makeFakeSinkFactory() {
  const sinks: Array<{
    send: Send;
    emit: ReturnType<typeof vi.fn>;
    relinquish: ReturnType<typeof vi.fn>;
  }> = [];
  const factory = (send: Send) => {
    const sink = { send, emit: vi.fn(), relinquish: vi.fn(), setSend: vi.fn() };
    sinks.push(sink);
    return sink as never;
  };
  return { factory, sinks };
}

async function boot(opts: { authed: boolean }) {
  const app = Fastify();
  await app.register(fastifyWebsocket);
  // fake session: decorate request.session before the ws handler runs
  app.addHook("onRequest", async (req) => {
    (req as { session?: { authed?: boolean; deviceId?: string; displayName?: string } }).session = {
      authed: opts.authed,
      deviceId: "d1",
      displayName: "PC",
    };
  });
  const station = Object.assign(new EventEmitter(), {
    snapshot: () => SNAP,
    attachSink: vi.fn(),
    detachSink: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    reportPosition: vi.fn(),
  });
  const b = new StationBroadcaster();
  const dir = mkdtempSync(join(tmpdir(), "lj-ws-"));
  const registry = new PlayerRegistry({ dir, station: station as never, now: () => 1 });
  await registry.init();
  const sinkFactory = makeFakeSinkFactory();
  registerWebsocket(app as never, {
    broadcaster: b,
    registry,
    allowedOrigins: ["http://localhost"],
    makeSink: sinkFactory.factory,
    station: station as never,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { app, url: `ws://127.0.0.1:${port}/ws`, station, registry, sinkFactory, broadcaster: b };
}

function openHello(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { origin: "http://localhost" } });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", deviceId: "d1", role: "remote" }));
      resolve(ws);
    });
    ws.on("error", reject);
  });
}

describe("origin guard exact-path matching", () => {
  async function bootHttp() {
    const app = Fastify();
    await app.register(fastifyWebsocket);
    const station = Object.assign(new EventEmitter(), {
      snapshot: () => SNAP,
      attachSink: vi.fn(),
      detachSink: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
      reportPosition: vi.fn(),
    });
    const dir = mkdtempSync(join(tmpdir(), "lj-ws-origin-"));
    const registry = new PlayerRegistry({ dir, station: station as never, now: () => 1 });
    await registry.init();
    const sinkFactory = makeFakeSinkFactory();
    registerWebsocket(app as never, {
      broadcaster: new StationBroadcaster(),
      registry,
      allowedOrigins: ["http://localhost"],
      makeSink: sinkFactory.factory,
      station: station as never,
    });
    // A sibling HTTP route whose URL merely starts with "/ws" — must NOT inherit
    // the WS origin guard. Registered before listen() so inject() can reach it.
    app.get("/wsstatus", async () => ({ ok: true }));
    return app;
  }

  it("does NOT 403 a /ws-prefixed sibling HTTP route lacking an allowed Origin", async () => {
    const app = await bootHttp();
    try {
      const res = await app.inject({ method: "GET", url: "/wsstatus" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it("still 403s the exact /ws upgrade path when the Origin is not allowed", async () => {
    const app = await bootHttp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/ws",
        headers: { origin: "https://evil.example" },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

describe("registerWebsocket integration", () => {
  let h: Awaited<ReturnType<typeof boot>> | null = null;
  afterEach(async () => {
    await h?.app.close();
    h = null;
  });

  it("rejects a bad Origin with 403 (handshake fails)", async () => {
    h = await boot({ authed: true });
    const ws = new WebSocket(h.url, { headers: { origin: "https://evil.example" } });
    const code = await new Promise<number | string>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("error", (e) => resolve(String(e)));
      ws.on("open", () => resolve("open"));
    });
    expect(code).toBe(403);
  });

  it("closes an unauthenticated socket with 1008", async () => {
    h = await boot({ authed: false });
    const ws = new WebSocket(h.url, { headers: { origin: "http://localhost" } });
    const closeCode = await new Promise<number>((resolve) => {
      ws.on("close", (c) => resolve(c));
    });
    expect(closeCode).toBe(1008);
  });

  it("hello touches the device, runs auto-select, and the socket received an initial state", async () => {
    h = await boot({ authed: true });
    const seen: unknown[] = [];
    const ws = await openHello(h.url);
    ws.on("message", (d) => seen.push(JSON.parse(d.toString())));
    await new Promise((r) => setTimeout(r, 50));
    // touch persisted the device with the session label
    expect(h.registry.activePlayerDeviceId).toBeNull(); // d1 not preferred yet -> no auto-select
    // initial state frame was pushed on subscribe
    ws.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.some((m) => (m as { type?: string }).type === "state")).toBe(true);
  });

  it("becomePlayer claims the active player and attaches the socket sink", async () => {
    h = await boot({ authed: true });
    const ws = await openHello(h.url);
    ws.send(JSON.stringify({ type: "becomePlayer" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(h.registry.activePlayerDeviceId).toBe("d1");
    expect(h.station.attachSink).toHaveBeenCalledWith(h.sinkFactory.sinks[0]);
    ws.close();
  });

  it("trackEnded emits 'trackEnd' on the per-socket sink", async () => {
    h = await boot({ authed: true });
    const ws = await openHello(h.url);
    ws.send(JSON.stringify({ type: "trackEnded" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(h.sinkFactory.sinks[0]?.emit).toHaveBeenCalledWith("trackEnd");
    ws.close();
  });

  it("position telemetry reaches station.reportPosition", async () => {
    h = await boot({ authed: true });
    const ws = await openHello(h.url);
    ws.send(JSON.stringify({ type: "position", ms: 4242 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(h.station.reportPosition).toHaveBeenCalledWith(4242);
    ws.close();
  });

  it("close runs onDisconnect + unsubscribe (no further broadcasts to the dead socket)", async () => {
    h = await boot({ authed: true });
    const ws = await openHello(h.url);
    ws.send(JSON.stringify({ type: "becomePlayer" }));
    await new Promise((r) => setTimeout(r, 30));
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.registry.activePlayerDeviceId).toBeNull(); // disconnect nulled the active player
    // The send closure was unsubscribed: the broadcaster holds no subscribers,
    // and a post-close broadcast reaches nobody and never throws.
    expect((h.broadcaster as unknown as { subs: Set<unknown> }).subs.size).toBe(0);
    expect(() =>
      h!.broadcaster.broadcast({ type: "trackError", videoId: "v", title: "t", reason: "x" }),
    ).not.toThrow();
  });

  it("relinquishPlayer releases the active player back to null", async () => {
    h = await boot({ authed: true });
    const ws = await openHello(h.url);
    ws.send(JSON.stringify({ type: "becomePlayer" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(h.registry.activePlayerDeviceId).toBe("d1");
    ws.send(JSON.stringify({ type: "relinquishPlayer" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(h.registry.activePlayerDeviceId).toBeNull();
    ws.close();
  });

  it("registers no recurring interval (no 30s revalidation)", async () => {
    const spy = vi.spyOn(global, "setInterval");
    h = await boot({ authed: true });
    const ws = await openHello(h.url);
    await new Promise((r) => setTimeout(r, 30));
    // Only Fastify/ws internals may set intervals; our handler must add none keyed to /ws auth.
    const ourIntervals = spy.mock.calls.filter(([, ms]) => ms === 30000 || ms === 30_000);
    expect(ourIntervals).toHaveLength(0);
    ws.close();
    spy.mockRestore();
  });
});
