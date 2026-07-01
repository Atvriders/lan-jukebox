// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Queue } from "./Queue.js";
import type { CurrentItem, QueueItem } from "../types.js";

afterEach(() => cleanup());

// The total-remaining readout carries the "Total remaining time" title, so it can be
// asserted independently of per-row durations that may share its text.
function totalText(): string {
  return screen.getByTitle("Total remaining time").textContent ?? "";
}

const item = (
  id: string,
  durationSec: number | null,
  { title = id, fromRadio = false }: { title?: string; fromRadio?: boolean } = {},
): QueueItem => ({
  id,
  meta: { videoId: id, title, channel: "c", durationSec, isLive: false, thumbnailUrl: null },
  requester: fromRadio
    ? { deviceId: "autoplay", displayName: "Autoplay", source: "autoplay" }
    : { deviceId: "d1", displayName: "dj", source: "user" },
  addedAt: 0,
  audio: null,
  fromRadio,
});

const current = (positionMs: number, durationMs: number): CurrentItem => ({
  ...item("cur", durationMs / 1000),
  positionMs,
  durationMs,
});

const noop = () => {};

// A full prop set with sensible defaults; individual tests override what they exercise.
function renderQueue(props: Partial<Parameters<typeof Queue>[0]> = {}) {
  return render(
    <Queue
      items={[item("a", 60), item("b", 60), item("c", 60)]}
      current={null}
      upcomingRadio={[]}
      onRemove={noop}
      onReorder={noop}
      onPlayNext={noop}
      onJump={noop}
      onShuffle={noop}
      onClear={noop}
      autoplay={false}
      autoplaySource="radio"
      onToggleAutoplay={noop}
      {...props}
    />,
  );
}

describe("Queue power tools", () => {
  it("renders a Shuffle button that calls onShuffle", () => {
    const onShuffle = vi.fn();
    renderQueue({ items: [item("a", 60), item("b", 60)], onShuffle });
    fireEvent.click(screen.getByRole("button", { name: /shuffle/i }));
    expect(onShuffle).toHaveBeenCalledTimes(1);
  });

  it("renders a Clear button that calls onClear", () => {
    const onClear = vi.fn();
    renderQueue({ items: [item("a", 60), item("b", 60)], onClear });
    fireEvent.click(screen.getByRole("button", { name: /clear the queue/i }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("renders a per-row Play next button that calls onPlayNext with the item id", () => {
    const onPlayNext = vi.fn();
    renderQueue({ items: [item("a", 60), item("b", 60)], onPlayNext });
    const rows = screen.getAllByRole("listitem");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: /play next/i }));
    expect(onPlayNext).toHaveBeenCalledWith("b");
  });

  it("jumps to a track when its row title is clicked", () => {
    const onJump = vi.fn();
    renderQueue({ items: [item("a", 60), item("b", 60)], onJump });
    const rows = screen.getAllByRole("listitem");
    fireEvent.click(within(rows[0]!).getByRole("button", { name: /jump to a, play it now/i }));
    expect(onJump).toHaveBeenCalledWith("a");
  });

  it("shows the total upcoming time plus the remaining of the current track", () => {
    // upcoming: 60 + 120 = 180s; current remaining: 200s - 50s = 150s; total = 330s = 5:30
    renderQueue({ items: [item("a", 60), item("b", 120)], current: current(50_000, 200_000) });
    expect(totalText()).toBe("5:30");
  });

  it("sums only the upcoming durations when nothing is playing", () => {
    renderQueue({ items: [item("a", 60), item("b", 120)], current: null });
    expect(totalText()).toBe("3:00");
  });

  it("treats unknown (null) durations as zero in the total", () => {
    renderQueue({ items: [item("a", 60), item("b", null)], current: null });
    expect(totalText()).toBe("1:00");
  });

  it("Move up calls onReorder(id, i-1); the first row's Move up is disabled", () => {
    const onReorder = vi.fn();
    renderQueue({ onReorder });
    const rows = screen.getAllByRole("listitem");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: /move up/i }));
    expect(onReorder).toHaveBeenCalledWith("b", 0);
    const firstUp = within(rows[0]!).getByRole("button", { name: /move up/i }) as HTMLButtonElement;
    expect(firstUp.disabled).toBe(true);
    fireEvent.click(firstUp);
    expect(onReorder).toHaveBeenCalledTimes(1); // disabled click was a no-op
  });

  it("Move down calls onReorder(id, i+1); the last row's Move down is disabled", () => {
    const onReorder = vi.fn();
    renderQueue({ onReorder });
    const rows = screen.getAllByRole("listitem");
    fireEvent.click(within(rows[0]!).getByRole("button", { name: /move down/i }));
    expect(onReorder).toHaveBeenCalledWith("a", 1);
    const lastDown = within(rows[2]!).getByRole("button", {
      name: /move down/i,
    }) as HTMLButtonElement;
    expect(lastDown.disabled).toBe(true);
    fireEvent.click(lastDown);
    expect(onReorder).toHaveBeenCalledTimes(1);
  });

  it("Remove calls onRemove with the row's id", () => {
    const onRemove = vi.fn();
    renderQueue({ onRemove });
    const rows = screen.getAllByRole("listitem");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: /^remove/i }));
    expect(onRemove).toHaveBeenCalledWith("b");
  });

  it("renders the empty-queue notice and no explicit rows when there are no upcoming items", () => {
    renderQueue({ items: [] });
    screen.getByText("The queue is empty.");
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("disables Shuffle and Clear with fewer than 2 items", () => {
    const { rerender } = renderQueue({ items: [item("a", 60)] });
    expect((screen.getByRole("button", { name: /shuffle/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    rerender(
      <Queue
        items={[item("a", 60), item("b", 60)]}
        current={null}
        upcomingRadio={[]}
        onRemove={noop}
        onReorder={noop}
        onPlayNext={noop}
        onJump={noop}
        onShuffle={noop}
        onClear={noop}
        autoplay={false}
        autoplaySource="radio"
        onToggleAutoplay={noop}
      />,
    );
    expect((screen.getByRole("button", { name: /shuffle/i }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("disables Clear when the queue is empty", () => {
    renderQueue({ items: [] });
    expect(
      (screen.getByRole("button", { name: /clear the queue/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("Queue upcoming-radio preview", () => {
  it("renders the radio-preview section with its items when upcomingRadio is non-empty", () => {
    renderQueue({
      items: [item("a", 60)],
      upcomingRadio: [
        item("r1", 90, { title: "Radio One", fromRadio: true }),
        item("r2", 90, { title: "Radio Two", fromRadio: true }),
      ],
    });
    const region = screen.getByRole("region", { name: /up next on the radio/i });
    expect(within(region).getByText("Radio One")).toBeTruthy();
    expect(within(region).getByText("Radio Two")).toBeTruthy();
  });

  it("does not render the radio-preview section when upcomingRadio is empty", () => {
    renderQueue({ items: [item("a", 60)], upcomingRadio: [] });
    expect(screen.queryByRole("region", { name: /up next on the radio/i })).toBeNull();
  });

  it("radio-preview items are read-only: no Remove / Move / Play-next controls", () => {
    renderQueue({
      items: [],
      upcomingRadio: [item("r1", 90, { title: "Radio One", fromRadio: true })],
    });
    const region = screen.getByRole("region", { name: /up next on the radio/i });
    expect(within(region).queryByRole("button", { name: /^remove/i })).toBeNull();
    expect(within(region).queryByRole("button", { name: /move up/i })).toBeNull();
    expect(within(region).queryByRole("button", { name: /move down/i })).toBeNull();
    expect(within(region).queryByRole("button", { name: /play next/i })).toBeNull();
  });

  it("tags radio-preview items as coming from the radio", () => {
    renderQueue({
      items: [],
      upcomingRadio: [item("r1", 90, { title: "Radio One", fromRadio: true })],
    });
    const region = screen.getByRole("region", { name: /up next on the radio/i });
    expect(within(region).getByText(/from radio/i)).toBeTruthy();
  });
});

describe("Queue autoplay toggle", () => {
  it("reflects autoplay=false on the switch", () => {
    renderQueue({ autoplay: false });
    const sw = screen.getByRole("switch", { name: /autoplay|auto-discover/i });
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("reflects autoplay=true on the switch", () => {
    renderQueue({ autoplay: true });
    const sw = screen.getByRole("switch", { name: /autoplay|auto-discover/i });
    expect(sw).toHaveAttribute("aria-checked", "true");
  });

  it("calls onToggleAutoplay(true) when flipped from OFF", () => {
    const onToggleAutoplay = vi.fn();
    renderQueue({ autoplay: false, onToggleAutoplay });
    fireEvent.click(screen.getByRole("switch", { name: /autoplay|auto-discover/i }));
    expect(onToggleAutoplay).toHaveBeenCalledWith(true);
  });

  it("calls onToggleAutoplay(false) when flipped from ON", () => {
    const onToggleAutoplay = vi.fn();
    renderQueue({ autoplay: true, onToggleAutoplay });
    fireEvent.click(screen.getByRole("switch", { name: /autoplay|auto-discover/i }));
    expect(onToggleAutoplay).toHaveBeenCalledWith(false);
  });
});
