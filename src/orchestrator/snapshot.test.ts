import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectStationSnapshot,
  writeStationSnapshot,
  readStationSnapshot,
  restoreStationSnapshot,
  STATION_SNAPSHOT_FILE,
} from "./snapshot.js";
import type {
  StationSnapshot,
  StationSettings,
  TrackMeta,
  QueueItem,
  Requester,
} from "../types/index.js";
import { DEFAULT_SETTINGS } from "../types/index.js";

function meta(id: string): TrackMeta {
  return {
    videoId: id,
    title: id,
    channel: "c",
    durationSec: 100,
    isLive: false,
    thumbnailUrl: null,
  };
}
function item(id: string, fromRadio = false): QueueItem {
  return {
    id: `q-${id}`,
    meta: meta(id),
    requester: { deviceId: "d", displayName: "u", source: "user" } as Requester,
    addedAt: 0,
    audio: null,
    fromRadio,
  };
}
function fakeStation(snap: Partial<StationSnapshot>): {
  snapshot(): StationSnapshot;
  settings: StationSettings;
  seed: TrackMeta | null;
} {
  const full: StationSnapshot = {
    ...DEFAULT_SETTINGS,
    current: null,
    upcoming: [],
    upcomingRadio: [],
    history: [],
    seed: null,
    paused: false,
    preparing: null,
    activePlayerPresent: false,
    activePlayerLabel: null,
    listeners: [],
    ...snap,
  };
  return { snapshot: () => full, settings: { ...DEFAULT_SETTINGS }, seed: full.seed };
}
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "snap-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("station snapshot persistence", () => {
  it("collectStationSnapshot captures seed/current/position/queue/upcomingRadio/settings + activePlayer", () => {
    const cur = { ...item("aaaaaaaaaaa"), positionMs: 4200, durationMs: 100000 };
    const station = fakeStation({
      seed: meta("aaaaaaaaaaa"),
      current: cur,
      upcoming: [item("bbbbbbbbbbb")],
      upcomingRadio: [item("rrrrrrrrrrr", true)],
      history: [item("ccccccccccc")],
    });
    const file = collectStationSnapshot(station, "dev-7", 999);
    expect(file.version).toBe(1);
    expect(file.savedAt).toBe(999);
    expect(file.seed?.videoId).toBe("aaaaaaaaaaa");
    expect(file.current?.meta.videoId).toBe("aaaaaaaaaaa");
    expect(file.positionMs).toBe(4200);
    expect(file.queue.map((i) => i.meta.videoId)).toEqual(["bbbbbbbbbbb"]);
    expect(file.upcomingRadio.map((i) => i.meta.videoId)).toEqual(["rrrrrrrrrrr"]);
    expect(file.history.map((i) => i.meta.videoId)).toEqual(["ccccccccccc"]);
    expect(file.activePlayerDeviceId).toBe("dev-7");
  });

  it("write → read round-trips to STATION_SNAPSHOT_FILE", async () => {
    const station = fakeStation({ seed: meta("aaaaaaaaaaa") });
    const file = collectStationSnapshot(station, null, 1);
    await writeStationSnapshot(dir, file);
    const raw = JSON.parse(await readFile(join(dir, STATION_SNAPSHOT_FILE), "utf8"));
    expect(raw.version).toBe(1);
    const read = await readStationSnapshot(dir);
    expect(read?.seed?.videoId).toBe("aaaaaaaaaaa");
  });

  it("concurrent writes from the same process all succeed (unique tmp, no rename ENOENT)", async () => {
    // Finding: the tmp path was derived from process.pid only, so two same-process saves that
    // overlap collided on the identical tmp; the first rename moved it away and the rest threw
    // ENOENT. A per-write unique suffix lets all overlapping writers settle 'fulfilled'.
    const station = fakeStation({ seed: meta("aaaaaaaaaaa") });
    const fileA = collectStationSnapshot(station, "A", 1);
    const fileB = collectStationSnapshot(station, "B", 2);
    const fileC = collectStationSnapshot(station, "C", 3);
    const fileD = collectStationSnapshot(station, "D", 4);
    const results = await Promise.allSettled([
      writeStationSnapshot(dir, fileA),
      writeStationSnapshot(dir, fileB),
      writeStationSnapshot(dir, fileC),
      writeStationSnapshot(dir, fileD),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    // the final on-disk file is one of the four valid writes (atomic — never torn)
    const read = await readStationSnapshot(dir);
    expect(read?.version).toBe(1);
    expect(["A", "B", "C", "D"]).toContain(read?.activePlayerDeviceId ?? "");
  });

  it("readStationSnapshot returns null for missing / corrupt / wrong-version files", async () => {
    expect(await readStationSnapshot(dir)).toBeNull();
    await writeFile(join(dir, STATION_SNAPSHOT_FILE), "{not json");
    expect(await readStationSnapshot(dir)).toBeNull();
    await writeFile(join(dir, STATION_SNAPSHOT_FILE), JSON.stringify({ version: 2 }));
    expect(await readStationSnapshot(dir)).toBeNull();
  });

  it("restoreStationSnapshot calls station.restore and logs success", async () => {
    const restore = vi.fn(async () => {});
    const log = { info: vi.fn(), error: vi.fn() };
    const station = fakeStation({ seed: meta("aaaaaaaaaaa") });
    const file = collectStationSnapshot(station, null, 1);
    await restoreStationSnapshot(file, { restore }, log);
    expect(restore).toHaveBeenCalledWith(file);
    expect(log.info).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("restoreStationSnapshot logs (does not throw) when restore rejects", async () => {
    const restore = vi.fn(async () => {
      throw new Error("bad");
    });
    const log = { info: vi.fn(), error: vi.fn() };
    const station = fakeStation({});
    const file = collectStationSnapshot(station, null, 1);
    await expect(restoreStationSnapshot(file, { restore }, log)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });
});
