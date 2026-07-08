import { describe, it, expect, vi } from "vitest";
import { StationController } from "./index.js";
import { Queue } from "../queue/index.js";
import { BrowserPlayerSink } from "./browser-player-sink.js";
import type { Requester, TrackMeta, ServerPlayerMessage } from "../types/index.js";

const user: Requester = { deviceId: "d1", displayName: "u", source: "user" };
function meta(id: string, durationSec = 100): TrackMeta {
  return {
    videoId: id,
    title: id,
    channel: "c",
    durationSec,
    isLive: false,
    thumbnailUrl: null,
  };
}
function fakeSink() {
  const sent: ServerPlayerMessage[] = [];
  const sink = new BrowserPlayerSink();
  sink.setSend((m) => sent.push(m));
  return { sink, sent };
}
function controller() {
  const download = vi.fn(async (id: string) => ({ path: `/cache/${id}.m4a`, audio: null }));
  const c = new StationController({ download, now: () => 1_000 });
  return { c, download };
}

describe("StationController core", () => {
  it("enqueue from a user sets the seed; autoplay requester does NOT", async () => {
    const { c } = controller();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    expect(c.seed?.videoId).toBe("aaaaaaaaaaa");
    await c.enqueue(meta("bbbbbbbbbbb"), {
      deviceId: "autoplay",
      displayName: "Autoplay",
      source: "autoplay",
    });
    expect(c.seed?.videoId).toBe("aaaaaaaaaaa"); // unchanged by radio adds
  });

  it("attaching a sink loads + plays the head track (download then load+play)", async () => {
    const { c, download } = controller();
    const { sink, sent } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(download).toHaveBeenCalledWith("aaaaaaaaaaa", expect.anything()));
    await vi.waitFor(() =>
      expect(sent.some((m) => m.type === "load" && m.audioUrl === "/audio/aaaaaaaaaaa")).toBe(true),
    );
    expect(sent.some((m) => m.type === "play")).toBe(true);
    expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
  });

  it("sink 'trackEnd' advances exactly once (an error+trackEnd pair does not double-skip)", async () => {
    const { c } = controller();
    const { sink } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    await c.enqueue(meta("bbbbbbbbbbb"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    sink.onPlaybackError("boom");
    sink.onTrackEnded(); // same generation — must be ignored
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb"));
    expect(c.snapshot().upcoming).toHaveLength(0);
  });

  it("queue-dry with NO radio continuation holds paused, current preserved (no stop/teardown)", async () => {
    const { c } = controller();
    const { sink } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    sink.onTrackEnded(); // no upcoming, no radio
    await vi.waitFor(() => expect(c.isPaused).toBe(true));
    // seed AND last current/position preserved (no teardown, no state clearing)
    expect(c.seed?.videoId).toBe("aaaaaaaaaaa");
    expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
    expect(c.snapshot().current?.positionMs).toBeTypeOf("number");
  });

  it("queue-dry WITH a radio continuation plays the radio track tagged fromRadio", async () => {
    const { c } = controller();
    const { sink } = fakeSink();
    c.setRadioContinuation(async () => meta("rrrrrrrrrrr"));
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    sink.onTrackEnded();
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("rrrrrrrrrrr"));
    expect(c.snapshot().current?.fromRadio).toBe(true);
  });

  it("pause()/resume() forward to the sink and flip isPaused", async () => {
    const { c } = controller();
    const { sink, sent } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current).not.toBeNull());
    c.pause();
    expect(c.isPaused).toBe(true);
    expect(sent.some((m) => m.type === "pause")).toBe(true);
    c.resume();
    expect(c.isPaused).toBe(false);
  });

  it("seek(ms) clamps to [0,durationMs], re-anchors position, and sends a seek", async () => {
    const { c } = controller();
    const { sink, sent } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa", 100), user); // 100_000 ms
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current).not.toBeNull());
    await expect(c.seek(-1)).rejects.toThrow(RangeError);
    await expect(c.seek(999_999)).rejects.toThrow(RangeError);
    const ok = await c.seek(30_000);
    expect(ok).toBe(true);
    expect(sent.some((m) => m.type === "seek" && m.ms === 30_000)).toBe(true);
  });

  it("detachSink() pauses and preserves seed/current/position; no advance fires after detach", async () => {
    const { c } = controller();
    const { sink } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    await c.enqueue(meta("bbbbbbbbbbb"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    c.detachSink();
    expect(c.isPaused).toBe(true);
    expect(c.activeSink).toBe(false);
    sink.onTrackEnded(); // detached sink must NOT advance the controller
    expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
  });

  it("updateSettings clamps via applySettingsPatch and fires onSettingsChanged", async () => {
    const onSettingsChanged = vi.fn();
    const c = new StationController({
      download: vi.fn(async (id) => ({ path: id, audio: null })),
      onSettingsChanged,
    });
    const out = c.updateSettings({ volume: 999, repeat: "all" });
    expect(out.volume).toBe(200);
    expect(out.repeat).toBe("all");
    expect(onSettingsChanged).toHaveBeenCalledWith(out);
  });

  it("a stale/duplicate trackEnd during a dry-hold is ignored (generation re-armed)", async () => {
    // Finding: playGeneration was not re-armed on the dry-hold path, so a duplicate <audio> 'ended'
    // (or a late error) escaped the held-paused state and double-advanced. The browser <audio> can
    // legitimately emit a duplicate 'ended', delivered straight over WS with no de-dup.
    const { c } = controller();
    const { sink } = fakeSink();
    // two tracks queued ahead, all delivered via stale duplicate signals to prove they're ignored
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    sink.onTrackEnded(); // queue dry, no radio → hold paused, current A preserved
    await vi.waitFor(() => expect(c.isPaused).toBe(true));
    expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
    // a STALE / duplicate 'ended' from already-finished A must NOT escape the held-paused state
    sink.onTrackEnded();
    sink.onTrackEnded();
    await new Promise((r) => setTimeout(r, 15));
    expect(c.isPaused).toBe(true);
    expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"); // unchanged, still held
  });

  it("enqueue() restarts a station that is holding paused on a dry queue (never-stops)", async () => {
    // Finding: after a dry-hold, enqueue's `!_paused` guard blocked auto-start, so a user adding a
    // song never restarted the station and resume() could not recover it.
    const { c, download } = controller();
    const { sink } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    sink.onTrackEnded(); // drain → hold paused
    await vi.waitFor(() => expect(c.isPaused).toBe(true));
    download.mockClear();
    await c.enqueue(meta("ddddddddddd"), user); // adding a song MUST restart the station
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("ddddddddddd"));
    expect(c.isPaused).toBe(false);
    expect(download).toHaveBeenCalledWith("ddddddddddd", expect.anything());
  });

  it("resume() restarts a dry-held station by advancing into newly queued tracks", async () => {
    const { c } = controller();
    const { sink } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    sink.onTrackEnded();
    await vi.waitFor(() => expect(c.isPaused).toBe(true));
    // queue a track while held, but don't let enqueue auto-start it: simulate by pausing first?
    // Simpler: drop a track into the queue then call resume() which must promote it.
    await c.queue.add(meta("eeeeeeeeeee"), user);
    c.resume();
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("eeeeeeeeeee"));
    expect(c.isPaused).toBe(false);
  });

  it("a download failure that drains the queue holds paused AND re-arms against stale signals", async () => {
    // Finding (second route): error on A → advance to B → B download throws → dry-hold without
    // re-arm; a later stale signal then escaped the hold.
    let calls = 0;
    const download = vi.fn(async (id: string) => {
      calls += 1;
      if (id === "bbbbbbbbbbb") throw new Error("dl fail");
      return { path: `/cache/${id}.m4a`, audio: null };
    });
    // radioRetryBaseMs:0 neutralizes the download-failure backoff so the dry-hold is reached
    // synchronously (the backoff's real duration is exercised elsewhere).
    const c = new StationController({ download, now: () => 1_000, radioRetryBaseMs: 0 });
    const { sink } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    await c.enqueue(meta("bbbbbbbbbbb"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    sink.onPlaybackError("boom"); // discard A → advance to B → B download throws → dry-hold
    await vi.waitFor(() => expect(c.isPaused).toBe(true));
    await c.enqueue(meta("ccccccccccc"), user); // restarts station
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("ccccccccccc"));
    const callsAfter = calls;
    sink.onTrackEnded(); // STALE duplicate signal from the failed B sequence
    await new Promise((r) => setTimeout(r, 15));
    expect(c.snapshot().current?.meta.videoId).toBe("ccccccccccc");
    expect(calls).toBe(callsAfter); // no spurious extra advance/download from the stale signal
  });

  it("restore() drops a non-string seed (cold start) and skips malformed upcomingRadio items", async () => {
    const { c } = controller();
    const good = {
      id: "r-good",
      meta: meta("rrrrrrrrrrr"),
      requester: user,
      addedAt: 0,
      audio: null,
      fromRadio: true,
    };
    await c.restore({
      version: 1,
      savedAt: 0,
      seed: { videoId: 12345, title: null } as unknown as TrackMeta, // malformed
      current: null,
      positionMs: 0,
      queue: [],
      upcomingRadio: [
        {
          id: "r1",
          meta: null,
          requester: null,
          addedAt: 0,
          audio: null,
          fromRadio: true,
        } as never,
        good,
      ],
      history: [],
      settings: c.settings,
      activePlayerDeviceId: null,
    });
    expect(c.seed).toBeNull(); // malformed seed dropped → cold start
    const radio = c.snapshot().upcomingRadio;
    expect(radio).toHaveLength(1);
    expect(radio[0]?.meta.videoId).toBe("rrrrrrrrrrr");
  });

  it("restore() rehydrates persisted history into the snapshot (History panel survives restart)", async () => {
    const { c } = controller();
    const hist = (id: string) => ({
      id: `h-${id}`,
      meta: meta(id),
      requester: user,
      addedAt: 0,
      audio: null,
      fromRadio: false,
    });
    await c.restore({
      version: 1,
      savedAt: 0,
      seed: meta("aaaaaaaaaaa"),
      current: null,
      positionMs: 0,
      queue: [],
      upcomingRadio: [],
      history: [
        hist("aaaaaaaaaaa"),
        {
          id: "bad",
          meta: null,
          requester: null,
          addedAt: 0,
          audio: null,
          fromRadio: false,
        } as never,
        hist("bbbbbbbbbbb"),
      ],
      settings: c.settings,
      activePlayerDeviceId: null,
    });
    const restored = c.snapshot().history;
    // The malformed middle entry is skipped; the two valid ones are restored in order.
    expect(restored.map((i) => i.meta.videoId)).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb"]);
  });

  it("restore() coerces a non-finite positionMs to 0 (never serializes NaN)", async () => {
    const { c } = controller();
    const cur = {
      id: "c1",
      meta: meta("aaaaaaaaaaa"),
      requester: user,
      addedAt: 0,
      audio: null,
      fromRadio: false,
    };
    await c.restore({
      version: 1,
      savedAt: 0,
      seed: meta("aaaaaaaaaaa"),
      current: cur,
      positionMs: NaN as unknown as number,
      queue: [],
      upcomingRadio: [],
      history: [],
      settings: c.settings,
      activePlayerDeviceId: null,
    });
    const pos = c.snapshot().current?.positionMs;
    expect(Number.isFinite(pos)).toBe(true);
    expect(pos).toBe(0);
  });

  it("snapshot() flattens settings + exposes seed/paused/preparing/upcomingRadio", async () => {
    const { c } = controller();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    const s = c.snapshot();
    expect(s.seed?.videoId).toBe("aaaaaaaaaaa");
    expect(s.repeat).toBe("off");
    expect(s.volume).toBe(100);
    expect(Array.isArray(s.upcomingRadio)).toBe(true);
    expect(s.activePlayerPresent).toBe(false);
  });

  it("emits a 'trackError' (videoId/title/reason) when the browser reports a playback error", async () => {
    const { c } = controller();
    const { sink } = fakeSink();
    const errors: Array<{ videoId: string; title: string; reason: string }> = [];
    c.on("trackError", (e) => errors.push(e as (typeof errors)[number]));
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    await c.enqueue(meta("bbbbbbbbbbb"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    sink.onPlaybackError("decode failed");
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb"));
    expect(errors).toEqual([
      { videoId: "aaaaaaaaaaa", title: "aaaaaaaaaaa", reason: "decode failed" },
    ]);
  });

  it("emits a 'trackError' when the download fails, then skips to the next track", async () => {
    const download = vi.fn(async (id: string) => {
      if (id === "aaaaaaaaaaa") throw new Error("410 gone");
      return { path: `/cache/${id}.m4a`, audio: null };
    });
    const c = new StationController({ download, now: () => 1_000 });
    const { sink } = fakeSink();
    const errors: Array<{ videoId: string; title: string; reason: string }> = [];
    c.on("trackError", (e) => errors.push(e as (typeof errors)[number]));
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    await c.enqueue(meta("bbbbbbbbbbb"), user);
    c.attachSink(sink);
    // The failed download is discarded and the station advances to the next track.
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb"));
    expect(errors).toEqual([{ videoId: "aaaaaaaaaaa", title: "aaaaaaaaaaa", reason: "410 gone" }]);
  });

  it("does not emit a duplicate 'trackError' for a stale error+trackEnd pair (advance-once guard)", async () => {
    const { c } = controller();
    const { sink } = fakeSink();
    const errors: unknown[] = [];
    c.on("trackError", (e) => errors.push(e));
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    await c.enqueue(meta("bbbbbbbbbbb"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    sink.onPlaybackError("boom");
    sink.onTrackEnded(); // stale — same generation, must be ignored (no second trackError)
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb"));
    expect(errors).toHaveLength(1);
  });
});

describe("StationController threads track duration into download/prefetch (timeout auto-scaling)", () => {
  // Regression: scaleDownloadTimeout() scales the yt-dlp timeout by track duration, but every
  // caller omitted durationSec, so long mixes/concerts were SIGKILLed at the short default.
  // The controller must forward item.meta.durationSec to BOTH the download dep (current track)
  // and the prefetch dep (upcoming head) so the timeout can scale.
  it("passes the current item's durationSec into the download dep", async () => {
    const download = vi.fn(async (id: string) => ({ path: `/cache/${id}.m4a`, audio: null }));
    const c = new StationController({ download, now: () => 1_000 });
    const sink = new BrowserPlayerSink();
    sink.setSend(() => {});
    await c.enqueue(meta("aaaaaaaaaaa", 4200), user); // a ~70-min mix
    c.attachSink(sink);
    await vi.waitFor(() => expect(download).toHaveBeenCalled());
    // The 2nd arg is the opts object — it must carry the track's real duration, not undefined.
    expect(download).toHaveBeenCalledWith(
      "aaaaaaaaaaa",
      expect.objectContaining({ durationSec: 4200 }),
    );
  });

  it("passes the upcoming head's durationSec into the prefetch dep", async () => {
    const download = vi.fn(async (id: string) => ({ path: `/cache/${id}.m4a`, audio: null }));
    const prefetch = vi.fn(async () => {});
    const c = new StationController({ download, prefetch, now: () => 1_000 });
    const sink = new BrowserPlayerSink();
    sink.setSend(() => {});
    // Head plays; the second item becomes the prefetch target (upcoming head).
    await c.enqueue(meta("aaaaaaaaaaa", 100), user);
    await c.enqueue(meta("bbbbbbbbbbb", 5400), user); // a ~90-min concert
    c.attachSink(sink);
    await vi.waitFor(() => expect(prefetch).toHaveBeenCalledWith("bbbbbbbbbbb", 5400));
  });
});

describe("StationController honors an injected Queue's historyMax (HISTORY_MAX_ITEMS wiring)", () => {
  // Regression: index.ts constructed StationController WITHOUT a queue dep, so the configured
  // HISTORY_MAX_ITEMS never reached the Queue (fell back to the default 100). The controller
  // must use the injected Queue, whose historyMax bounds the history ring.
  it("bounds the history ring to the injected Queue's historyMax", async () => {
    const download = vi.fn(async (id: string) => ({ path: `/cache/${id}.m4a`, audio: null }));
    const queue = new Queue({ historyMax: 2 });
    const c = new StationController({ queue, download, now: () => 1_000 });
    const sink = new BrowserPlayerSink();
    sink.setSend(() => {});
    for (const id of ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd"]) {
      await c.enqueue(meta(id), user);
    }
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    // Cleanly finish three tracks; with historyMax=2 the ring must never exceed 2 entries.
    sink.onTrackEnded();
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb"));
    sink.onTrackEnded();
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("ccccccccccc"));
    sink.onTrackEnded();
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("ddddddddddd"));
    expect(c.snapshot().history.length).toBeLessThanOrEqual(2);
  });
});

describe("StationController pin/unpin lifecycle (cache pins must not grow without bound)", () => {
  // Regression: deps.unpin was declared+wired but never called, so every played track stayed
  // pinned forever, defeating LRU eviction and eventually filling the disk. The controller must
  // unpin the PREVIOUS track when a different track becomes current.
  it("unpins the previous track's videoId when the next track loads", async () => {
    const download = vi.fn(async (id: string) => ({ path: `/cache/${id}.m4a`, audio: null }));
    const pin = vi.fn();
    const unpin = vi.fn();
    const c = new StationController({ download, pin, unpin, now: () => 1_000 });
    const sink = new BrowserPlayerSink();
    sink.setSend(() => {});
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    await c.enqueue(meta("bbbbbbbbbbb"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    expect(pin).toHaveBeenCalledWith("aaaaaaaaaaa", expect.any(String), null);
    expect(unpin).not.toHaveBeenCalled(); // nothing to unpin on the first track
    sink.onTrackEnded();
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb"));
    // The now-retired track is unpinned; the fresh one is pinned.
    expect(unpin).toHaveBeenCalledWith("aaaaaaaaaaa");
    expect(pin).toHaveBeenCalledWith("bbbbbbbbbbb", expect.any(String), null);
  });
});

describe("StationController dry-hold radio self-retry (transient outage must self-heal)", () => {
  // Regression: when the queue drained and radioContinuation() returned null for a TRANSIENT
  // failure, the station parked in dry-hold forever with no self-retry, violating "when the queue
  // drains it autoplays related tracks forever". Entering dry-hold with a seed present + a radio
  // continuation wired must schedule a backing-off re-attempt.
  it("re-attempts radio on a timer and resumes autoplay when it recovers", async () => {
    const download = vi.fn(async (id: string) => ({ path: `/cache/${id}.m4a`, audio: null }));
    let fire: (() => void) | null = null;
    const setTimeoutFn = vi.fn((fn: () => void) => {
      fire = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimeoutFn = vi.fn();
    // Radio fails the first time (transient), then recovers.
    let radioUp = false;
    const c = new StationController({
      download,
      now: () => 1_000,
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
      radioRetryBaseMs: 5_000,
    });
    c.setRadioContinuation(async () => (radioUp ? meta("rrrrrrrrrrr") : null));
    const sink = new BrowserPlayerSink();
    sink.setSend(() => {});
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    sink.onTrackEnded(); // queue drains, radio returns null → dry-hold + a scheduled retry
    await vi.waitFor(() => expect(c.isPaused).toBe(true));
    expect(setTimeoutFn).toHaveBeenCalled(); // a retry was armed
    // Upstream recovers; fire the retry timer.
    radioUp = true;
    expect(fire).not.toBeNull();
    fire!();
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("rrrrrrrrrrr"));
    expect(c.isPaused).toBe(false);
  });

  it("never permanently gives up: keeps re-arming the radio retry far past any fixed cap", async () => {
    // Regression: the retry was hard-capped at 10 attempts and the counter only reset on a
    // successful load. With a PERSISTENTLY-unavailable upstream no load ever happens, so after 10
    // backoffs the station parked in dry-hold forever ("plays one song then stops for good"). The
    // always-on station must re-arm indefinitely (delay clamped to a steady poll) so it self-heals.
    const download = vi.fn(async (id: string) => ({ path: `/cache/${id}.m4a`, audio: null }));
    let fire: (() => void) | null = null;
    const setTimeoutFn = vi.fn((fn: () => void) => {
      fire = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const c = new StationController({
      download,
      now: () => 1_000,
      setTimeout: setTimeoutFn,
      clearTimeout: vi.fn(),
      radioRetryBaseMs: 5_000,
    });
    c.setRadioContinuation(async () => null); // radio NEVER recovers
    const sink = new BrowserPlayerSink();
    sink.setSend(() => {});
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    sink.onTrackEnded(); // drain → dry-hold → retry #1 armed
    await vi.waitFor(() => expect(fire).not.toBeNull());
    // Fire the retry timer far more than the old 10-attempt cap; each null result must re-arm.
    for (let i = 0; i < 15; i++) {
      const f = fire!;
      fire = null;
      f();
      await vi.waitFor(() => expect(fire).not.toBeNull()); // a fresh retry keeps being scheduled
    }
    expect(setTimeoutFn.mock.calls.length).toBeGreaterThan(12); // old code stopped at 10
  });

  it("does NOT schedule a radio retry on a genuine cold start (no seed)", async () => {
    const download = vi.fn(async (id: string) => ({ path: `/cache/${id}.m4a`, audio: null }));
    const setTimeoutFn = vi.fn((fn: () => void) => {
      void fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const c = new StationController({
      download,
      now: () => 1_000,
      setTimeout: setTimeoutFn,
      clearTimeout: vi.fn(),
    });
    c.setRadioContinuation(async () => null);
    const sink = new BrowserPlayerSink();
    sink.setSend(() => {});
    c.attachSink(sink); // no seed, nothing queued → cold dry-hold
    await vi.waitFor(() => expect(c.isPaused).toBe(true));
    expect(setTimeoutFn).not.toHaveBeenCalled();
  });
});

describe("StationController download-failure backoff (mass outage must not burst yt-dlp)", () => {
  // Regression: a whole-feed download outage walked the candidate list with ZERO delay, firing a
  // tight burst of failed yt-dlp spawns. A failed download must back off (via the injectable timer)
  // before walking to the next candidate.
  it("backs off (via the injectable timer) on CONSECUTIVE download failures, but not the first", async () => {
    // a & b fail (consecutive), c succeeds.
    const download = vi.fn(async (id: string) => {
      if (id === "aaaaaaaaaaa" || id === "bbbbbbbbbbb") throw new Error("410 gone");
      return { path: `/cache/${id}.m4a`, audio: null };
    });
    const delays: number[] = [];
    const setTimeoutFn = vi.fn((fn: () => void, ms: number) => {
      delays.push(ms);
      fn(); // resolve immediately so the test doesn't wait real wall-clock
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const c = new StationController({
      download,
      now: () => 1_000,
      setTimeout: setTimeoutFn,
      clearTimeout: vi.fn(),
    });
    const sink = new BrowserPlayerSink();
    sink.setSend(() => {});
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    await c.enqueue(meta("bbbbbbbbbbb"), user);
    await c.enqueue(meta("ccccccccccc"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("ccccccccccc"));
    // The SECOND consecutive failure (b) applied a non-zero backoff before walking to c; the
    // first (a) did not, so an isolated bad track never adds latency.
    expect(delays.some((d) => d > 0)).toBe(true);
  });
});

// A download dep whose resolution the test controls, so we can exercise the mid-load window
// (pause/seek/skip arriving WHILE a track is still downloading).
function deferredDownload() {
  let resolveFn: (() => void) | null = null;
  const download = vi.fn(
    (id: string) =>
      new Promise<{ path: string; audio: null }>((res) => {
        resolveFn = () => res({ path: `/cache/${id}.m4a`, audio: null });
      }),
  );
  return { download, resolve: () => resolveFn?.() };
}

describe("StationController repeat mode (finding: repeat was stored/broadcast but never enforced)", () => {
  it('repeat="one" replays the SAME current from 0 on a clean track end (does not advance)', async () => {
    const { c } = controller();
    const { sink, sent } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    await c.enqueue(meta("bbbbbbbbbbb"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    c.updateSettings({ repeat: "one" });
    const loadsBefore = sent.filter((m) => m.type === "load").length;
    sink.onTrackEnded(); // clean end under repeat="one" → replay A, NOT advance to B
    await vi.waitFor(() =>
      expect(sent.filter((m) => m.type === "load").length).toBeGreaterThan(loadsBefore),
    );
    expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"); // still A
    expect(c.snapshot().upcoming.map((i) => i.meta.videoId)).toEqual(["bbbbbbbbbbb"]); // B untouched
  });

  it('repeat="all" re-cycles the played set when the queue drains (no radio) instead of dry-holding', async () => {
    const { c } = controller();
    const { sink } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    await c.enqueue(meta("bbbbbbbbbbb"), user);
    c.updateSettings({ repeat: "all" });
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    sink.onTrackEnded(); // A → B
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb"));
    sink.onTrackEnded(); // queue now dry, no radio → repeat="all" recycles [A, B] and plays A again
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    expect(c.isPaused).toBe(false); // NOT dry-held
    expect(c.snapshot().upcoming.map((i) => i.meta.videoId)).toEqual(["bbbbbbbbbbb"]); // B re-queued
  });

  it('repeat="off" (default) still advances normally on a clean end', async () => {
    const { c } = controller();
    const { sink } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    await c.enqueue(meta("bbbbbbbbbbb"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    sink.onTrackEnded();
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb"));
  });
});

describe("StationController persisted-history restore (finding: history saved but never restored)", () => {
  it("restore() populates the history ring from file.history (validated, honoring historyMax)", async () => {
    const queue = new Queue({ historyMax: 2 });
    const download = vi.fn(async (id: string) => ({ path: `/cache/${id}.m4a`, audio: null }));
    const c = new StationController({ queue, download, now: () => 1_000 });
    const hist = (id: string) => ({
      id: `h-${id}`,
      meta: meta(id),
      requester: user,
      addedAt: 0,
      audio: null,
      fromRadio: false,
    });
    await c.restore({
      version: 1,
      savedAt: 0,
      seed: meta("aaaaaaaaaaa"),
      current: null,
      positionMs: 0,
      queue: [],
      upcomingRadio: [],
      // three entries + one malformed; historyMax=2 keeps the most recent two valid ones.
      history: [
        hist("hhhhhhhhhh1"),
        {
          id: "bad",
          meta: null,
          requester: null,
          addedAt: 0,
          audio: null,
          fromRadio: false,
        } as never,
        hist("hhhhhhhhhh2"),
        hist("hhhhhhhhhh3"),
      ],
      settings: c.settings,
      activePlayerDeviceId: null,
    });
    const restored = c.snapshot().history.map((i) => i.meta.videoId);
    expect(restored).toEqual(["hhhhhhhhhh2", "hhhhhhhhhh3"]); // trimmed to historyMax, malformed dropped
  });
});

describe("StationController forwards AudioInfo (finding: audio dropped → QueueItem.audio stays null)", () => {
  it("sets the current QueueItem.audio and pins with the real audio after download", async () => {
    const audioInfo = { codec: "opus", bitrateKbps: 160, sampleRateHz: 48000 };
    const download = vi.fn(async (id: string) => ({ path: `/cache/${id}.m4a`, audio: audioInfo }));
    const pin = vi.fn();
    const c = new StationController({ download, pin, now: () => 1_000 });
    const sink = new BrowserPlayerSink();
    sink.setSend(() => {});
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    // QueueItem.audio is populated (contract: null until downloaded, then the real format).
    await vi.waitFor(() => expect(c.snapshot().current?.audio).toEqual(audioInfo));
    // pin is called WITH the audio so the cache/audio-route can serve playable formats as-is.
    expect(pin).toHaveBeenCalledWith("aaaaaaaaaaa", expect.any(String), audioInfo);
  });
});

describe("StationController mid-load user controls (concurrency findings)", () => {
  it("a pause() during an in-flight download survives: the track loads paused, no auto-play", async () => {
    const { download, resolve } = deferredDownload();
    const c = new StationController({ download, now: () => 1_000 });
    const { sink, sent } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(download).toHaveBeenCalled()); // load is in flight (awaiting)
    c.pause(); // user pauses WHILE downloading
    resolve(); // download completes
    await vi.waitFor(() => expect(sent.some((m) => m.type === "load")).toBe(true));
    expect(c.isPaused).toBe(true); // pause survived
    expect(sent.some((m) => m.type === "play")).toBe(false); // did NOT auto-play over the pause
  });

  it("a seek() during an in-flight download is applied to the completed load's start position", async () => {
    const { download, resolve } = deferredDownload();
    const c = new StationController({ download, now: () => 1_000 });
    const { sink, sent } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa", 100), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(download).toHaveBeenCalled());
    await c.seek(30_000); // seek WHILE downloading
    resolve();
    await vi.waitFor(() => expect(sent.some((m) => m.type === "load")).toBe(true));
    const load = sent.find((m) => m.type === "load");
    expect(load && "startMs" in load ? load.startMs : -1).toBe(30_000); // seek honored, not startMs 0
  });

  it("a skip() pressed while a track is loading is NOT dropped by the generation guard", async () => {
    const { download, resolve } = deferredDownload();
    const c = new StationController({ download, now: () => 1_000 });
    const { sink } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    await c.enqueue(meta("bbbbbbbbbbb"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(download).toHaveBeenCalledWith("aaaaaaaaaaa", expect.anything()));
    c.skip(); // pressed WHILE A is still downloading — must not be a silent no-op
    resolve(); // A's download completes; skip's queued advance then runs, downloading B
    // now-playing pins to the actually-loaded track: until B's download completes the card must
    // NOT jump to B (that was the "now-playing shows a not-yet-playing track" bug). Wait for B's
    // download to be requested, then complete it so B genuinely becomes live.
    await vi.waitFor(() => expect(download).toHaveBeenCalledWith("bbbbbbbbbbb", expect.anything()));
    resolve(); // B's download completes → B is what the sink actually loaded
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb"));
  });
});

describe("StationController now-playing derivation (finding: snapshot showed the raw queue head)", () => {
  // Regression: snapshot().current was derived from the raw queue head, which advances the instant
  // a promotion happens — but the sink isn't told to load the next track until its (slow) download
  // completes. During that window now-playing rendered the not-yet-playing track (and overlaid the
  // old track's elapsed time onto the new track's duration). It must instead pin to the track the
  // sink was actually last told to play until the next one genuinely loads.
  it("keeps now-playing on the live track (and its duration) while the NEXT track downloads", async () => {
    const { download, resolve } = deferredDownload();
    const c = new StationController({ download, now: () => 1_000 });
    const { sink } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa", 100), user); // A: 100s
    await c.enqueue(meta("bbbbbbbbbbb", 200), user); // B: 200s
    c.attachSink(sink);
    await vi.waitFor(() => expect(download).toHaveBeenCalledWith("aaaaaaaaaaa", expect.anything()));
    resolve(); // A finishes downloading → A is the live track
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    sink.onTrackEnded(); // advance to B; B begins downloading (deferred, not resolved yet)
    await vi.waitFor(() => expect(download).toHaveBeenCalledWith("bbbbbbbbbbb", expect.anything()));
    // B is NOT live yet — now-playing must still be A, with A's duration (not B's 200s).
    expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
    expect(c.snapshot().current?.durationMs).toBe(100_000);
    resolve(); // B finishes → now B is what the sink actually loaded
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb"));
    expect(c.snapshot().current?.durationMs).toBe(200_000);
  });

  it("still reports the promoted head before anything has ever loaded (cold restore)", async () => {
    // liveItemId===null (no sink has ever loaded a track): fall back to the queue head so a
    // restored/promoted track still shows in now-playing.
    const { c } = controller();
    await c.restore({
      version: 1,
      savedAt: 0,
      seed: meta("aaaaaaaaaaa"),
      current: {
        id: "c-1",
        meta: meta("aaaaaaaaaaa"),
        requester: user,
        addedAt: 0,
        audio: null,
        fromRadio: false,
      },
      positionMs: 0,
      queue: [],
      upcomingRadio: [],
      history: [],
      settings: c.settings,
      activePlayerDeviceId: null,
    });
    expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
  });
});

describe("StationController enqueue-race auto-start (finding: redundant reload restarts the head)", () => {
  it("two near-simultaneous cold-start enqueues do not re-load/restart the head track", async () => {
    const download = vi.fn(async (id: string) => ({ path: `/cache/${id}.m4a`, audio: null }));
    const c = new StationController({ download, now: () => 1_000 });
    const { sink } = fakeSink();
    c.attachSink(sink); // sink attached, nothing queued (cold start, current === null)
    // Fire two enqueues back-to-back before the first auto-start settles.
    await Promise.all([c.enqueue(meta("aaaaaaaaaaa"), user), c.enqueue(meta("bbbbbbbbbbb"), user)]);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    // Let any spurious second auto-start settle, then assert the head was downloaded exactly once
    // (a redundant reload would have called download("aaaaaaaaaaa", …) twice).
    await new Promise((r) => setTimeout(r, 20));
    expect(download.mock.calls.filter((call) => call[0] === "aaaaaaaaaaa")).toHaveLength(1);
  });
});

describe("StationController crossfadeAdvance", () => {
  it("advances current→next WITHOUT loading the sink (Player already crossfaded in)", async () => {
    const { c, download } = controller();
    const { sink, sent } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    await c.enqueue(meta("bbbbbbbbbbb"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    const loadsBefore = sent.filter((m) => m.type === "load" || m.type === "play").length;
    c.crossfadeAdvance();
    // Live track becomes b; the finished a is archived to history.
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb"));
    expect(c.snapshot().upcoming).toHaveLength(0);
    expect(c.snapshot().history.some((h) => h.meta.videoId === "aaaaaaaaaaa")).toBe(true);
    // Position reset to ~0 for the new track.
    expect(c.snapshot().current?.positionMs).toBe(0);
    // NO new load/play was sent for b (the Player already has it playing) and b was never downloaded.
    expect(sent.filter((m) => m.type === "load" || m.type === "play").length).toBe(loadsBefore);
    expect(sent.some((m) => m.type === "load" && m.audioUrl === "/audio/bbbbbbbbbbb")).toBe(false);
    expect(download.mock.calls.some((call) => call[0] === "bbbbbbbbbbb")).toBe(false);
  });

  it("fires prefetch of the NEW upcoming head + radioTopUp on crossfade advance", async () => {
    const prefetch = vi.fn(async () => {});
    const radioTopUp = vi.fn();
    const download = vi.fn(async (id: string) => ({ path: `/cache/${id}.m4a`, audio: null }));
    const c = new StationController({ download, prefetch, now: () => 1_000 });
    c.setRadioTopUp(radioTopUp);
    const { sink } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    await c.enqueue(meta("bbbbbbbbbbb"), user);
    await c.enqueue(meta("ccccccccccc"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    prefetch.mockClear();
    radioTopUp.mockClear();
    c.crossfadeAdvance();
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb"));
    // New upcoming head is c → it gets prefetched, and radio tops up.
    expect(prefetch).toHaveBeenCalledWith("ccccccccccc", expect.anything());
    expect(radioTopUp).toHaveBeenCalled();
  });

  it("no-op when there is no next track (Player sends trackEnded, not crossfadeAdvance)", async () => {
    const { c } = controller();
    const { sink, sent } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    const before = sent.length;
    c.crossfadeAdvance();
    await new Promise((r) => setTimeout(r, 20));
    // Still on a, nothing archived, no sink traffic — the normal end path owns this case.
    expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
    expect(c.snapshot().history).toHaveLength(0);
    expect(sent.length).toBe(before);
  });

  it("does NOT double-advance when a stale trackEnded races the crossfadeAdvance", async () => {
    const { c } = controller();
    const { sink } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    await c.enqueue(meta("bbbbbbbbbbb"), user);
    await c.enqueue(meta("ccccccccccc"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    // Both fire for the SAME (outgoing) track a: crossfadeAdvance re-arms the generation first, so
    // the trackEnded captured at the pre-bump generation is ignored — we land on b, not c.
    c.crossfadeAdvance();
    sink.onTrackEnded();
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb"));
    await new Promise((r) => setTimeout(r, 20));
    expect(c.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb"); // NOT advanced past to c
    expect(c.snapshot().upcoming.map((i) => i.meta.videoId)).toEqual(["ccccccccccc"]);
  });

  it("no-op with no sink attached", async () => {
    const { c } = controller();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    await c.enqueue(meta("bbbbbbbbbbb"), user);
    c.crossfadeAdvance();
    await new Promise((r) => setTimeout(r, 20));
    expect(c.snapshot().history).toHaveLength(0);
  });
});

// Regression: clear() must truly idle the station and must NOT be un-idled by an advance chain
// that was already in flight when Clear was pressed (audit finding — the "never stops" invariant
// inverted: playback resurrecting AFTER a clear). clear() runs outside the lock and bumps the
// advance generation; the in-flight chain re-checks that generation after every real await.
describe("StationController clear() supersedes an in-flight advance (no resurrect)", () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it("clear() during an in-flight load abandons it — no play, station idle", async () => {
    const { download, resolve } = deferredDownload();
    const c = new StationController({ download, now: () => 1_000 });
    const { sink, sent } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    c.attachSink(sink); // begins loading A; download is pending (not resolved)
    await vi.waitFor(() => expect(download).toHaveBeenCalledWith("aaaaaaaaaaa", expect.anything()));
    await c.clear(); // Clear WHILE A's download is in flight
    resolve(); // A's download completes AFTER the clear
    await tick(); // let loadCurrentLocked resume and hit the supersede guard
    expect(sent.some((m) => m.type === "load")).toBe(false); // A was never loaded
    expect(sent.some((m) => m.type === "play")).toBe(false); // …and never played
    expect(c.snapshot().current).toBeNull(); // station is idle
  });

  it("clear() while a load is FAILING does not restart radio (the stuck-download escape hatch)", async () => {
    let rejectFn: () => void = () => {};
    const download = vi.fn(
      () =>
        new Promise<{ path: string; audio: null }>((_res, rej) => {
          rejectFn = () => rej(new Error("timeout"));
        }),
    );
    const c = new StationController({ download, now: () => 1_000, radioRetryBaseMs: 0 });
    c.setRadioContinuation(async () => meta("ccccccccccc")); // radio WOULD resume if not guarded
    const { sink, sent } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    await c.clear(); // Clear WHILE A's (stuck) download is in flight
    rejectFn(); // the stuck download finally fails, AFTER the clear
    await tick();
    expect(c.snapshot().current).toBeNull(); // stayed idle; radio did NOT resume
    expect(sent.some((m) => m.type === "play")).toBe(false);
    expect(download).toHaveBeenCalledTimes(1); // never walked on to a radio track
  });

  it("clear() during the radio lookup does not add or play a radio track", async () => {
    const { download } = controller(); // instant download
    let resolveRadio: () => void = () => {};
    const c = new StationController({ download, now: () => 1_000 });
    c.setRadioContinuation(
      () =>
        new Promise<TrackMeta | null>((res) => {
          resolveRadio = () => res(meta("ccccccccccc"));
        }),
    );
    const { sink } = fakeSink();
    await c.enqueue(meta("aaaaaaaaaaa"), user);
    c.attachSink(sink);
    await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
    sink.onTrackEnded(); // A ends, queue dry → awaits radioContinuation (pending)
    await tick();
    await c.clear(); // Clear WHILE the radio lookup is pending
    resolveRadio(); // radio returns a track AFTER the clear
    await tick();
    expect(c.snapshot().current).toBeNull(); // radio track was neither added nor played
    expect(c.snapshot().upcoming).toEqual([]); // and left no stray radio item in the queue
  });
});
