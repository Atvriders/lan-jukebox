import { describe, it, expect, vi } from "vitest";
import { createCoalescedDownload } from "./coalesce-download.js";
import { Semaphore } from "./semaphore.js";

describe("createCoalescedDownload (finding: same videoId downloaded by two racing yt-dlp)", () => {
  it("coalesces concurrent downloads of the SAME videoId into ONE underlying fetch", async () => {
    // The exact prod race: prefetch(id) and load(id) fire for the same track back-to-back. Without
    // coalescing both spawn yt-dlp writing the same --no-part file → corrupt audio → skipped song.
    let resolveFn: ((r: { path: string; audio: null }) => void) | null = null;
    const download = vi.fn(
      () =>
        new Promise<{ path: string; audio: null }>((res) => {
          resolveFn = res;
        }),
    );
    const coalesced = createCoalescedDownload({
      download,
      cacheGet: () => null,
      cacheGetAudio: () => null,
      semaphore: new Semaphore(4),
    });
    const p1 = coalesced("aaaaaaaaaaa", { durationSec: 100 }); // load
    const p2 = coalesced("aaaaaaaaaaa"); // prefetch of the SAME id
    // Let the shared semaphore hand out the slot and invoke the underlying download (it runs on a
    // microtask, not synchronously). Both callers must have shared the single spawned fetch.
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    resolveFn!({ path: "/cache/aaaaaaaaaaa.m4a", audio: null });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2); // both callers share the identical result
    expect(r1.path).toBe("/cache/aaaaaaaaaaa.m4a");
  });

  it("serves a cached id from disk without spawning any download", async () => {
    const download = vi.fn(async () => ({ path: "x", audio: null }));
    const audio = { codec: "opus", bitrateKbps: 160, sampleRateHz: 48000 };
    const coalesced = createCoalescedDownload({
      download,
      cacheGet: (id) => `/cache/${id}.m4a`,
      cacheGetAudio: () => audio,
      semaphore: new Semaphore(1),
    });
    const r = await coalesced("bbbbbbbbbbb");
    expect(download).not.toHaveBeenCalled();
    expect(r.path).toBe("/cache/bbbbbbbbbbb.m4a");
    expect(r.audio).toEqual(audio);
  });

  it("re-downloads once the previous in-flight promise has settled (map cleared, cache still cold)", async () => {
    const download = vi.fn(async (id: string) => ({ path: `/cache/${id}.m4a`, audio: null }));
    const coalesced = createCoalescedDownload({
      download,
      cacheGet: () => null, // simulate an eviction: nothing cached
      cacheGetAudio: () => null,
      semaphore: new Semaphore(2),
    });
    await coalesced("ccccccccccc");
    await coalesced("ccccccccccc"); // first already settled + cache empty → a fresh fetch
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("routes downloads through the shared semaphore (concurrency is bounded)", async () => {
    let active = 0;
    let maxActive = 0;
    const download = vi.fn(
      (id: string) =>
        new Promise<{ path: string; audio: null }>((res) => {
          active++;
          maxActive = Math.max(maxActive, active);
          setTimeout(() => {
            active--;
            res({ path: `/cache/${id}.m4a`, audio: null });
          }, 5);
        }),
    );
    const coalesced = createCoalescedDownload({
      download,
      cacheGet: () => null,
      cacheGetAudio: () => null,
      semaphore: new Semaphore(2), // cap of 2 concurrent
    });
    await Promise.all([
      coalesced("aaaaaaaaaaa"),
      coalesced("bbbbbbbbbbb"),
      coalesced("ccccccccccc"),
      coalesced("ddddddddddd"),
    ]);
    expect(maxActive).toBeLessThanOrEqual(2); // the semaphore bounded concurrency
    expect(download).toHaveBeenCalledTimes(4);
  });
});
