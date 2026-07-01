// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { App } from "./App.js";
import { api, ApiError } from "../lib/api.js";
import * as stationHook from "../lib/useStationState.js";
import type { StationSnapshot } from "../types.js";

// A "full console" playing snapshot so App renders the transport + Queue + Settings.
function playingSnap(paused: boolean): StationSnapshot {
  return {
    current: {
      id: "q1",
      meta: {
        videoId: "v1",
        title: "Now Playing",
        channel: "Chan",
        durationSec: 200,
        isLive: false,
        thumbnailUrl: null,
      },
      requester: { deviceId: "d", displayName: "DJ" },
      positionMs: 0,
      durationMs: 200000,
    },
    upcoming: [],
    upcomingRadio: [],
    history: [],
    seed: {
      videoId: "v1",
      title: "Now Playing",
      channel: "Chan",
      durationSec: 200,
      isLive: false,
      thumbnailUrl: null,
    },
    paused,
    preparing: null,
    activePlayerPresent: true,
    activePlayerLabel: "speaker",
    repeat: "off",
    autoplay: true,
    autoplaySource: "radio",
    volume: 100,
    maxTrackDurationSec: 0,
  } as unknown as StationSnapshot;
}

// The App composes useStationState (opens a WS) — provide a no-op fake so the hook
// doesn't throw and the App renders its initial snapshot=null state.
beforeEach(() => {
  localStorage.clear();
  class NoopWS {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    addEventListener() {}
    removeEventListener() {}
    send() {}
    close() {}
  }
  vi.stubGlobal("WebSocket", NoopWS as unknown as typeof WebSocket);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("renders the LoginGate when /api/state returns 401", async () => {
    vi.spyOn(api, "state").mockRejectedValue(new ApiError(401, "unauthorized"));
    render(<App />);
    expect(await screen.findByLabelText(/password/i)).toBeTruthy();
  });
  it("shows the cold-start banner when there is no seed and nothing playing", async () => {
    vi.spyOn(api, "state").mockResolvedValue({
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
      isThisDeviceSpeaker: false,
    } as never);
    render(<App />);
    expect(await screen.findByText(/queue a song to start the station/i)).toBeTruthy();
  });
  it("does NOT show the cold-start banner once a seed exists", async () => {
    vi.spyOn(api, "state").mockResolvedValue({
      current: null,
      upcoming: [],
      upcomingRadio: [],
      history: [],
      seed: {
        videoId: "v1",
        title: "Seed",
        channel: "C",
        durationSec: 100,
        isLive: false,
        thumbnailUrl: null,
      },
      paused: false,
      preparing: null,
      activePlayerPresent: false,
      activePlayerLabel: null,
      repeat: "off",
      autoplay: true,
      autoplaySource: "radio",
      volume: 100,
      maxTrackDurationSec: 0,
      isThisDeviceSpeaker: false,
    } as never);
    render(<App />);
    await waitFor(() => expect(api.state).toHaveBeenCalled());
    expect(screen.queryByText(/queue a song to start the station/i)).toBeNull();
  });

  it("keeps the optimistic pause when a stale pre-op WS snapshot arrives late", async () => {
    // Control the WS hook directly so we can feed a pre-op snapshot after the click.
    let wsState: stationHook.WsState & { socket: WebSocket | null } = {
      snapshot: playingSnap(false),
      status: "live",
      receivedAt: 1000,
      lastError: null,
      socket: null,
    };
    vi.spyOn(stationHook, "useStationState").mockImplementation(() => wsState);
    vi.spyOn(api, "state").mockResolvedValue(playingSnap(false) as never);
    vi.spyOn(api, "control").mockResolvedValue(undefined as never);

    const { rerender } = render(<App />);
    // Playing → the transport button reads "Pause".
    const btn = await screen.findByLabelText(/^pause$/i);
    // Click Pause → optimistic: the button should flip to "Resume".
    fireEvent.click(btn);
    expect(screen.getByLabelText(/^resume$/i)).toBeTruthy();
    // A stale pre-op snapshot (still paused:false) arrives AFTER the click (later
    // receivedAt) but predates the pause op. It must NOT revert the optimistic pause.
    wsState = { ...wsState, snapshot: playingSnap(false), receivedAt: Date.now() + 5 };
    rerender(<App />);
    expect(screen.getByLabelText(/^resume$/i)).toBeTruthy();
    expect(screen.queryByLabelText(/^pause$/i)).toBeNull();
  });

  it("re-queues a history track via /api/pick (bare videoId), NOT /api/add (a text search)", async () => {
    // /api/add classifies a bare 11-char id as a text SEARCH and enqueues nothing; re-queue
    // must route through /api/pick, which validates the VIDEO_ID and enqueues directly.
    const snap = playingSnap(false);
    (snap as unknown as { history: unknown[] }).history = [
      {
        id: "h1",
        meta: {
          videoId: "histvid1234",
          title: "Old Track",
          channel: "Chan",
          durationSec: 100,
          isLive: false,
          thumbnailUrl: null,
        },
        requester: { deviceId: "d", displayName: "DJ", source: "user" },
        addedAt: 0,
        audio: null,
        fromRadio: false,
      },
    ];
    vi.spyOn(stationHook, "useStationState").mockReturnValue({
      snapshot: snap,
      status: "live",
      receivedAt: 1000,
      lastError: null,
      socket: null,
    });
    vi.spyOn(api, "state").mockResolvedValue(snap as never);
    const pick = vi.spyOn(api, "pick").mockResolvedValue(undefined as never);
    const add = vi.spyOn(api, "add").mockResolvedValue({ candidates: [] } as never);
    render(<App />);
    const btn = await screen.findByLabelText(/re-queue old track/i);
    fireEvent.click(btn);
    expect(pick).toHaveBeenCalledWith("histvid1234");
    expect(add).not.toHaveBeenCalled();
  });

  it("surfaces download/processing progress when snapshot.preparing is non-null", async () => {
    const snap = playingSnap(false);
    (snap as unknown as { preparing: unknown }).preparing = {
      phase: "downloading",
      title: "A Long Mix",
      percent: 42,
    };
    vi.spyOn(stationHook, "useStationState").mockReturnValue({
      snapshot: snap,
      status: "live",
      receivedAt: 1000,
      lastError: null,
      socket: null,
    });
    vi.spyOn(api, "state").mockResolvedValue(snap as never);
    render(<App />);
    // The Preparing status region surfaces the downloading track + percent.
    await waitFor(() => expect(screen.getByText("A Long Mix")).toBeTruthy());
    expect(screen.getByText(/downloading/i)).toBeTruthy();
    expect(screen.getByText(/42%/)).toBeTruthy();
  });

  it("changing the autoplay source select emits a settings patch with the new autoplaySource", async () => {
    vi.spyOn(stationHook, "useStationState").mockReturnValue({
      snapshot: playingSnap(false),
      status: "live",
      receivedAt: 1000,
      lastError: null,
      socket: null,
    });
    vi.spyOn(api, "state").mockResolvedValue(playingSnap(false) as never);
    const control = vi.spyOn(api, "control").mockResolvedValue(undefined as never);
    render(<App />);
    const select = await screen.findByLabelText(/autoplay source/i);
    fireEvent.change(select, { target: { value: "artist" } });
    expect(control).toHaveBeenCalledWith("settings", { autoplaySource: "artist" });
  });

  it("exposes exactly one 'Autoplay' control and one 'Autoplay source' selector on the full page", async () => {
    vi.spyOn(stationHook, "useStationState").mockReturnValue({
      snapshot: playingSnap(false),
      status: "live",
      receivedAt: 1000,
      lastError: null,
      socket: null,
    });
    vi.spyOn(api, "state").mockResolvedValue(playingSnap(false) as never);
    render(<App />);
    await screen.findByLabelText(/^pause$/i);
    // Regression: Queue + Settings previously each rendered an "Autoplay" toggle and an
    // "Autoplay source" select → ambiguous accessible names. Now autoplay lives only in
    // the Queue header.
    expect(screen.queryAllByLabelText(/^autoplay$/i).length).toBe(1);
    expect(screen.queryAllByLabelText(/autoplay source/i).length).toBe(1);
    // getByLabelText must not throw (unique match).
    expect(screen.getByLabelText(/^autoplay$/i)).toBeTruthy();
    expect(screen.getByLabelText(/autoplay source/i)).toBeTruthy();
  });

  it("surfaces a reconnecting banner (role=status) while the WS is reconnecting", async () => {
    // Regression: App never read ws.status, so a dropped socket silently kept showing the last
    // (stale) snapshot with no indication. A 'connecting'/'closed' status must render an
    // announced banner so the user knows the data is stale / a reconnect is in progress.
    vi.spyOn(stationHook, "useStationState").mockReturnValue({
      snapshot: playingSnap(false),
      status: "connecting",
      receivedAt: 1000,
      lastError: null,
      socket: null,
    });
    vi.spyOn(api, "state").mockResolvedValue(playingSnap(false) as never);
    render(<App />);
    await waitFor(() => expect(screen.getByText(/reconnecting to the station/i)).toBeTruthy());
    // It's an announced live region, not silent text.
    const banner = screen.getByText(/reconnecting to the station/i);
    expect(banner.getAttribute("role")).toBe("status");
  });

  it("announces the station speaker state via a live region (no-speaker not glyph-only)", async () => {
    const snap = playingSnap(false);
    (snap as unknown as { activePlayerPresent: boolean }).activePlayerPresent = false;
    (snap as unknown as { activePlayerLabel: string | null }).activePlayerLabel = null;
    vi.spyOn(stationHook, "useStationState").mockReturnValue({
      snapshot: snap,
      status: "live",
      receivedAt: 1000,
      lastError: null,
      socket: null,
    });
    vi.spyOn(api, "state").mockResolvedValue(snap as never);
    render(<App />);
    // The "No speaker" text (not the ○ glyph) conveys the state, inside a polite live region.
    const indicator = await screen.findByText(/no speaker/i);
    expect(indicator.getAttribute("role")).toBe("status");
    expect(indicator.getAttribute("aria-live")).toBe("polite");
  });
});
