// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Settings } from "./Settings.js";

afterEach(() => cleanup());

const base = {
  repeat: "off" as const,
  volume: 100,
  maxTrackDurationSec: 0,
};

describe("Settings (pruned)", () => {
  it("renders only the surviving controls and NONE of the removed Discord ones", () => {
    render(<Settings {...base} onChange={() => {}} />);
    expect(screen.getByLabelText(/repeat mode/i)).toBeTruthy();
    expect(screen.getByLabelText(/^volume$/i)).toBeTruthy();
    expect(screen.getByLabelText(/max track length/i)).toBeTruthy();
    // Removed for the jukebox:
    expect(screen.queryByLabelText(/leave channel/i)).toBeNull();
    expect(screen.queryByLabelText(/crossfade/i)).toBeNull();
    expect(screen.queryByLabelText(/normalize/i)).toBeNull();
    expect(screen.queryByLabelText(/fx preset/i)).toBeNull();
    expect(screen.queryByLabelText(/command channel/i)).toBeNull();
  });
  // Autoplay lives ONLY in the Queue header (see Queue.test.tsx) to avoid a duplicate
  // accessible name once App renders Queue + Settings on the same page.
  it("does NOT render an Autoplay toggle or source picker (owned by the Queue header)", () => {
    render(<Settings {...base} onChange={() => {}} />);
    expect(screen.queryByLabelText(/^autoplay$/i)).toBeNull();
    expect(screen.queryByLabelText(/autoplay source/i)).toBeNull();
  });
  it("emits a Partial<StationSettings> patch when repeat changes", () => {
    const onChange = vi.fn();
    render(<Settings {...base} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/repeat mode/i), { target: { value: "all" } });
    expect(onChange).toHaveBeenCalledWith({ repeat: "all" });
  });
  it("emits a volume patch as a number", () => {
    const onChange = vi.fn();
    render(<Settings {...base} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/^volume$/i), { target: { value: "150" } });
    expect(onChange).toHaveBeenCalledWith({ volume: 150 });
  });
});
