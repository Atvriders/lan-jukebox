import { describe, it, expect, vi } from "vitest";
import { BrowserPlayerSink } from "./browser-player-sink.js";
import type { ServerPlayerMessage } from "../types/index.js";

function sinkWithSpy() {
  const sent: ServerPlayerMessage[] = [];
  const sink = new BrowserPlayerSink();
  sink.setSend((m) => sent.push(m));
  return { sink, sent };
}

describe("BrowserPlayerSink", () => {
  it("play() sends load then play", () => {
    const { sink, sent } = sinkWithSpy();
    sink.play({ audioUrl: "/audio/x", startMs: 5000 });
    expect(sent).toEqual([{ type: "load", audioUrl: "/audio/x", startMs: 5000 }, { type: "play" }]);
  });

  it("pause/resume/seek/setVolume serialize the right messages", () => {
    const { sink, sent } = sinkWithSpy();
    sink.pause();
    sink.resume();
    sink.seek(1234);
    sink.setVolume(80);
    expect(sent).toEqual([
      { type: "pause" },
      { type: "play" },
      { type: "seek", ms: 1234 },
      { type: "setVolume", pct: 80 },
    ]);
  });

  it("skip(), stop() and relinquish() send pause (controller drives the advance, sink never tears down)", () => {
    const { sink, sent } = sinkWithSpy();
    sink.skip();
    sink.stop();
    sink.relinquish();
    expect(sent).toEqual([{ type: "pause" }, { type: "pause" }, { type: "pause" }]);
  });

  it("onTrackEnded() emits 'trackEnd'; onPlaybackError() emits 'error' with the message", () => {
    const sink = new BrowserPlayerSink();
    const ended = vi.fn();
    const err = vi.fn();
    sink.on("trackEnd", ended);
    sink.on("error", err);
    sink.onTrackEnded();
    sink.onPlaybackError("decode failed");
    expect(ended).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith("decode failed");
  });

  it("no send attached → commands are silently dropped (no throw)", () => {
    const sink = new BrowserPlayerSink();
    expect(() => sink.play({ audioUrl: "/audio/x", startMs: 0 })).not.toThrow();
  });

  it("setSend(null) detaches; destroy() detaches and removes listeners", () => {
    const { sink, sent } = sinkWithSpy();
    sink.setSend(null);
    sink.play({ audioUrl: "/audio/y", startMs: 0 });
    expect(sent).toEqual([]);
    const ended = vi.fn();
    sink.on("trackEnd", ended);
    sink.destroy();
    sink.onTrackEnded();
    expect(ended).not.toHaveBeenCalled();
  });

  it("exposes NO idle behavior (no 'idle' event ever fires)", () => {
    const { sink } = sinkWithSpy();
    const idle = vi.fn();
    sink.on("idle", idle);
    sink.play({ audioUrl: "/audio/z", startMs: 0 });
    sink.skip();
    sink.stop();
    expect(idle).not.toHaveBeenCalled();
  });
});
