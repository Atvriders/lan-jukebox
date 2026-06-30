import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioCache } from "./index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cache-"));
});

async function makeFile(name: string, bytes: number): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, Buffer.alloc(bytes));
  return p;
}

describe("AudioCache", () => {
  it("registers and retrieves a file, tracking total bytes", async () => {
    const cache = new AudioCache(dir, 1000);
    await cache.init();
    const p = await makeFile("aaaaaaaaaaa.webm", 300);
    cache.register("aaaaaaaaaaa", p);
    expect(cache.has("aaaaaaaaaaa")).toBe(true);
    expect(cache.get("aaaaaaaaaaa")).toBe(p);
    expect(cache.totalBytes()).toBe(300);
  });

  it("evicts the least-recently-used file when over the cap", async () => {
    const cache = new AudioCache(dir, 500);
    await cache.init();
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa.webm", 300));
    cache.register("bbbbbbbbbbb", await makeFile("bbbbbbbbbbb.webm", 300)); // total 600 > 500
    // 'a' is LRU and should be evicted from disk + index.
    expect(cache.has("aaaaaaaaaaa")).toBe(false);
    expect(existsSync(join(dir, "aaaaaaaaaaa.webm"))).toBe(false);
    expect(cache.has("bbbbbbbbbbb")).toBe(true);
  });

  it("get() refreshes recency so the other entry is evicted next", async () => {
    const cache = new AudioCache(dir, 650);
    await cache.init();
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa.webm", 300));
    cache.register("bbbbbbbbbbb", await makeFile("bbbbbbbbbbb.webm", 300));
    cache.get("aaaaaaaaaaa"); // touch 'a' → 'b' now LRU
    cache.register("ccccccccccc", await makeFile("ccccccccccc.webm", 300)); // 900 > 650
    expect(cache.has("bbbbbbbbbbb")).toBe(false);
    expect(cache.has("aaaaaaaaaaa")).toBe(true);
    expect(cache.has("ccccccccccc")).toBe(true);
  });

  it("never evicts a pinned entry, even if it is LRU", async () => {
    const cache = new AudioCache(dir, 500);
    await cache.init();
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa.webm", 300));
    cache.pin("aaaaaaaaaaa");
    cache.register("bbbbbbbbbbb", await makeFile("bbbbbbbbbbb.webm", 300)); // 600 > 500
    expect(cache.has("aaaaaaaaaaa")).toBe(true); // pinned survives
    expect(cache.has("bbbbbbbbbbb")).toBe(true);
    cache.unpin("aaaaaaaaaaa");
    cache.register("ccccccccccc", await makeFile("ccccccccccc.webm", 300));
    // After unpinning 'a', registering 'c' (300) over a 600-byte cache (cap 500) must
    // evict BOTH 'a' and 'b' (600+300=900 → evict LRU 'a' → 600>500 → evict 'b' → 300)
    // before 'c' lands. Pin the full double-eviction cascade + successful insert.
    expect(cache.has("aaaaaaaaaaa")).toBe(false); // now evictable
    expect(cache.has("bbbbbbbbbbb")).toBe(false);
    expect(cache.has("ccccccccccc")).toBe(true);
    expect(cache.totalBytes()).toBe(300);
  });

  it("does not over-evict innocent entries when re-registering an existing id", async () => {
    // maxBytes 1000, entries {A:600, B:300} (total 900). Re-register A at 300: the old
    // 600 bytes are freed by the overwrite, so the post-register footprint is
    // 900-600+300=600 ≤ 1000 — B must survive (the stale-count bug would evict it).
    const cache = new AudioCache(dir, 1000);
    await cache.init();
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa.webm", 600));
    cache.register("bbbbbbbbbbb", await makeFile("bbbbbbbbbbb.webm", 300));
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa2.webm", 300)); // overwrite A
    expect(cache.has("bbbbbbbbbbb")).toBe(true); // innocent entry not evicted
    expect(cache.has("aaaaaaaaaaa")).toBe(true);
    expect(cache.totalBytes()).toBe(600);
  });

  it("keeps evicting when the re-registered id is itself the LRU victim (no phantom credit)", async () => {
    // Regression for the eviction undercount: when the entry being overwritten is ALSO the
    // LRU victim, the old code subtracted a constant `oldSize` from totalBytes() across the
    // loop even after that entry left the map — a phantom credit that exited the loop early
    // and left the cache OVER the cap with other evictable entries still present.
    //
    // maxBytes=1000, A:400 then B:400 (A is LRU). Re-register A with a LARGER 700-byte file.
    // Freeing A up front leaves B:400; 400+700=1100 > 1000 -> B must be evicted, landing at
    // A':700 ≤ 1000. The bug would have left {B:400, A':700} = 1100 > cap.
    const cache = new AudioCache(dir, 1000);
    await cache.init();
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa.webm", 400));
    cache.register("bbbbbbbbbbb", await makeFile("bbbbbbbbbbb.webm", 400));
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa2.webm", 700)); // larger overwrite
    expect(cache.totalBytes()).toBeLessThanOrEqual(1000);
    expect(cache.has("bbbbbbbbbbb")).toBe(false); // the LRU innocent entry WAS evicted
    expect(cache.has("aaaaaaaaaaa")).toBe(true);
    expect(cache.get("aaaaaaaaaaa")).toBe(join(dir, "aaaaaaaaaaa2.webm")); // new path
    expect(cache.totalBytes()).toBe(700);
  });

  it("preserves the pinned flag across re-registration (currently-playing track survives)", async () => {
    // The orchestrator pins the currently-playing track. If that track is re-registered while
    // pinned (e.g. a re-download), the new entry must STAY pinned or it becomes eviction-
    // eligible mid-playback. Guards index.ts `pinned: oldEntry?.pinned ?? false`.
    const cache = new AudioCache(dir, 500);
    await cache.init();
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa.webm", 200));
    cache.pin("aaaaaaaaaaa");
    // Re-register the SAME id (still pinned) with a new file/path.
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa2.webm", 200));
    expect(cache.has("aaaaaaaaaaa")).toBe(true);
    expect(cache.get("aaaaaaaaaaa")).toBe(join(dir, "aaaaaaaaaaa2.webm"));
    // Push the cache over the cap; the still-pinned re-registered entry must survive eviction.
    cache.register("bbbbbbbbbbb", await makeFile("bbbbbbbbbbb.webm", 400)); // 200+400=600 > 500
    expect(cache.has("aaaaaaaaaaa")).toBe(true); // pin preserved across re-register
  });

  it("does not register a ghost entry for a file that is missing on disk", async () => {
    const cache = new AudioCache(dir, 1000);
    await cache.init();
    cache.register("aaaaaaaaaaa", join(dir, "does-not-exist.webm"));
    // No size-0 ghost: has() must report false and get() must return null.
    expect(cache.has("aaaaaaaaaaa")).toBe(false);
    expect(cache.get("aaaaaaaaaaa")).toBeNull();
    expect(cache.totalBytes()).toBe(0);
  });

  it("get() returns null for an unknown id", async () => {
    const cache = new AudioCache(dir, 500);
    await cache.init();
    expect(cache.get("zzzzzzzzzzz")).toBeNull();
  });

  it("stores and returns the audio format passed to register", async () => {
    const cache = new AudioCache(dir, 1000);
    await cache.init();
    const audio = { codec: "opus", bitrateKbps: 160, sampleRateHz: 48000 };
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa.webm", 100), audio);
    expect(cache.getAudio("aaaaaaaaaaa")).toEqual(audio);
    expect(cache.getAudio("unknownnnnn")).toBeNull();
  });

  it("getAudio defaults to null when no format was supplied", async () => {
    const cache = new AudioCache(dir, 1000);
    await cache.init();
    cache.register("aaaaaaaaaaa", await makeFile("aaaaaaaaaaa.webm", 100));
    expect(cache.getAudio("aaaaaaaaaaa")).toBeNull();
  });

  it("register() ignores a path that does not exist on disk (no ghost entry)", async () => {
    const cache = new AudioCache("/tmp/lan-jukebox-cache-test-ghost", 1024);
    await cache.init();
    cache.register("ghostvideoid", "/tmp/definitely-not-a-real-file.m4a");
    expect(cache.has("ghostvideoid")).toBe(false);
    expect(cache.get("ghostvideoid")).toBeNull();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
});
