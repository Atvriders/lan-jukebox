import { describe, it, expect, vi } from "vitest";
import { RadioEngine, type RadioDeps } from "./index.js";
import type { TrackMeta, AutoplaySource, QueueItem, Requester } from "../types/index.js";

function meta(id: string, isLive = false): TrackMeta {
  return { videoId: id, title: id, channel: "c", durationSec: 100, isLive, thumbnailUrl: null };
}
function item(id: string): QueueItem {
  return {
    id: `q-${id}`,
    meta: meta(id),
    requester: { deviceId: "d", displayName: "u", source: "user" } as Requester,
    addedAt: 0,
    audio: null,
    fromRadio: false,
  };
}
function fakeStation(
  seed: TrackMeta | null,
  snap: { current: QueueItem | null; upcoming: QueueItem[]; history: QueueItem[] },
) {
  const enqueued: TrackMeta[] = [];
  return {
    station: {
      seed,
      queue: { snapshot: () => snap },
      enqueue: vi.fn(async (m: TrackMeta) => {
        enqueued.push(m);
        return item(m.videoId);
      }),
    },
    enqueued,
  };
}
const radioSettings = () => ({ autoplay: true, autoplaySource: "radio" as AutoplaySource });

describe("RadioEngine", () => {
  it("cold start (seed null) → nextCandidate is null", async () => {
    const related = vi.fn(async () => [meta("rrrrrrrrrrr")]);
    const { station } = fakeStation(null, { current: null, upcoming: [], history: [] });
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      settings: radioSettings,
    });
    expect(await r.nextCandidate()).toBeNull();
    expect(related).not.toHaveBeenCalled();
  });

  it("radio source pulls related(seed.videoId) and returns the first new non-live track", async () => {
    const related = vi.fn(async () => [meta("sssssssssss"), meta("ttttttttttt")]);
    const { station } = fakeStation(meta("aaaaaaaaaaa"), {
      current: null,
      upcoming: [],
      history: [],
    });
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      settings: radioSettings,
    });
    const c = await r.nextCandidate();
    expect(related).toHaveBeenCalledWith("aaaaaaaaaaa");
    expect(c?.videoId).toBe("sssssssssss");
  });

  it("artist source pulls artistTracks(seed)", async () => {
    const artistTracks = vi.fn(async () => [meta("zzzzzzzzzzz")]);
    const { station } = fakeStation(meta("aaaaaaaaaaa"), {
      current: null,
      upcoming: [],
      history: [],
    });
    const r = new RadioEngine({
      youtube: { related: vi.fn(), artistTracks },
      station: station as unknown as RadioDeps["station"],
      settings: () => ({ autoplay: true, autoplaySource: "artist" }),
    });
    expect((await r.nextCandidate())?.videoId).toBe("zzzzzzzzzzz");
    expect(artistTracks).toHaveBeenCalled();
  });

  it("de-dups vs current/upcoming/history AND skips live tracks", async () => {
    const related = vi.fn(async () => [
      meta("aaaaaaaaaaa"),
      meta("lllllllllll", true),
      meta("nnnnnnnnnnn"),
    ]);
    const { station } = fakeStation(meta("aaaaaaaaaaa"), {
      current: item("aaaaaaaaaaa"),
      upcoming: [item("bbbbbbbbbbb")],
      history: [item("ccccccccccc")],
    });
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      settings: radioSettings,
    });
    expect((await r.nextCandidate())?.videoId).toBe("nnnnnnnnnnn"); // aaa=current, lll=live → skipped
  });

  it("does not re-pick the same id across consecutive calls (bounded recent window)", async () => {
    const related = vi.fn(async () => [meta("sssssssssss"), meta("ttttttttttt")]);
    const { station } = fakeStation(meta("aaaaaaaaaaa"), {
      current: null,
      upcoming: [],
      history: [],
    });
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      settings: radioSettings,
    });
    expect((await r.nextCandidate())?.videoId).toBe("sssssssssss");
    expect((await r.nextCandidate())?.videoId).toBe("ttttttttttt");
  });

  it("reset() clears the recent window so a fresh seed can re-pick", async () => {
    const related = vi.fn(async () => [meta("sssssssssss")]);
    const { station } = fakeStation(meta("aaaaaaaaaaa"), {
      current: null,
      upcoming: [],
      history: [],
    });
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      settings: radioSettings,
    });
    expect((await r.nextCandidate())?.videoId).toBe("sssssssssss");
    expect(await r.nextCandidate()).toBeNull(); // exhausted (only one candidate, now seen)
    r.reset();
    expect((await r.nextCandidate())?.videoId).toBe("sssssssssss");
  });

  it("a source error → null, never throws", async () => {
    const related = vi.fn(async () => {
      throw new Error("yt down");
    });
    const { station } = fakeStation(meta("aaaaaaaaaaa"), {
      current: null,
      upcoming: [],
      history: [],
    });
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      settings: radioSettings,
    });
    await expect(r.nextCandidate()).resolves.toBeNull();
  });

  it("a dep that resolves to a non-array → null, never throws", async () => {
    // Finding: the try/catch only caught a rejected promise; a resolved non-array slipped past
    // and `candidates.find(...)` threw a TypeError out of nextCandidate (broke the never-throws
    // contract that ensureAhead relies on).
    const related = vi.fn(async () => undefined as unknown as TrackMeta[]);
    const { station } = fakeStation(meta("aaaaaaaaaaa"), {
      current: null,
      upcoming: [],
      history: [],
    });
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      settings: radioSettings,
    });
    await expect(r.nextCandidate()).resolves.toBeNull();
  });

  it("autoplay off → nextCandidate is null (engine idle)", async () => {
    const related = vi.fn(async () => [meta("sssssssssss")]);
    const { station } = fakeStation(meta("aaaaaaaaaaa"), {
      current: null,
      upcoming: [],
      history: [],
    });
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      settings: () => ({ autoplay: false, autoplaySource: "radio" }),
    });
    expect(await r.nextCandidate()).toBeNull();
    expect(related).not.toHaveBeenCalled();
  });

  it("ensureAhead(lowWater) appends radio tracks via station.enqueue until upcoming >= lowWater", async () => {
    const related = vi.fn(async () => [
      meta("sssssssssss"),
      meta("ttttttttttt"),
      meta("uuuuuuuuuuu"),
    ]);
    const snap = {
      current: item("aaaaaaaaaaa"),
      upcoming: [] as QueueItem[],
      history: [] as QueueItem[],
    };
    const enqueued: TrackMeta[] = [];
    const station = {
      seed: meta("aaaaaaaaaaa"),
      queue: { snapshot: () => snap },
      enqueue: vi.fn(async (m: TrackMeta) => {
        enqueued.push(m);
        snap.upcoming.push(item(m.videoId));
        return item(m.videoId);
      }),
    };
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      settings: radioSettings,
    });
    await r.ensureAhead(2);
    expect(enqueued.map((m) => m.videoId)).toEqual(["sssssssssss", "ttttttttttt"]);
  });

  it("ensureAhead stops cleanly when no new candidate is available", async () => {
    const related = vi.fn(async () => [] as TrackMeta[]);
    const snap = {
      current: item("aaaaaaaaaaa"),
      upcoming: [] as QueueItem[],
      history: [] as QueueItem[],
    };
    const station = {
      seed: meta("aaaaaaaaaaa"),
      queue: { snapshot: () => snap },
      enqueue: vi.fn(async (m: TrackMeta) => item(m.videoId)),
    };
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      settings: radioSettings,
    });
    await expect(r.ensureAhead(2)).resolves.toBeUndefined();
    expect(station.enqueue).not.toHaveBeenCalled();
  });
});
