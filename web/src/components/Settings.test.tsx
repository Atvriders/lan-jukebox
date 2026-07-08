// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Settings } from "./Settings.js";

afterEach(() => cleanup());

const base = {
  repeat: "off" as const,
  volume: 100,
  maxTrackDurationSec: 0,
  crossfadeSec: 10,
};

describe("Settings (pruned)", () => {
  it("renders only the surviving controls and NONE of the removed Discord ones", () => {
    render(<Settings {...base} onChange={() => {}} />);
    expect(screen.getByLabelText(/repeat mode/i)).toBeTruthy();
    expect(screen.getByLabelText(/^volume$/i)).toBeTruthy();
    expect(screen.getByLabelText(/max track length/i)).toBeTruthy();
    // Removed for the jukebox:
    expect(screen.queryByLabelText(/leave channel/i)).toBeNull();
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
  it("renders a Crossfade select with Off/5/10/15/20 options bound to crossfadeSec", () => {
    render(<Settings {...base} onChange={() => {}} />);
    const select = screen.getByLabelText(/^crossfade$/i) as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe("10"); // bound to base.crossfadeSec
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual(["Off", "5s", "10s", "15s", "20s"]);
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["0", "5", "10", "15", "20"]);
  });
  it("emits a crossfadeSec patch as a number when changed", () => {
    const onChange = vi.fn();
    render(<Settings {...base} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/^crossfade$/i), { target: { value: "0" } });
    expect(onChange).toHaveBeenCalledWith({ crossfadeSec: 0 });
    fireEvent.change(screen.getByLabelText(/^crossfade$/i), { target: { value: "20" } });
    expect(onChange).toHaveBeenCalledWith({ crossfadeSec: 20 });
  });
  it("shows a '(current)' fallback option when crossfadeSec is not a preset", () => {
    render(<Settings {...base} crossfadeSec={7} onChange={() => {}} />);
    const select = screen.getByLabelText(/^crossfade$/i) as HTMLSelectElement;
    expect(select.value).toBe("7");
    expect(Array.from(select.options).map((o) => o.textContent)).toContain("7s (current)");
  });
});
