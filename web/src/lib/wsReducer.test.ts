import { describe, it, expect } from "vitest";
import { applyWsMessage, initialWsState, reconnectDelayMs } from "./useStationState.js";
import type { StationSnapshot } from "../types.js";

// Fully-shaped snapshot so the compiler flags any field add/remove and the round-trip
// assertion is meaningful (de-guilded/de-Discorded fields).
const snap: StationSnapshot = {
  current: null,
  upcoming: [],
  upcomingRadio: [],
  history: [],
  seed: null,
  paused: false,
  preparing: null,
  activePlayerPresent: false,
  activePlayerLabel: null,
  repeat: "off",
  autoplay: true,
  autoplaySource: "radio",
  volume: 100,
  maxTrackDurationSec: 0,
  crossfadeSec: 10,
  listeners: [],
};

describe("applyWsMessage", () => {
  it("applies a state frame and goes live", () => {
    const s = applyWsMessage(initialWsState, JSON.stringify({ type: "state", state: snap }));
    expect(s.status).toBe("live");
    expect(s.snapshot).toEqual(snap);
    expect(s.snapshot?.autoplaySource).toBe("radio");
    expect(s.receivedAt).toBeGreaterThan(0);
  });
  it("ignores malformed frames by returning the SAME reference (no clobbering)", () => {
    const prev = { ...initialWsState, status: "live" as const };
    expect(applyWsMessage(prev, "not json")).toBe(prev);
  });
  it("returns the same reference for an unrecognized frame type", () => {
    const prev = { ...initialWsState, status: "live" as const };
    expect(applyWsMessage(prev, JSON.stringify({ type: "noop" }))).toBe(prev);
  });
  it("sets lastError on a trackError frame and increments seq", () => {
    const s1 = applyWsMessage(
      initialWsState,
      JSON.stringify({ type: "trackError", videoId: "v1", title: "X", reason: "po_token_sabr" }),
    );
    expect(s1.lastError).toMatchObject({ title: "X", reason: "po_token_sabr", seq: 1 });
    const s2 = applyWsMessage(
      s1,
      JSON.stringify({
        type: "trackError",
        videoId: "v2",
        title: "Y",
        reason: "download_failed",
      }),
    );
    expect(s2.lastError).toMatchObject({ title: "Y", reason: "download_failed", seq: 2 });
  });
});

describe("reconnectDelayMs", () => {
  it("follows the 1s/2s/4s/8s schedule capped at 15s", () => {
    expect(reconnectDelayMs(0)).toBe(1000);
    expect(reconnectDelayMs(1)).toBe(2000);
    expect(reconnectDelayMs(2)).toBe(4000);
    expect(reconnectDelayMs(3)).toBe(8000);
    expect(reconnectDelayMs(10)).toBe(15000); // capped
  });
});
