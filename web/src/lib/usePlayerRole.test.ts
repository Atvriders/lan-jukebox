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
  it("clamps setVolume above 100% to 1.0 on the element but keeps the pct for the UI", () => {
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
});
