import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StationSnapshot } from "../types/index.js";
import { getRootLogger } from "../util/logger.js";
import { DEVICE_REGISTRY_FILE, readDeviceRegistry } from "./persist.js";
import { MAX_DEVICES, PlayerRegistry } from "./registry.js";

function makeStation() {
  return {
    attachSink: vi.fn(),
    detachSink: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    snapshot: vi.fn<() => StationSnapshot>(),
  };
}
function makeSink() {
  return { relinquish: vi.fn() };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lj-registry-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("PlayerRegistry.touch", () => {
  it("upserts a device with label + lastSeen and persists it", async () => {
    const reg = new PlayerRegistry({ dir, station: makeStation(), now: () => 5000 });
    await reg.init();
    reg.touch("d1", "Living Room PC");
    const file = await readDeviceRegistry(dir);
    expect(file?.devices).toEqual([
      { deviceId: "d1", label: "Living Room PC", lastSeen: 5000, isPreferredSpeaker: false },
    ]);
  });
});

describe("PlayerRegistry.claim (manual designate)", () => {
  it("attaches the new sink, resumes, and exposes the active device + label", async () => {
    const station = makeStation();
    const reg = new PlayerRegistry({ dir, station, now: () => 1 });
    await reg.init();
    reg.touch("d1", "Speaker PC");
    const sink = makeSink();
    reg.claim("d1", sink);
    expect(reg.activePlayerDeviceId).toBe("d1");
    expect(reg.activePlayerLabel).toBe("Speaker PC");
    expect(reg.isSpeaker("d1")).toBe(true);
    expect(station.attachSink).toHaveBeenCalledWith(sink);
    expect(station.resume).toHaveBeenCalledTimes(1);
  });

  it("tells the previous player to relinquish and detaches before reattaching", async () => {
    const station = makeStation();
    const reg = new PlayerRegistry({ dir, station, now: () => 1 });
    await reg.init();
    const sinkA = makeSink();
    const sinkB = makeSink();
    reg.claim("dA", sinkA);
    reg.claim("dB", sinkB);
    expect(sinkA.relinquish).toHaveBeenCalledTimes(1);
    expect(sinkB.relinquish).not.toHaveBeenCalled();
    expect(station.detachSink).toHaveBeenCalled();
    expect(reg.activePlayerDeviceId).toBe("dB");
    expect(reg.isSpeaker("dA")).toBe(false);
  });
});

describe("PlayerRegistry.release / remember / forget", () => {
  it("release clears the active player and pauses the station (preserved)", async () => {
    const station = makeStation();
    const reg = new PlayerRegistry({ dir, station, now: () => 1 });
    await reg.init();
    const sink = makeSink();
    reg.claim("d1", sink);
    reg.release("d1");
    expect(reg.activePlayerDeviceId).toBeNull();
    expect(reg.activePlayerLabel).toBeNull();
    expect(sink.relinquish).toHaveBeenCalledTimes(1);
    expect(station.detachSink).toHaveBeenCalled();
    expect(station.pause).toHaveBeenCalled();
  });

  it("release by a non-active device is a no-op", async () => {
    const station = makeStation();
    const reg = new PlayerRegistry({ dir, station, now: () => 1 });
    await reg.init();
    reg.claim("d1", makeSink());
    station.pause.mockClear();
    reg.release("dX");
    expect(reg.activePlayerDeviceId).toBe("d1");
    expect(station.pause).not.toHaveBeenCalled();
  });

  it("remember sets isPreferredSpeaker and persists; forget clears it", async () => {
    const reg = new PlayerRegistry({ dir, station: makeStation(), now: () => 7 });
    await reg.init();
    reg.touch("d1", "PC");
    reg.remember("d1");
    expect((await readDeviceRegistry(dir))?.devices[0]?.isPreferredSpeaker).toBe(true);
    reg.forget("d1");
    expect((await readDeviceRegistry(dir))?.devices[0]?.isPreferredSpeaker).toBe(false);
  });
});

describe("PlayerRegistry.onConnect (auto-select device memory)", () => {
  it("auto-designates a preferred speaker when no player is active", async () => {
    const station = makeStation();
    const reg = new PlayerRegistry({ dir, station, now: () => 1 });
    await reg.init();
    reg.touch("d1", "Speaker PC");
    reg.remember("d1");
    const sink = makeSink();
    reg.onConnect("d1", sink);
    expect(reg.activePlayerDeviceId).toBe("d1");
    expect(station.attachSink).toHaveBeenCalledWith(sink);
    expect(station.resume).toHaveBeenCalled();
  });

  it("does NOT auto-select a non-preferred device", async () => {
    const station = makeStation();
    const reg = new PlayerRegistry({ dir, station, now: () => 1 });
    await reg.init();
    reg.touch("d2", "Phone");
    reg.onConnect("d2", makeSink());
    expect(reg.activePlayerDeviceId).toBeNull();
    expect(station.attachSink).not.toHaveBeenCalled();
  });

  it("does NOT steal the player when one is already active", async () => {
    const station = makeStation();
    const reg = new PlayerRegistry({ dir, station, now: () => 1 });
    await reg.init();
    reg.touch("d1", "Speaker PC");
    reg.remember("d1");
    reg.touch("d3", "Other PC");
    reg.remember("d3");
    reg.claim("d3", makeSink()); // d3 already playing
    station.attachSink.mockClear();
    reg.onConnect("d1", makeSink()); // d1 preferred, but a player is active
    expect(reg.activePlayerDeviceId).toBe("d3");
    expect(station.attachSink).not.toHaveBeenCalled();
  });

  it("survives a restart: init() reloads isPreferredSpeaker so the next connect auto-selects", async () => {
    const station1 = makeStation();
    const reg1 = new PlayerRegistry({ dir, station: station1, now: () => 1 });
    await reg1.init();
    reg1.touch("d1", "Speaker PC");
    reg1.remember("d1");
    // fresh process
    const station2 = makeStation();
    const reg2 = new PlayerRegistry({ dir, station: station2, now: () => 2 });
    await reg2.init();
    reg2.onConnect("d1", makeSink());
    expect(reg2.activePlayerDeviceId).toBe("d1");
    expect(station2.attachSink).toHaveBeenCalled();
  });
});

describe("PlayerRegistry.onDisconnect", () => {
  it("active player disconnect -> null + station paused (preserved)", async () => {
    const station = makeStation();
    const reg = new PlayerRegistry({ dir, station, now: () => 1 });
    await reg.init();
    reg.claim("d1", makeSink());
    station.detachSink.mockClear();
    reg.onDisconnect("d1");
    expect(reg.activePlayerDeviceId).toBeNull();
    expect(station.detachSink).toHaveBeenCalled();
    expect(station.pause).toHaveBeenCalled();
  });

  it("does NOT relinquish on disconnect (the socket is already gone)", async () => {
    const reg = new PlayerRegistry({ dir, station: makeStation(), now: () => 1 });
    await reg.init();
    const sink = makeSink();
    reg.claim("d1", sink);
    sink.relinquish.mockClear();
    reg.onDisconnect("d1");
    expect(sink.relinquish).not.toHaveBeenCalled();
  });

  it("disconnect of a non-active device is a no-op", async () => {
    const station = makeStation();
    const reg = new PlayerRegistry({ dir, station, now: () => 1 });
    await reg.init();
    reg.claim("d1", makeSink());
    station.pause.mockClear();
    reg.onDisconnect("dX");
    expect(reg.activePlayerDeviceId).toBe("d1");
    expect(station.pause).not.toHaveBeenCalled();
  });

  it("page reload: a stale OLD-socket close (same deviceId, superseded sink) does NOT kill the newly-claimed session", async () => {
    const station = makeStation();
    const reg = new PlayerRegistry({ dir, station, now: () => 1 });
    await reg.init();
    const sinkOld = makeSink();
    reg.claim("d1", sinkOld);
    const sinkNew = makeSink();
    reg.claim("d1", sinkNew); // reload swaps in a fresh sink (no early-return: sink differs)
    station.pause.mockClear();
    station.detachSink.mockClear();
    reg.onDisconnect("d1", sinkOld); // stale close from the OLD socket
    expect(reg.activePlayerDeviceId).toBe("d1"); // still active
    expect(station.pause).not.toHaveBeenCalled();
    expect(station.detachSink).not.toHaveBeenCalled();
  });

  it("disconnect of the currently-active sink still tears down (sink-scoped match)", async () => {
    const station = makeStation();
    const reg = new PlayerRegistry({ dir, station, now: () => 1 });
    await reg.init();
    const sink = makeSink();
    reg.claim("d1", sink);
    station.pause.mockClear();
    reg.onDisconnect("d1", sink);
    expect(reg.activePlayerDeviceId).toBeNull();
    expect(station.pause).toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// Regression: persist() must NEVER throw out of touch/remember/forget — a
// registry-write failure (read-only/immutable volume, ENOSPC, EACCES) would
// otherwise reach process.on('uncaughtException') and exit(1), killing the
// always-playing station. Best-effort persistence: log-and-continue.
// --------------------------------------------------------------------------
describe("PlayerRegistry persist crash-safety (station NEVER stops)", () => {
  // Turning the target path into a DIRECTORY makes the atomic rename() onto it
  // fail (EISDIR / ENOTEMPTY) — a filesystem-independent way to force a persist
  // write failure without needing a truly read-only volume in the test sandbox.
  async function breakTarget(): Promise<void> {
    const target = join(dir, DEVICE_REGISTRY_FILE);
    await rm(target, { recursive: true, force: true });
    await mkdir(target);
  }

  it("touch() logs-and-continues (does NOT throw) when persist fails", async () => {
    const errSpy = vi.spyOn(getRootLogger(), "error").mockImplementation(() => getRootLogger());
    const reg = new PlayerRegistry({ dir, station: makeStation(), now: () => 1 });
    await reg.init();
    await breakTarget();
    expect(() => reg.touch("d1", "PC")).not.toThrow();
    expect(errSpy).toHaveBeenCalled(); // failure surfaced, not swallowed silently
    errSpy.mockRestore();
  });

  it("remember()/forget() do not throw when persist fails", async () => {
    const reg = new PlayerRegistry({ dir, station: makeStation(), now: () => 1 });
    await reg.init();
    reg.touch("d1", "PC"); // first write succeeds
    const errSpy = vi.spyOn(getRootLogger(), "error").mockImplementation(() => getRootLogger());
    await breakTarget();
    expect(() => reg.remember("d1")).not.toThrow();
    expect(() => reg.forget("d1")).not.toThrow();
    errSpy.mockRestore();
  });
});

// --------------------------------------------------------------------------
// Regression: init() must tolerate a JSON-valid file with malformed device
// entries (the read guard only checks version + Array.isArray). One bad record
// must not throw out of init() and brick startup of the always-on station.
// --------------------------------------------------------------------------
describe("PlayerRegistry.init tolerant per-record restore", () => {
  it("skips a null / malformed device entry instead of throwing", async () => {
    await writeFile(
      join(dir, DEVICE_REGISTRY_FILE),
      JSON.stringify({
        version: 1,
        savedAt: 0,
        devices: [
          null,
          { deviceId: 123, label: "numeric id", lastSeen: 1, isPreferredSpeaker: false }, // non-string id
          { deviceId: "good", label: "Good", lastSeen: 5, isPreferredSpeaker: true },
          { deviceId: "nolabel", lastSeen: 6, isPreferredSpeaker: false }, // missing label
        ],
      }),
    );
    const reg = new PlayerRegistry({ dir, station: makeStation(), now: () => 1 });
    await expect(reg.init()).resolves.toBeUndefined();
    // Only the fully-valid record survived; the good preferred speaker still works.
    reg.onConnect("good", makeSink());
    expect(reg.activePlayerDeviceId).toBe("good");
    // The malformed numeric-id record was dropped (no numeric Map key poisoning).
    expect(reg.activePlayerDeviceId).not.toBe(123 as unknown as string);
  });
});

// --------------------------------------------------------------------------
// Regression: the device map / file must not grow without bound, and an
// unchanged reconnect must not rewrite the whole file on the hot path.
// --------------------------------------------------------------------------
describe("PlayerRegistry device-map bound + no-op write skip", () => {
  it("caps retained devices at MAX_DEVICES, LRU-evicting oldest non-preferred", async () => {
    let t = 0;
    const reg = new PlayerRegistry({ dir, station: makeStation(), now: () => ++t });
    await reg.init();
    // Insert well past the cap, each with an increasing lastSeen.
    for (let i = 0; i < MAX_DEVICES + 50; i++) reg.touch(`d${i}`, `L${i}`);
    const file = await readDeviceRegistry(dir);
    expect(file?.devices.length).toBe(MAX_DEVICES);
    // The oldest (d0) was evicted; the newest survives.
    const ids = new Set(file?.devices.map((d) => d.deviceId));
    expect(ids.has("d0")).toBe(false);
    expect(ids.has(`d${MAX_DEVICES + 49}`)).toBe(true);
  });

  it("never evicts a preferred speaker even when it is the oldest", async () => {
    let t = 0;
    const reg = new PlayerRegistry({ dir, station: makeStation(), now: () => ++t });
    await reg.init();
    reg.touch("keep", "Preferred"); // oldest device
    reg.remember("keep"); // mark preferred
    for (let i = 0; i < MAX_DEVICES + 50; i++) reg.touch(`d${i}`, `L${i}`);
    const file = await readDeviceRegistry(dir);
    const ids = new Set(file?.devices.map((d) => d.deviceId));
    expect(ids.has("keep")).toBe(true);
    expect(file?.devices.length).toBe(MAX_DEVICES);
  });

  it("does NOT rewrite the file when a reconnect only bumps lastSeen (same label)", async () => {
    let t = 0;
    const reg = new PlayerRegistry({ dir, station: makeStation(), now: () => ++t });
    await reg.init();
    reg.touch("d1", "PC");
    const before = await readFile(join(dir, DEVICE_REGISTRY_FILE), "utf8");
    reg.touch("d1", "PC"); // same label -> no-op persist
    const after = await readFile(join(dir, DEVICE_REGISTRY_FILE), "utf8");
    expect(after).toBe(before); // file untouched (lastSeen only bumped in memory)
    // A real label change DOES persist.
    reg.touch("d1", "PC renamed");
    const changed = await readFile(join(dir, DEVICE_REGISTRY_FILE), "utf8");
    expect(changed).not.toBe(before);
    expect(JSON.parse(changed).devices[0].label).toBe("PC renamed");
  });
});
