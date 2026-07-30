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
  const upcomingRadio: QueueItem[][] = [];
  return {
    station: {
      seed,
      queue: { snapshot: () => snap },
      enqueue: vi.fn(async (m: TrackMeta) => {
        enqueued.push(m);
        // Mirror the real Queue.add: radio adds land in `upcoming` tagged fromRadio, so
        // publishPreview() can mirror them into the upcoming-radio preview.
        snap.upcoming.push({ ...item(m.videoId), fromRadio: true });
        return item(m.videoId);
      }),
      setUpcomingRadio: vi.fn((items: QueueItem[]) => {
        upcomingRadio.push(items);
      }),
    },
    enqueued,
    upcomingRadio,
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
      maxAutoplayDurationSec: 0,
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
      maxAutoplayDurationSec: 0,
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
      maxAutoplayDurationSec: 0,
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
      maxAutoplayDurationSec: 0,
      settings: radioSettings,
    });
    expect((await r.nextCandidate())?.videoId).toBe("nnnnnnnnnnn"); // aaa=current, lll=live → skipped
  });

  it("skips autoplay candidates longer than maxAutoplayDurationSec (cap>0); null duration passes", async () => {
    const longMix: TrackMeta = {
      videoId: "longlonglon",
      title: "10h mix",
      channel: "c",
      durationSec: 36000, // way over the cap
      isLive: false,
      thumbnailUrl: null,
    };
    const unknownDur: TrackMeta = {
      videoId: "unknownnnnn",
      title: "?",
      channel: "c",
      durationSec: null, // unknown → cap can't reject it
      isLive: false,
      thumbnailUrl: null,
    };
    const related = vi.fn(async () => [longMix, unknownDur]);
    const { station } = fakeStation(meta("aaaaaaaaaaa"), {
      current: null,
      upcoming: [],
      history: [],
    });
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      maxAutoplayDurationSec: 900,
      settings: radioSettings,
    });
    // longMix (36000s > 900) is skipped by the cap; unknownDur (durationSec null) is NOT rejected.
    expect((await r.nextCandidate())?.videoId).toBe("unknownnnnn");
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
      maxAutoplayDurationSec: 0,
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
      maxAutoplayDurationSec: 0,
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
      maxAutoplayDurationSec: 0,
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
      maxAutoplayDurationSec: 0,
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
      maxAutoplayDurationSec: 0,
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
      setUpcomingRadio: vi.fn(),
    };
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      maxAutoplayDurationSec: 0,
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
      setUpcomingRadio: vi.fn(),
    };
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      maxAutoplayDurationSec: 0,
      settings: radioSettings,
    });
    await expect(r.ensureAhead(2)).resolves.toBeUndefined();
    expect(station.enqueue).not.toHaveBeenCalled();
  });

  it("publishes the radio-tagged upcoming items to the upcoming-radio preview after enqueuing", async () => {
    // Finding: setUpcomingRadio had ZERO production callers, so the UI upcoming-radio preview was
    // permanently empty. ensureAhead must mirror its radio-tagged picks into the preview.
    const related = vi.fn(async () => [meta("sssssssssss"), meta("ttttttttttt")]);
    const snap = {
      current: item("aaaaaaaaaaa"),
      upcoming: [] as QueueItem[],
      history: [] as QueueItem[],
    };
    const preview: QueueItem[][] = [];
    const station = {
      seed: meta("aaaaaaaaaaa"),
      queue: { snapshot: () => snap },
      enqueue: vi.fn(async (m: TrackMeta) => {
        // Real Queue tags radio adds fromRadio:true in `upcoming`.
        snap.upcoming.push({ ...item(m.videoId), fromRadio: true });
        return item(m.videoId);
      }),
      setUpcomingRadio: vi.fn((items: QueueItem[]) => preview.push(items)),
    };
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      maxAutoplayDurationSec: 0,
      settings: radioSettings,
    });
    await r.ensureAhead(2);
    expect(station.setUpcomingRadio).toHaveBeenCalled();
    // The last publish reflects the two radio-tagged picks now in `upcoming`.
    expect(preview.at(-1)?.map((i) => i.meta.videoId)).toEqual(["sssssssssss", "ttttttttttt"]);
  });

  it("SEQUENTIAL nextCandidate calls return DISTINCT ids (dup-queue bug stays fixed)", async () => {
    // Real YouTube RD-Mix returns a STABLE set, so the first-eligible track is the same on every
    // call. radioTopUp fires nextCandidate on every 'changed' (fire-and-forget) + radioContinuation
    // adds a 2nd entry point. Before the pick was serialized, two overlapping calls both snapshotted
    // the de-dup set BEFORE their awaited fetch and BEFORE remember(), so both returned
    // "sssssssssss" → duplicate queue entries (the reported Scientist ×4 / Yellow ×6). Only ONE
    // production may run at a time, so each pick observes the previous pick's remember() and moves
    // on to the next distinct track. Overlapping callers are turned into sequential ones by the
    // queueing lock (nobody is dropped — see the queueing describe below), and every call must
    // produce something new.
    const related = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5)); // network delay, as a real lookup has
      return [meta("sssssssssss"), meta("ttttttttttt"), meta("uuuuuuuuuuu")];
    });
    const { station } = fakeStation(meta("aaaaaaaaaaa"), {
      current: null,
      upcoming: [],
      history: [],
    });
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      maxAutoplayDurationSec: 0,
      settings: radioSettings,
    });
    const a = await r.nextCandidate();
    const b = await r.nextCandidate();
    const c = await r.nextCandidate();
    expect([a?.videoId, b?.videoId, c?.videoId]).toEqual([
      "sssssssssss",
      "ttttttttttt",
      "uuuuuuuuuuu",
    ]);
    expect(new Set([a?.videoId, b?.videoId, c?.videoId]).size).toBe(3); // zero repeats
  });

  it("overlapping ensureAhead runs never enqueue duplicate radio tracks", async () => {
    const related = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return [meta("sssssssssss"), meta("ttttttttttt"), meta("uuuuuuuuuuu")];
    });
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
        snap.upcoming.push({ ...item(m.videoId), fromRadio: true });
        return item(m.videoId);
      }),
      setUpcomingRadio: vi.fn(),
    };
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      maxAutoplayDurationSec: 0,
      settings: radioSettings,
    });
    // Fire two top-ups concurrently (as radioTopUp's fire-and-forget would on a burst of 'changed').
    await Promise.all([r.ensureAhead(3), r.ensureAhead(3)]);
    const ids = enqueued.map((m) => m.videoId);
    expect(new Set(ids).size).toBe(ids.length); // zero duplicates enqueued
  });

  it("does NOT publish the preview when nothing was enqueued (avoids infinite changed→topUp loop)", async () => {
    const related = vi.fn(async () => [] as TrackMeta[]);
    const snap = {
      current: item("aaaaaaaaaaa"),
      upcoming: [item("bbbbbbbbbbb")], // already at lowWater
      history: [] as QueueItem[],
    };
    const station = {
      seed: meta("aaaaaaaaaaa"),
      queue: { snapshot: () => snap },
      enqueue: vi.fn(),
      setUpcomingRadio: vi.fn(),
    };
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      maxAutoplayDurationSec: 0,
      settings: radioSettings,
    });
    await r.ensureAhead(1);
    expect(station.enqueue).not.toHaveBeenCalled();
    expect(station.setUpcomingRadio).not.toHaveBeenCalled();
  });
});

describe("RadioEngine never-dry fallback (45h production freeze)", () => {
  // THE incident's root cause at the radio layer. On a long-running station the bounded history
  // ring fills with the whole Mix (100/100 slots, 21 of them one artist), so EVERY candidate
  // related() returned was already `seen`: nextCandidate returned null forever, the station
  // dry-held permanently and the jukebox was silent for 45 hours. Picking is now graduated —
  // seed → several alternate seeds → a least-recently-played repeat — because for an always-on
  // station "never stops" beats "never repeats".

  it("re-seeds from SEVERAL recent tracks, not just the most recent, when the seed's pool is dry", async () => {
    // The old fallback tried exactly ONE alternate seed (the newest history entry). On a mined-out
    // station that alternate's Mix overlaps the same already-played tracks, so it dried up too and
    // the station still went silent. The walk-back must try several (bounded) alternates.
    const related = vi.fn(
      async (id: string) =>
        id === "olderplay11"
          ? [meta("freshtrack1")] // only the SECOND alternate seed still has something new
          : [meta("newerplay11")], // the seed and the newest alternate are both mined out
    );
    const { station } = fakeStation(meta("seedddddddd"), {
      current: null,
      upcoming: [],
      history: [item("olderplay11"), item("newerplay11")], // oldest → newest
    });
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      maxAutoplayDurationSec: 0,
      settings: radioSettings,
    });
    expect((await r.nextCandidate())?.videoId).toBe("freshtrack1");
    // Seed first (it stays PRIMARY), then history walked BACK from the most recent.
    expect(related.mock.calls.map((c) => c[0])).toEqual([
      "seedddddddd",
      "newerplay11",
      "olderplay11",
    ]);
  });

  it("replays the LEAST-RECENTLY-PLAYED track instead of going silent when every source is dry", async () => {
    // Every alternate seed is mined out too — the exact live state. Rather than null (permanent
    // dry-hold), relax the de-dup: replay the track whose last play is furthest back.
    const related = vi.fn(async () => [meta("newestone1"), meta("middleone1")]); // all already seen
    const { station } = fakeStation(meta("seedddddddd"), {
      current: item("nowplaying1"),
      upcoming: [],
      // oldest → newest; the currently-playing track also sits in the ring.
      history: [item("nowplaying1"), item("oldestone1"), item("middleone1"), item("newestone1")],
    });
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      maxAutoplayDurationSec: 0,
      settings: radioSettings,
    });
    const pick = await r.nextCandidate();
    // Least-recently-played AND not the current track (replaying what is playing is not "next").
    expect(pick?.videoId).toBe("oldestone1");
    expect(related.mock.calls.length).toBeGreaterThan(1); // alternate seeds were genuinely tried
  });

  it("still returns null when nothing has EVER played (cold start is not a repeat)", async () => {
    // The relaxation is strictly a last resort: with an empty history there is nothing to replay,
    // so null (and the caller's dry-hold + backing-off retry) is still the correct answer.
    const related = vi.fn(async () => [] as TrackMeta[]);
    const { station } = fakeStation(meta("seedddddddd"), {
      current: null,
      upcoming: [],
      history: [],
    });
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      maxAutoplayDurationSec: 0,
      settings: radioSettings,
    });
    expect(await r.nextCandidate()).toBeNull();
  });
});

describe("RadioEngine production lock QUEUES (the station is never turned away)", () => {
  // Production is guarded by a QUEUEING Mutex, deliberately NOT a non-blocking try-lock.
  // A try-lock answers the loser with null — and the loser is almost always the STATION: the same
  // queue 'changed' burst that drains the queue also fires radioTopUp, so the OPTIONAL background
  // top-up routinely owns the slot at the exact instant a track ends and the station's
  // radioContinuation asks for its next pick. "No radio right now" on essentially every track end
  // is a paused dry-hold per track — strictly worse than a short wait. So the station WAITS and is
  // always served; the optional top-up is the one that backs off (ensureAhead's pendingProductions
  // check), which also bounds the wait to at most one top-up production ahead of the station.
  // The wait is safe because the work inside is TIME-BOUNDED (RADIO_BUDGET_MS + one already-started
  // fetch ≈ 7 min, under the station's 15-min RADIO_WATCHDOG_MS), not because callers are refused.

  const tick = () => new Promise((res) => setTimeout(res, 0));

  /** A radio engine whose FIRST related() lookup parks until released; later lookups are instant. */
  function parkedFirstFetch() {
    let releaseFetch!: (tracks: TrackMeta[]) => void;
    let fetches = 0;
    const related = vi.fn(() => {
      fetches++;
      return fetches === 1
        ? new Promise<TrackMeta[]>((res) => {
            releaseFetch = res;
          })
        : Promise.resolve([meta("ttttttttttt")]);
    });
    const { station, enqueued } = fakeStation(meta("aaaaaaaaaaa"), {
      current: null,
      upcoming: [],
      history: [],
    });
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      maxAutoplayDurationSec: 0,
      settings: radioSettings,
    });
    return { r, related, station, enqueued, release: (t: TrackMeta[]) => releaseFetch(t) };
  }

  it("a concurrent second call WAITS for the first and is served a DISTINCT track (never null)", async () => {
    const { r, related, release } = parkedFirstFetch();

    const first = r.nextCandidate(); // takes the lock and parks mid-lookup
    await tick();
    expect(related).toHaveBeenCalledTimes(1); // the lock is genuinely held, mid-fetch

    const second = r.nextCandidate(); // concurrent — it QUEUES, it is not refused
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await tick();
    expect(secondSettled).toBe(false); // still waiting on the holder…
    expect(related).toHaveBeenCalledTimes(1); // …and has not started its own fetch yet

    release([meta("sssssssssss")]);
    expect((await first)?.videoId).toBe("sssssssssss");
    // THE restored contract: the second caller is answered with a REAL track, and a different one —
    // it ran after the first's remember(), which is exactly what kills the duplicate-queue bug.
    const b = await second;
    expect(b).not.toBeNull();
    expect(b?.videoId).toBe("ttttttttttt");
  });

  it("CONCURRENT nextCandidate calls all resolve to DISTINCT tracks (no dups, nobody dropped)", async () => {
    // The dup bug and the starvation bug in one assertion: fire three at once, as radioTopUp and
    // radioContinuation do on a 'changed' burst. Every one must get a track (queueing, not
    // try-locking) and no two may be the same (serialized remember(), not parallel snapshots).
    const related = vi.fn(async () => {
      await new Promise((res) => setTimeout(res, 5)); // network delay, as a real lookup has
      return [meta("sssssssssss"), meta("ttttttttttt"), meta("uuuuuuuuuuu")];
    });
    const { station } = fakeStation(meta("aaaaaaaaaaa"), {
      current: null,
      upcoming: [],
      history: [],
    });
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      maxAutoplayDurationSec: 0,
      settings: radioSettings,
    });
    const picks = await Promise.all([r.nextCandidate(), r.nextCandidate(), r.nextCandidate()]);
    const ids = picks.map((p) => p?.videoId);
    expect(ids).not.toContain(undefined); // nobody was refused
    expect(new Set(ids).size).toBe(3); // zero repeats
    expect([...ids].sort()).toEqual(["sssssssssss", "ttttttttttt", "uuuuuuuuuuu"]);
  });

  it("the STATION is never starved by an in-flight background top-up (HIGH-A regression)", async () => {
    // HIGH-A, asserted directly. radioTopUp → ensureAhead is fire-and-forget on EVERY 'changed', so
    // a top-up is in flight at precisely the moment a track ends and the station's
    // radioContinuation calls nextCandidate(). Under the try-lock that station call got null and
    // the station dry-held — per track, forever, which is the freeze wearing a different hat. The
    // station must be handed a REAL track instead.
    const { r, related, release, enqueued } = parkedFirstFetch();

    void r.ensureAhead(3); // background top-up takes the production lock and parks mid-lookup
    await tick();
    expect(related).toHaveBeenCalledTimes(1); // the top-up genuinely owns the lock right now

    const stationPick = r.nextCandidate(); // the station's radioContinuation, concurrent with it
    release([meta("sssssssssss")]); // the top-up's lookup finally returns

    const pick = await stationPick;
    expect(pick).not.toBeNull(); // ← THE regression: never null just because a top-up was running
    expect(pick?.videoId).toBe("ttttttttttt");
    // …and it is a fresh track, not a copy of what the top-up just queued.
    expect(enqueued.map((m) => m.videoId)).not.toContain(pick?.videoId);
  });

  it("the TOP-UP is the side that gives way: ensureAhead skips while a production is pending", async () => {
    // The other half of the same contract. Because the station now WAITS, the optional path must
    // never stack another production in front of it — otherwise the station's bounded wait grows
    // with every 'changed'. ensureAhead sees pendingProductions > 0 and does nothing at all; the
    // next 'changed' brings it back.
    const { r, related, station, release } = parkedFirstFetch();

    const stationPick = r.nextCandidate(); // the station is queued/running: pendingProductions > 0
    await r.ensureAhead(3); // must return immediately, having done nothing
    expect(related).toHaveBeenCalledTimes(1); // no extra fetch was started by the top-up
    expect(station.enqueue).not.toHaveBeenCalled(); // and nothing was appended
    expect(station.setUpcomingRadio).not.toHaveBeenCalled();

    release([meta("sssssssssss")]);
    expect((await stationPick)?.videoId).toBe("sssssssssss"); // the station still got its track
  });

  it("releases the lock when the underlying FETCH rejects, so a later call still works", async () => {
    // A rejecting related() is swallowed into "no candidates" (best-effort by contract), but the
    // production still has to hand the lock back. A lock left held would disable radio for the
    // LIFETIME of the process — permanent dry-hold, no error, no recovery — which is the exact
    // failure class this whole change exists to kill.
    let fail = true;
    const related = vi.fn(async () => {
      if (fail) throw new Error("yt-dlp exploded");
      return [meta("sssssssssss")];
    });
    const { station } = fakeStation(meta("aaaaaaaaaaa"), {
      current: null,
      upcoming: [],
      history: [], // nothing to replay, so a failed fetch really does mean null this round
    });
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      maxAutoplayDurationSec: 0,
      settings: radioSettings,
    });
    await expect(r.nextCandidate()).resolves.toBeNull(); // failed lookup → no pick this round
    fail = false;
    expect((await r.nextCandidate())?.videoId).toBe("sssssssssss"); // radio is NOT wedged
  });

  it("releases the lock when a production REJECTS outright, so a later call still works", async () => {
    // Harder case: fetch errors are swallowed, so a rejection out of nextCandidate means a dep
    // violated its contract and threw. The pending-count is dropped in a `finally` and the Mutex
    // keeps its chain alive across rejections, so the very next caller runs normally.
    let blowUp = true;
    const settings = vi.fn(() => {
      if (blowUp) throw new Error("settings dep blew up");
      return { autoplay: true, autoplaySource: "radio" as AutoplaySource };
    });
    const related = vi.fn(async () => [meta("sssssssssss"), meta("ttttttttttt")]);
    const { station } = fakeStation(meta("aaaaaaaaaaa"), {
      current: null,
      upcoming: [],
      history: [],
    });
    const r = new RadioEngine({
      youtube: { related, artistTracks: vi.fn() },
      station: station as unknown as RadioDeps["station"],
      maxAutoplayDurationSec: 0,
      settings,
    });
    await expect(r.nextCandidate()).rejects.toThrow("settings dep blew up");
    blowUp = false;
    expect((await r.nextCandidate())?.videoId).toBe("sssssssssss"); // lock was NOT left wedged
    // …and a rejected run must not leave a phantom pending production behind either, or the
    // optional top-up would back off forever and the queue would never be filled ahead.
    await r.ensureAhead(1);
    expect(station.enqueue).toHaveBeenCalled();
  });
});
