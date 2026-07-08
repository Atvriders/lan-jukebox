// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePlayerRole } from "./usePlayerRole.js";

// A fake socket recording sends and letting the test inject server frames.
function makeWs() {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  return {
    sent: [] as string[],
    send(d: string) {
      this.sent.push(d);
    },
    addEventListener(t: string, fn: (e: unknown) => void) {
      (listeners[t] ??= []).push(fn);
    },
    removeEventListener() {},
    fireMessage(data: string) {
      (listeners.message ?? []).forEach((fn) => fn({ data }));
    },
  };
}

// Stub HTMLMediaElement methods jsdom doesn't implement.
beforeEach(() => {
  vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

describe("usePlayerRole", () => {
  it("sends becomePlayer when it becomes the speaker", () => {
    const ws = makeWs();
    renderHook(({ s }) => usePlayerRole(ws as unknown as WebSocket, s), {
      initialProps: { s: true },
    });
    expect(ws.sent.map((m) => JSON.parse(m).type)).toContain("becomePlayer");
  });
  it("sends relinquishPlayer when it stops being the speaker", () => {
    const ws = makeWs();
    const { rerender } = renderHook(({ s }) => usePlayerRole(ws as unknown as WebSocket, s), {
      initialProps: { s: true },
    });
    act(() => rerender({ s: false }));
    expect(ws.sent.map((m) => JSON.parse(m).type)).toContain("relinquishPlayer");
  });
  it("loads the audioUrl and applies setVolume from server frames", () => {
    const ws = makeWs();
    const { result } = renderHook(() => usePlayerRole(ws as unknown as WebSocket, true));
    const el = document.createElement("audio");
    act(() => {
      (result.current.audioRef as React.MutableRefObject<HTMLAudioElement | null>).current = el;
    });
    act(() => ws.fireMessage(JSON.stringify({ type: "load", audioUrl: "/audio/v1", startMs: 0 })));
    expect(el.getAttribute("src")).toBe("/audio/v1");
    act(() => ws.fireMessage(JSON.stringify({ type: "setVolume", pct: 50 })));
    expect(el.volume).toBeCloseTo(0.5);
    expect(result.current.volume).toBe(50);
  });
  it("keeps the element at max for >100% and reports the pct (no Web Audio available)", () => {
    // With no AudioContext (jsdom default), boost can't amplify; the element is pinned to
    // max (1.0) rather than left silent, and the UI still reflects the requested pct.
    const ws = makeWs();
    const { result } = renderHook(() => usePlayerRole(ws as unknown as WebSocket, true));
    const el = document.createElement("audio");
    act(() => {
      (result.current.audioRef as React.MutableRefObject<HTMLAudioElement | null>).current = el;
    });
    act(() => ws.fireMessage(JSON.stringify({ type: "setVolume", pct: 150 })));
    expect(el.volume).toBe(1);
    expect(result.current.volume).toBe(150);
  });
  it("amplifies above 100% through a Web Audio GainNode (gain = pct/100) when available", () => {
    // Regression: the 100..200% half of the slider must actually boost, not be a silent
    // no-op. element.volume is spec-capped at 1.0, so >100% is carried by a GainNode.
    const gain = { gain: { value: 1 }, connect: vi.fn() };
    const source = { connect: vi.fn() };
    const ctx = {
      createMediaElementSource: vi.fn(() => source),
      createGain: vi.fn(() => gain),
      destination: {},
      resume: vi.fn(),
      close: vi.fn(),
    };
    class AudioCtx {
      createMediaElementSource = ctx.createMediaElementSource;
      createGain = ctx.createGain;
      destination = ctx.destination;
      resume = ctx.resume;
      close = ctx.close;
    }
    vi.stubGlobal("AudioContext", AudioCtx);
    try {
      const ws = makeWs();
      const { result } = renderHook(() => usePlayerRole(ws as unknown as WebSocket, true));
      const el = document.createElement("audio");
      act(() => {
        (result.current.audioRef as React.MutableRefObject<HTMLAudioElement | null>).current = el;
      });
      act(() => ws.fireMessage(JSON.stringify({ type: "setVolume", pct: 200 })));
      // Element is pinned at unity; the GainNode carries the 2.0x boost.
      expect(el.volume).toBe(1);
      expect(gain.gain.value).toBe(2);
      // Graph is wired: source → gain → destination.
      expect(source.connect).toHaveBeenCalledWith(gain);
      expect(gain.connect).toHaveBeenCalledWith(ctx.destination);
      expect(result.current.volume).toBe(200);
      // Once the graph exists volume rides the master GainNode (which the shared mock aliases
      // to `gain`); the element stays at unity and the gain carries the exact factor.
      act(() => ws.fireMessage(JSON.stringify({ type: "setVolume", pct: 40 })));
      expect(el.volume).toBe(1);
      expect(gain.gain.value).toBeCloseTo(0.4);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("re-sends becomePlayer when a CONNECTING socket later opens (reconnect survival)", () => {
    // Regression: on a WS reconnect the socket is exposed while still CONNECTING; send()
    // only transmits over an OPEN socket, so an immediate becomePlayer would be dropped and
    // never retried — the remembered speaker would silently lose the Player role. The hook
    // must announce once the socket actually fires 'open'.
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    const ws = {
      OPEN: 1,
      readyState: 0, // CONNECTING
      sent: [] as string[],
      send(d: string) {
        this.sent.push(d);
      },
      addEventListener(t: string, fn: (e: unknown) => void) {
        (listeners[t] ??= []).push(fn);
      },
      removeEventListener() {},
      fireOpen() {
        this.readyState = 1;
        (listeners.open ?? []).forEach((fn) => fn({}));
      },
    };
    renderHook(() => usePlayerRole(ws as unknown as WebSocket, true));
    // Nothing sent yet: the socket was CONNECTING when the effect ran.
    expect(ws.sent.map((m) => JSON.parse(m).type)).not.toContain("becomePlayer");
    // Socket opens → the deferred announcement fires.
    act(() => ws.fireOpen());
    expect(ws.sent.map((m) => JSON.parse(m).type)).toContain("becomePlayer");
  });
  it("reports trackEnded on the audio 'ended' event", () => {
    const ws = makeWs();
    const { result } = renderHook(() => usePlayerRole(ws as unknown as WebSocket, true));
    const el = document.createElement("audio");
    act(() => {
      (result.current.audioRef as React.MutableRefObject<HTMLAudioElement | null>).current = el;
    });
    // Re-render so the effect re-binds to the now-present element.
    act(() => ws.fireMessage(JSON.stringify({ type: "play" })));
    act(() => el.dispatchEvent(new Event("ended")));
    expect(ws.sent.map((m) => JSON.parse(m).type)).toContain("trackEnded");
  });

  const lastPositionMs = (ws: ReturnType<typeof makeWs>): number | undefined => {
    const positions = ws.sent.map((m) => JSON.parse(m)).filter((m) => m.type === "position");
    return positions.length ? positions[positions.length - 1].ms : undefined;
  };

  it("flushes the final position (bypassing the 900ms throttle) on 'ended'", () => {
    const ws = makeWs();
    const { result } = renderHook(() => usePlayerRole(ws as unknown as WebSocket, true));
    const el = document.createElement("audio");
    // currentTime is not settable on the jsdom stub; define a controllable one.
    let t = 0;
    Object.defineProperty(el, "currentTime", { get: () => t, configurable: true });
    act(() => {
      (result.current.audioRef as React.MutableRefObject<HTMLAudioElement | null>).current = el;
    });
    act(() => ws.fireMessage(JSON.stringify({ type: "play" })));
    // First tick at 0.9s → sent (position 900).
    t = 0.9;
    act(() => el.dispatchEvent(new Event("timeupdate")));
    // Final tick at 1.5s is <900ms after the last send → throttled/dropped.
    t = 1.5;
    act(() => el.dispatchEvent(new Event("timeupdate")));
    expect(lastPositionMs(ws)).toBe(900);
    // 'ended' must flush the TRUE final position (1500), not leave the server at 900.
    act(() => el.dispatchEvent(new Event("ended")));
    expect(lastPositionMs(ws)).toBe(1500);
  });

  it("swallows a benign AbortError from play() (no playbackError, no error banner)", async () => {
    // Regression (bug: "plays one song then stops" / a radio track preempts the user's song):
    // a play() rejected because a newer load()/pause() superseded it throws a DOMException
    // named "AbortError". Reporting it as a playbackError makes the server DISCARD the track
    // (error-skip cascade) so radio takes over. It must be swallowed silently.
    const abort = Object.assign(new Error("interrupted by a new load request"), {
      name: "AbortError",
    });
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockRejectedValue(abort);
    const ws = makeWs();
    const { result } = renderHook(() => usePlayerRole(ws as unknown as WebSocket, true));
    const el = document.createElement("audio");
    act(() => {
      (result.current.audioRef as React.MutableRefObject<HTMLAudioElement | null>).current = el;
    });
    await act(async () => {
      ws.fireMessage(JSON.stringify({ type: "play" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(ws.sent.map((m) => JSON.parse(m).type)).not.toContain("playbackError");
    expect(result.current.error).toBeNull();
  });

  it("surfaces a NON-AbortError play() rejection as a playbackError", async () => {
    // The autoplay-block (NotAllowedError) / decode / network failures are genuine and MUST
    // still reach the "Skipped …" banner — only AbortError is swallowed.
    const blocked = Object.assign(new Error("autoplay blocked"), { name: "NotAllowedError" });
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockRejectedValue(blocked);
    const ws = makeWs();
    const { result } = renderHook(() => usePlayerRole(ws as unknown as WebSocket, true));
    const el = document.createElement("audio");
    act(() => {
      (result.current.audioRef as React.MutableRefObject<HTMLAudioElement | null>).current = el;
    });
    await act(async () => {
      ws.fireMessage(JSON.stringify({ type: "play" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const sent = ws.sent.map((m) => JSON.parse(m));
    const pe = sent.find((m) => m.type === "playbackError");
    expect(pe?.message).toBe("autoplay blocked");
    expect(result.current.error).toBe("autoplay blocked");
  });

  it("flushes the exact pause position on a 'pause' command (not the stale throttled value)", () => {
    const ws = makeWs();
    const { result } = renderHook(() => usePlayerRole(ws as unknown as WebSocket, true));
    const el = document.createElement("audio");
    let t = 0;
    Object.defineProperty(el, "currentTime", { get: () => t, configurable: true });
    act(() => {
      (result.current.audioRef as React.MutableRefObject<HTMLAudioElement | null>).current = el;
    });
    act(() => ws.fireMessage(JSON.stringify({ type: "play" })));
    t = 0.9;
    act(() => el.dispatchEvent(new Event("timeupdate")));
    t = 1.2; // <900ms after the last send → would be dropped by the throttle.
    act(() => el.dispatchEvent(new Event("timeupdate")));
    expect(lastPositionMs(ws)).toBe(900);
    act(() => ws.fireMessage(JSON.stringify({ type: "pause" })));
    expect(lastPositionMs(ws)).toBe(1200);
  });

  // --- Crossfade engine ------------------------------------------------------------------

  type GainMock = {
    gain: {
      value: number;
      setValueCurveAtTime: ReturnType<typeof vi.fn>;
      setValueAtTime: ReturnType<typeof vi.fn>;
      linearRampToValueAtTime: ReturnType<typeof vi.fn>;
      cancelScheduledValues: ReturnType<typeof vi.fn>;
    };
    connect: ReturnType<typeof vi.fn>;
  };
  const makeGain = (): GainMock => ({
    gain: {
      value: 1,
      setValueCurveAtTime: vi.fn(),
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      cancelScheduledValues: vi.fn(),
    },
    connect: vi.fn(),
  });
  // Install a Web Audio stub whose createGain hands back distinct, ramp-recording nodes.
  const installAudioContext = () => {
    const gains: GainMock[] = [];
    class AudioCtx {
      currentTime = 0;
      destination = {};
      resume = vi.fn();
      close = vi.fn();
      createGain() {
        const g = makeGain();
        gains.push(g);
        return g;
      }
      createMediaElementSource() {
        return { connect: vi.fn() };
      }
    }
    vi.stubGlobal("AudioContext", AudioCtx);
    return { gains };
  };
  // Capture the hook's lazily-created second (idle) <audio> element.
  const captureCreatedAudio = () => {
    const created: HTMLAudioElement[] = [];
    const real = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string, opts?: unknown) => {
      const el = real(tag as "audio", opts as ElementCreationOptions);
      if (tag === "audio") created.push(el as HTMLAudioElement);
      return el;
    }) as typeof document.createElement);
    return created;
  };
  const defineTime = (el: HTMLAudioElement, duration: number) => {
    let t = 0;
    Object.defineProperty(el, "duration", { get: () => duration, configurable: true });
    Object.defineProperty(el, "currentTime", {
      get: () => t,
      set: (v: number) => {
        t = v;
      },
      configurable: true,
    });
    return {
      set(v: number) {
        t = v;
      },
    };
  };

  it("preloads nextAudioUrl into the idle element", () => {
    const created = captureCreatedAudio();
    try {
      const ws = makeWs();
      renderHook(() => usePlayerRole(ws as unknown as WebSocket, true, "/audio/next", 10));
      // The idle element (created internally) should have the next track preloaded.
      expect(created.length).toBeGreaterThan(0);
      expect(created[0]!.getAttribute("src")).toBe("/audio/next");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("starts the equal-power crossfade at duration - crossfadeSec and sends crossfadeAdvance", () => {
    const audio = installAudioContext();
    const active = document.createElement("audio"); // created before the capture spy
    const created = captureCreatedAudio();
    try {
      const ws = makeWs();
      const { result } = renderHook(() =>
        usePlayerRole(ws as unknown as WebSocket, true, "/audio/next", 10),
      );
      act(() => {
        (result.current.audioRef as React.MutableRefObject<HTMLAudioElement | null>).current =
          active;
      });
      const clock = defineTime(active, 100);
      act(() =>
        ws.fireMessage(JSON.stringify({ type: "load", audioUrl: "/audio/cur", startMs: 0 })),
      );
      act(() => ws.fireMessage(JSON.stringify({ type: "play" })));
      // Before the fade point: no crossfadeAdvance.
      clock.set(89);
      act(() => active.dispatchEvent(new Event("timeupdate")));
      expect(ws.sent.map((m) => JSON.parse(m).type)).not.toContain("crossfadeAdvance");
      // At duration - crossfadeSec (90s): the fade begins.
      clock.set(90);
      act(() => active.dispatchEvent(new Event("timeupdate")));
      const types = ws.sent.map((m) => JSON.parse(m).type);
      expect(types.filter((t: string) => t === "crossfadeAdvance").length).toBe(1);
      // Two per-element fade gains were ramped with an equal-power value curve (out + in).
      const ramped = audio.gains.filter((g) => g.gain.setValueCurveAtTime.mock.calls.length > 0);
      expect(ramped.length).toBe(2);
      // The idle element carries the incoming track.
      expect(created[0]!.getAttribute("src")).toBe("/audio/next");
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("does not double-signal: after crossfade the faded-out element's 'ended' is ignored", () => {
    installAudioContext();
    const active = document.createElement("audio");
    const created = captureCreatedAudio();
    try {
      const ws = makeWs();
      const { result } = renderHook(() =>
        usePlayerRole(ws as unknown as WebSocket, true, "/audio/next", 10),
      );
      act(() => {
        (result.current.audioRef as React.MutableRefObject<HTMLAudioElement | null>).current =
          active;
      });
      const clock = defineTime(active, 100);
      act(() =>
        ws.fireMessage(JSON.stringify({ type: "load", audioUrl: "/audio/cur", startMs: 0 })),
      );
      act(() => ws.fireMessage(JSON.stringify({ type: "play" })));
      clock.set(90);
      act(() => active.dispatchEvent(new Event("timeupdate")));
      // The now-idle (faded-out) old active element must NOT emit trackEnded.
      act(() => active.dispatchEvent(new Event("ended")));
      const sent = ws.sent.map((m) => JSON.parse(m).type);
      expect(sent).not.toContain("trackEnded");
      expect(sent.filter((t: string) => t === "crossfadeAdvance").length).toBe(1);
      // The NEW active element (the incoming one) is the sole trackEnded source.
      act(() => created[0]!.dispatchEvent(new Event("ended")));
      expect(ws.sent.map((m) => JSON.parse(m).type)).toContain("trackEnded");
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("hard-cuts on a server 'load' mid-fade: cancels the fade and resets gains", () => {
    const audio = installAudioContext();
    const active = document.createElement("audio");
    const created = captureCreatedAudio();
    try {
      const ws = makeWs();
      const { result } = renderHook(() =>
        usePlayerRole(ws as unknown as WebSocket, true, "/audio/next", 10),
      );
      act(() => {
        (result.current.audioRef as React.MutableRefObject<HTMLAudioElement | null>).current =
          active;
      });
      const clock = defineTime(active, 100);
      act(() =>
        ws.fireMessage(JSON.stringify({ type: "load", audioUrl: "/audio/cur", startMs: 0 })),
      );
      act(() => ws.fireMessage(JSON.stringify({ type: "play" })));
      clock.set(90);
      act(() => active.dispatchEvent(new Event("timeupdate")));
      expect(
        ws.sent.map((m) => JSON.parse(m).type).filter((t: string) => t === "crossfadeAdvance")
          .length,
      ).toBe(1);
      // gains: [0]=outgoing(old active) fade, [1]=master, [2]=incoming(new active) fade.
      const outgoingFade = audio.gains[0]!;
      const incomingFade = audio.gains[2]!;
      // Hard-cut: a server load abandons the fade and reloads the (now) active element.
      act(() =>
        ws.fireMessage(JSON.stringify({ type: "load", audioUrl: "/audio/skip", startMs: 0 })),
      );
      // No second crossfadeAdvance — the fade was cancelled, not restarted.
      expect(
        ws.sent.map((m) => JSON.parse(m).type).filter((t: string) => t === "crossfadeAdvance")
          .length,
      ).toBe(1);
      // Gains reset: abandoned element silenced (0), the surviving active element full (1).
      expect(outgoingFade.gain.value).toBe(0);
      expect(incomingFade.gain.value).toBe(1);
      // The new track was loaded into the surviving active element (the incoming one).
      expect(created[0]!.getAttribute("src")).toBe("/audio/skip");
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("does not crossfade when crossfadeSec is 0 (off): a normal 'ended' still reports trackEnded", () => {
    const active = document.createElement("audio");
    captureCreatedAudio();
    try {
      const ws = makeWs();
      const { result } = renderHook(() =>
        usePlayerRole(ws as unknown as WebSocket, true, "/audio/next", 0),
      );
      act(() => {
        (result.current.audioRef as React.MutableRefObject<HTMLAudioElement | null>).current =
          active;
      });
      const clock = defineTime(active, 100);
      act(() =>
        ws.fireMessage(JSON.stringify({ type: "load", audioUrl: "/audio/cur", startMs: 0 })),
      );
      act(() => ws.fireMessage(JSON.stringify({ type: "play" })));
      clock.set(99.9);
      act(() => active.dispatchEvent(new Event("timeupdate")));
      expect(ws.sent.map((m) => JSON.parse(m).type)).not.toContain("crossfadeAdvance");
      act(() => active.dispatchEvent(new Event("ended")));
      expect(ws.sent.map((m) => JSON.parse(m).type)).toContain("trackEnded");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
