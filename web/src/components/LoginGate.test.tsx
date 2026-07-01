// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { LoginGate } from "./LoginGate.js";
import { api } from "../lib/api.js";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LoginGate", () => {
  it("submits the password + displayName + deviceId and calls onAuthed with the session", async () => {
    const session = { displayName: "Al", deviceId: expect.any(String) };
    const spy = vi.spyOn(api, "login").mockResolvedValue(session as never);
    const onAuthed = vi.fn();
    render(<LoginGate onAuthed={onAuthed} />);
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "Al" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: /enter|sign in|log in/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const arg = spy.mock.calls[0]![0];
    expect(arg).toMatchObject({ password: "pw", displayName: "Al" });
    expect(arg.deviceId).toMatch(/.+/);
    await waitFor(() => expect(onAuthed).toHaveBeenCalledWith(session));
  });
  it("shows the server error message on a failed login and does not call onAuthed", async () => {
    vi.spyOn(api, "login").mockRejectedValue(
      Object.assign(new Error("bad password"), { name: "ApiError", status: 401 }),
    );
    const onAuthed = vi.fn();
    render(<LoginGate onAuthed={onAuthed} />);
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "Al" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /enter|sign in|log in/i }));
    expect(await screen.findByText(/bad password/i)).toBeTruthy();
    expect(onAuthed).not.toHaveBeenCalled();
  });
});
