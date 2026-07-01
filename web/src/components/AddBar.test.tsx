// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { AddBar } from "./AddBar.js";
import type { TrackMeta } from "../types.js";

afterEach(() => cleanup());

const track = (id: string, thumbnailUrl: string | null = null): TrackMeta => ({
  videoId: id,
  title: `Title ${id}`,
  channel: "Chan",
  durationSec: 120,
  isLive: false,
  thumbnailUrl,
});

function box(): HTMLInputElement {
  return screen.getByLabelText(/add a track/i) as HTMLInputElement;
}

describe("AddBar", () => {
  it("submits the typed value to onPlay and clears the box immediately", async () => {
    const onPlay = vi.fn(async () => ({ candidates: null }));
    render(<AddBar onPlay={onPlay} onQueueAll={async () => true} />);
    fireEvent.change(box(), { target: { value: "  daft punk  " } });
    fireEvent.submit(box().closest("form")!);
    // Trimmed value is forwarded, and the box is emptied instantly on submit.
    expect(onPlay).toHaveBeenCalledWith("daft punk");
    await waitFor(() => expect(box().value).toBe(""));
  });

  it("ignores an empty / whitespace-only submit", () => {
    const onPlay = vi.fn(async () => ({ candidates: null }));
    render(<AddBar onPlay={onPlay} onQueueAll={async () => true} />);
    fireEvent.change(box(), { target: { value: "   " } });
    fireEvent.submit(box().closest("form")!);
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("shows 'No matches' (not a stranded empty picker) when a search returns no candidates", async () => {
    const onPlay = vi.fn(async () => ({ candidates: [] as TrackMeta[] }));
    render(<AddBar onPlay={onPlay} onQueueAll={async () => true} />);
    fireEvent.change(box(), { target: { value: "nothing matches" } });
    fireEvent.submit(box().closest("form")!);
    await waitFor(() =>
      expect(screen.getByText(/No matches — try a different search\./i)).toBeTruthy(),
    );
    // The "Pick the exact track" header is NOT rendered for an empty list.
    expect(screen.queryByText(/Pick the exact track/i)).toBeNull();
  });

  it("renders the picker when candidates are present and queues a selected track", async () => {
    const onPlay = vi.fn(async () => ({
      candidates: [track("aaaaaaaaaaa"), track("bbbbbbbbbbb")],
    }));
    const onQueueAll = vi.fn(async () => true);
    render(<AddBar onPlay={onPlay} onQueueAll={onQueueAll} />);
    fireEvent.change(box(), { target: { value: "daft punk" } });
    fireEvent.submit(box().closest("form")!);
    await waitFor(() => expect(screen.getByText(/Pick the exact track/i)).toBeTruthy());
    expect(screen.queryByText(/No matches/i)).toBeNull();
    // Multi-select model: clicking a row TOGGLES it, then "Queue selected" queues.
    fireEvent.click(screen.getByText("Title aaaaaaaaaaa"));
    expect(onQueueAll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /queue 1 selected/i }));
    // One batched call carrying the selected id (not N fire-and-forget calls).
    expect(onQueueAll).toHaveBeenCalledWith(["aaaaaaaaaaa"]);
  });

  it("queues MULTIPLE selected candidates in order and clears the picker after", async () => {
    const onPlay = vi.fn(async () => ({
      candidates: [track("aaaaaaaaaaa"), track("bbbbbbbbbbb"), track("ccccccccccc")],
    }));
    const onQueueAll = vi.fn(async () => true);
    render(<AddBar onPlay={onPlay} onQueueAll={onQueueAll} />);
    fireEvent.change(box(), { target: { value: "daft punk" } });
    fireEvent.submit(box().closest("form")!);
    await waitFor(() => expect(screen.getByText(/Pick the exact track/i)).toBeTruthy());
    // Select c then a; the batch must follow candidate display order (a, c).
    fireEvent.click(screen.getByText("Title ccccccccccc"));
    fireEvent.click(screen.getByText("Title aaaaaaaaaaa"));
    fireEvent.click(screen.getByRole("button", { name: /queue 2 selected/i }));
    expect(onQueueAll).toHaveBeenCalledTimes(1);
    expect(onQueueAll).toHaveBeenCalledWith(["aaaaaaaaaaa", "ccccccccccc"]);
    // Picker closes after a successful queue.
    await waitFor(() => expect(screen.queryByText(/Pick the exact track/i)).toBeNull());
  });

  it("keeps the picker OPEN with the selection intact when the batch queue fails", async () => {
    const onPlay = vi.fn(async () => ({
      candidates: [track("aaaaaaaaaaa"), track("bbbbbbbbbbb")],
    }));
    // Resolves false => nothing queued; the picker must not tear down.
    const onQueueAll = vi.fn(async () => false);
    render(<AddBar onPlay={onPlay} onQueueAll={onQueueAll} />);
    fireEvent.change(box(), { target: { value: "daft punk" } });
    fireEvent.submit(box().closest("form")!);
    await waitFor(() => expect(screen.getByText(/Pick the exact track/i)).toBeTruthy());
    fireEvent.click(screen.getByText("Title aaaaaaaaaaa"));
    fireEvent.click(screen.getByRole("button", { name: /queue 1 selected/i }));
    await waitFor(() => expect(onQueueAll).toHaveBeenCalled());
    // Picker is still mounted and the row stays selected so the user can retry.
    expect(screen.getByText(/Pick the exact track/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Title aaaaaaaaaaa/i }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("renders a thumbnail <img> for each candidate that has one", async () => {
    const onPlay = vi.fn(async () => ({
      candidates: [track("aaaaaaaaaaa", "http://img/a.jpg")],
    }));
    render(<AddBar onPlay={onPlay} onQueueAll={async () => true} />);
    fireEvent.change(box(), { target: { value: "daft punk" } });
    fireEvent.submit(box().closest("form")!);
    await waitFor(() => expect(screen.getByText("Title aaaaaaaaaaa")).toBeTruthy());
    const img = document.querySelector('img[src="http://img/a.jpg"]') as HTMLImageElement | null;
    expect(img).toBeTruthy();
  });

  it("renders a graceful placeholder (no broken empty <img>) when thumbnailUrl is null", async () => {
    const onPlay = vi.fn(async () => ({ candidates: [track("aaaaaaaaaaa", null)] }));
    render(<AddBar onPlay={onPlay} onQueueAll={async () => true} />);
    fireEvent.change(box(), { target: { value: "daft punk" } });
    fireEvent.submit(box().closest("form")!);
    await waitFor(() => expect(screen.getByText("Title aaaaaaaaaaa")).toBeTruthy());
    // A placeholder is shown, and ZERO <img> elements are emitted for the null thumbnail.
    expect(screen.getByTestId("thumb-placeholder")).toBeTruthy();
    expect(document.querySelectorAll("img").length).toBe(0);
  });

  it("disables the input and button while busy (no voice channel target)", () => {
    render(
      <AddBar onPlay={async () => ({ candidates: null })} onQueueAll={async () => true} busy />,
    );
    expect(box().disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Queue it/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("a link queue (null candidates) renders neither the picker nor a no-matches message", async () => {
    const onPlay = vi.fn(async () => ({ candidates: null }));
    render(<AddBar onPlay={onPlay} onQueueAll={async () => true} />);
    fireEvent.change(box(), { target: { value: "https://youtu.be/abcdefghijk" } });
    fireEvent.submit(box().closest("form")!);
    await waitFor(() => expect(box().value).toBe(""));
    expect(screen.queryByText(/Pick the exact track/i)).toBeNull();
    expect(screen.queryByText(/No matches/i)).toBeNull();
  });
});
