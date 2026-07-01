// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { getDeviceId, getDisplayName, setDisplayName } from "./deviceId.js";

beforeEach(() => localStorage.clear());

describe("deviceId", () => {
  it("issues a persistent deviceId and returns the same value on subsequent calls", () => {
    const a = getDeviceId();
    expect(a).toMatch(/^[0-9a-f-]{8,}$/i); // a UUID-ish random token
    const b = getDeviceId();
    expect(b).toBe(a); // persisted, not regenerated
    expect(localStorage.getItem("ljb.deviceId")).toBe(a);
  });
  it("defaults the displayName to 'Guest' and persists a set name", () => {
    expect(getDisplayName()).toBe("Guest");
    setDisplayName("  Alice  ");
    expect(getDisplayName()).toBe("Alice"); // trimmed
    expect(localStorage.getItem("ljb.displayName")).toBe("Alice");
  });
  it("ignores a blank set name (keeps the prior value)", () => {
    setDisplayName("Bob");
    setDisplayName("   ");
    expect(getDisplayName()).toBe("Bob");
  });
});
