// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { History } from "./History.js";
import type { QueueItem } from "../types.js";

afterEach(() => cleanup());

const item = (videoId: string, title = videoId): QueueItem => ({
  id: `i-${videoId}`,
  meta: { videoId, title, channel: "c", durationSec: 100, isLive: false, thumbnailUrl: null },
  requester: { deviceId: "d1", displayName: "dj", source: "user" },
  addedAt: 0,
  audio: null,
  fromRadio: false,
});

describe("History", () => {
  it("renders an empty state when nothing has played", () => {
    render(<History history={[]} onRequeue={vi.fn()} />);
    // getByText throws when absent, so the query is itself the assertion.
    screen.getByText(/nothing has played/i);
  });

  it("lists tracks most-recent first (history is oldest-first) and caps at 10", () => {
    // 12 finished tracks oldest-first: v0 finished first, v11 most recent.
    const history = Array.from({ length: 12 }, (_, i) => item(`v${i}`, `Track ${i}`));
    render(<History history={history} onRequeue={vi.fn()} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(10);
    // Most recent (Track 11) is first; the two oldest (0,1) are dropped by the cap.
    within(rows[0]!).getByText("Track 11");
    expect(screen.queryByText("Track 0")).toBeNull();
    expect(screen.queryByText("Track 1")).toBeNull();
    screen.getByText("Track 2");
  });

  it("renders each history entry's title, channel and requester credit", () => {
    render(<History history={[item("abc12345678", "Song A")]} onRequeue={vi.fn()} />);
    screen.getByText("Song A");
    // channel + requester share one credit line, so match on the containing text.
    screen.getByText(/\bc\b/);
    screen.getByText(/\bdj\b/);
  });

  it("re-queues a track by its videoId on click", () => {
    const onRequeue = vi.fn();
    render(<History history={[item("abc12345678", "Song A")]} onRequeue={onRequeue} />);
    fireEvent.click(screen.getByRole("button", { name: /re-queue song a/i }));
    expect(onRequeue).toHaveBeenCalledWith("abc12345678");
  });
});
