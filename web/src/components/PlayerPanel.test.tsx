// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { createRef } from "react";
import { PlayerPanel } from "./PlayerPanel.js";

afterEach(() => cleanup());

describe("PlayerPanel", () => {
  it("announces this device is the speaker and mounts the audio element on the ref", () => {
    const audioRef = createRef<HTMLAudioElement>();
    const { container } = render(
      <PlayerPanel isSpeaker onRelinquish={() => {}} audioRef={audioRef} />,
    );
    expect(screen.getByText(/this device is the speaker/i)).toBeTruthy();
    const audio = container.querySelector("audio");
    expect(audio).toBeTruthy();
    expect(audioRef.current).toBe(audio); // the ref is wired to the real element
  });
  it("calls onRelinquish when the relinquish control is clicked", () => {
    const audioRef = createRef<HTMLAudioElement>();
    const onRelinquish = vi.fn();
    render(<PlayerPanel isSpeaker onRelinquish={onRelinquish} audioRef={audioRef} />);
    fireEvent.click(screen.getByRole("button", { name: /relinquish|stop being the speaker/i }));
    expect(onRelinquish).toHaveBeenCalledTimes(1);
  });
  it("still mounts the (hidden) audio element when this device is NOT the speaker", () => {
    const audioRef = createRef<HTMLAudioElement>();
    const { container } = render(
      <PlayerPanel isSpeaker={false} onRelinquish={() => {}} audioRef={audioRef} />,
    );
    expect(container.querySelector("audio")).toBeTruthy(); // audio always mounted so commands can load
    expect(screen.queryByText(/this device is the speaker/i)).toBeNull();
  });
});
