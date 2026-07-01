import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StationSnapshot } from "../types/index.js";
import { readDeviceRegistry } from "./persist.js";
import { PlayerRegistry } from "./registry.js";

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
