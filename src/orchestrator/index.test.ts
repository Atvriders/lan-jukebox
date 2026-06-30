import { describe, it, expect, vi } from "vitest";
import { StationController } from "./index.js";
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
  const download = vi.fn(async (id: string) => ({ path: `/cache/${id}.m4a` }));
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
      download: vi.fn(async (id) => ({ path: id })),
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
      return { path: `/cache/${id}.m4a` };
    });
    const c = new StationController({ download, now: () => 1_000 });
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
});
