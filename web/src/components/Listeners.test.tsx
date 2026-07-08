// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Listeners } from "./Listeners.js";
import type { PresenceUser } from "../types.js";

afterEach(() => cleanup());

const roster: PresenceUser[] = [
  { deviceId: "dev-a", displayName: "Alice", isSpeaker: true },
  { deviceId: "dev-me", displayName: "Me", isSpeaker: false },
  { deviceId: "dev-c", displayName: "Carol", isSpeaker: false },
];

describe("Listeners drawer", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <Listeners listeners={roster} myDeviceId="dev-me" open={false} onClose={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders an accessible modal dialog when open", () => {
    render(<Listeners listeners={roster} myDeviceId="dev-me" open onClose={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // Labelled by the "Listeners" heading.
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)?.textContent).toMatch(/listeners/i);
  });

  it("lists every listener with a speaker badge and a (you) marker", () => {
    render(<Listeners listeners={roster} myDeviceId="dev-me" open onClose={() => {}} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    // Alice is the speaker -> badge present on her row, not on the others.
    const alice = items.find((li) => li.textContent?.includes("Alice"))!;
    expect(alice.querySelector('[aria-label="Speaker"]')).toBeTruthy();
    const me = items.find((li) => li.textContent?.includes("Me"))!;
    expect(me.querySelector('[aria-label="Speaker"]')).toBeNull();
    // "(you)" only on the local device row.
    expect(me.textContent).toMatch(/\(you\)/);
    expect(alice.textContent).not.toMatch(/\(you\)/);
    expect(screen.getByText(/3 connected/i)).toBeTruthy();
  });

  it("closes on Escape, overlay click, and the Close button", () => {
    const onClose = vi.fn();
    render(<Listeners listeners={roster} myDeviceId="dev-me" open onClose={onClose} />);
    const dialog = screen.getByRole("dialog");

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText(/close listeners/i));
    expect(onClose).toHaveBeenCalledTimes(2);

    // Clicking the panel itself does NOT close (propagation stopped); the overlay does.
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(2);
    const overlay = document.querySelector(".listeners-overlay")!;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("shows an empty state when no one is connected", () => {
    render(<Listeners listeners={[]} myDeviceId="dev-me" open onClose={() => {}} />);
    expect(screen.getByText(/no one is connected/i)).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});
