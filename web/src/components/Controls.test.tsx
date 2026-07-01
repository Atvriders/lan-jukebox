// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Controls } from "./Controls.js";

afterEach(() => cleanup());

describe("Controls", () => {
  it("shows Pause + Skip and has NO Stop button (the station never stops)", () => {
    render(<Controls onAction={() => {}} paused={false} />);
    expect(screen.getByRole("button", { name: /pause/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /skip/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
  });
  it("emits resume when paused and pause when playing", () => {
    const onAction = vi.fn();
    const { rerender } = render(<Controls onAction={onAction} paused />);
    fireEvent.click(screen.getByRole("button", { name: /resume/i }));
    expect(onAction).toHaveBeenCalledWith("resume");
    rerender(<Controls onAction={onAction} paused={false} />);
    fireEvent.click(screen.getByRole("button", { name: /pause/i }));
    expect(onAction).toHaveBeenCalledWith("pause");
  });
  it("emits skip", () => {
    const onAction = vi.fn();
    render(<Controls onAction={onAction} paused={false} />);
    fireEvent.click(screen.getByRole("button", { name: /skip/i }));
    expect(onAction).toHaveBeenCalledWith("skip");
  });
});
