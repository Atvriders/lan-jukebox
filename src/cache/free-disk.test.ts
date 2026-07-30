import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Host free space can't be dictated from a test, so statfsSync is the one thing faked — and it is
// faked as a FUNCTION OF THE REAL DIRECTORY, not a canned sequence: each file present counts as
// 1 MiB of the fake volume, so freeing space requires the cache to actually unlink files. A canned
// sequence would pass even if eviction deleted nothing. Every other fs call stays real.
const volume = vi.hoisted(() => ({ dir: null as string | null, capacityMib: 0, calls: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statfsSync: (p: string, o?: unknown) => {
      if (volume.dir === null) return actual.statfsSync(p, o as never);
      volume.calls++;
      const used = actual.readdirSync(volume.dir).length; // 1 MiB per file
      return { bsize: 1024 * 1024, bavail: Math.max(0, volume.capacityMib - used) } as never;
    },
  };
});

import { AudioCache } from "./index.js";
import { setRootLogger, createLogger } from "../util/logger.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cache-disk-"));
  volume.dir = dir;
  volume.capacityMib = 0;
  volume.calls = 0;
  setRootLogger(createLogger("silent"));
});
afterEach(async () => {
  volume.dir = null;
  await rm(dir, { recursive: true, force: true });
});

async function makeFile(name: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, Buffer.alloc(64));
  return p;
}

const HUGE_CAP = 1024 * 1024 * 1024; // isolate the disk guard from the CACHE_MAX_MB path

describe("AudioCache MIN_FREE_DISK_MB guard", () => {
  it("evicts until the host free-space floor is met, even though the cache is under its cap", async () => {
    // The live failure: CACHE_MAX_MB said there was room, the VOLUME did not (it is shared with
    // logs/other containers and was never expanded), so the station filled the disk and died. The
    // cache has to be able to give bytes back to the filesystem while still under its own cap.
    volume.capacityMib = 3;
    const cache = new AudioCache(dir, HUGE_CAP, 2); // floor: 2 MiB free
    await cache.init();
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa.webm"));
    cache.register("bbbbbbbbbbb", await makeFile("bbbbbbbbbbb.webm"));
    // 3 files on a 3 MiB volume → 0 MiB free, below the 2 MiB floor.
    cache.register("ccccccccccc", await makeFile("ccccccccccc.webm"));

    // The just-admitted file is kept (evicting it would defeat the download that just ran);
    // the LRU ones go, oldest first, until the floor is satisfied.
    expect(cache.has("ccccccccccc")).toBe(true);
    expect(cache.has("aaaaaaaaaaa")).toBe(false);
    expect(cache.has("bbbbbbbbbbb")).toBe(false);
    // …and the space is genuinely returned to the filesystem, not just to the index.
    expect(existsSync(join(dir, "aaaaaaaaaaa.webm"))).toBe(false);
    expect(existsSync(join(dir, "bbbbbbbbbbb.webm"))).toBe(false);
    expect(existsSync(join(dir, "ccccccccccc.webm"))).toBe(true);
  });

  it("does nothing while free space is above the floor", async () => {
    volume.capacityMib = 100;
    const cache = new AudioCache(dir, HUGE_CAP, 2);
    await cache.init();
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa.webm"));
    cache.register("bbbbbbbbbbb", await makeFile("bbbbbbbbbbb.webm"));
    expect(cache.has("aaaaaaaaaaa")).toBe(true);
    expect(cache.has("bbbbbbbbbbb")).toBe(true);
  });

  it("is disabled at 0 — the volume can be full and nothing is evicted", async () => {
    // The default for the two-arg constructor, so an un-wired call site can't start silently
    // deleting a healthy cache; it also means the knob only ever ADDS eviction.
    volume.capacityMib = 0; // 0 MiB free: as full as it gets
    const cache = new AudioCache(dir, HUGE_CAP); // no floor
    await cache.init();
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa.webm"));
    cache.register("bbbbbbbbbbb", await makeFile("bbbbbbbbbbb.webm"));
    expect(cache.has("aaaaaaaaaaa")).toBe(true);
    expect(cache.has("bbbbbbbbbbb")).toBe(true);
    expect(volume.calls).toBe(0); // not even consulted
  });

  it("skips the check (rather than evicting on a guess) when statfs is unavailable", async () => {
    volume.dir = null; // fall through to the real statfsSync…
    const cache = new AudioCache("/definitely/not/a/real/path", HUGE_CAP, 1024);
    // …on a path that does not exist, so the reading throws and freeBytesSafe returns null.
    const p = await makeFile("aaaaaaaaaaa.webm");
    expect(() => cache.register("aaaaaaaaaaa", p)).not.toThrow();
    expect(cache.has("aaaaaaaaaaa")).toBe(true);
  });

  it("warns and gives up instead of spinning when everything left is pinned", async () => {
    // enforceFreeDisk loops until the floor is met; with no evictable entry that must terminate.
    const warn = vi.fn();
    setRootLogger({ warn, error: vi.fn(), info: vi.fn() } as never);
    volume.capacityMib = 1;
    const cache = new AudioCache(dir, HUGE_CAP, 2);
    await cache.init();
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa.webm"));
    cache.pin("aaaaaaaaaaa");
    cache.register("bbbbbbbbbbb", await makeFile("bbbbbbbbbbb.webm"));
    cache.pin("bbbbbbbbbbb");
    cache.register("ccccccccccc", await makeFile("ccccccccccc.webm")); // must return, not hang
    expect(warn).toHaveBeenCalled();
    expect(cache.has("ccccccccccc")).toBe(true);
  });
});
