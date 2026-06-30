// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Picker } from "./Picker.js";
import type { TrackMeta } from "../types.js";

afterEach(() => cleanup());

const candidates: TrackMeta[] = [
  {
    videoId: "aaaaaaaaaaa",
    title: "One",
    channel: "C",
    durationSec: 60,
    isLive: false,
    thumbnailUrl: null,
  },
  {
    videoId: "bbbbbbbbbbb",
    title: "Two",
    channel: "C",
    durationSec: 90,
    isLive: false,
    thumbnailUrl: null,
  },
];

describe("Picker", () => {
  it("queues the selected candidate videoIds in display order", async () => {
    const onQueueSelected = vi.fn().mockResolvedValue(true);
    render(<Picker candidates={candidates} onQueueSelected={onQueueSelected} />);
    fireEvent.click(screen.getByText("One"));
    fireEvent.click(screen.getByText("Two"));
    // The queue button's accessible name comes from its aria-label
    // ("Queue 2 selected tracks") per the verbatim Picker source.
    fireEvent.click(screen.getByRole("button", { name: /queue \d+ selected/i }));
    expect(onQueueSelected).toHaveBeenCalledWith(["aaaaaaaaaaa", "bbbbbbbbbbb"]);
  });
  it("disables selection when busy", () => {
    const onQueueSelected = vi.fn();
    render(<Picker candidates={candidates} onQueueSelected={onQueueSelected} busy />);
    fireEvent.click(screen.getByText("One"));
    // While busy, toggling is blocked so nothing is selected and the
    // queue button never renders; clicking it (if present) must not queue.
    const queueBtn = screen.queryByRole("button", { name: /queue \d+ selected/i });
    if (queueBtn) fireEvent.click(queueBtn);
    expect(onQueueSelected).not.toHaveBeenCalled();
  });
});
