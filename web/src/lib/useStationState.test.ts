// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStationState } from "./useStationState.js";

// Minimal controllable fake WebSocket capturing sends + exposing the open/message hooks.
class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = FakeWS.CONNECTING;
  sent: string[] = [];
  private listeners: Record<string, ((e: unknown) => void)[]> = {};
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener() {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit("close", {});
  }
  emit(type: string, e: unknown) {
    (this.listeners[type] ?? []).forEach((fn) => fn(e));
  }
  fireOpen() {
    this.readyState = FakeWS.OPEN;
    this.emit("open", {});
  }
  fireMessage(data: string) {
    this.emit("message", { data });
  }
  // A server/network-initiated close: the socket moves to CLOSED and the 'close' event
  // fires WITHOUT our own close() having been called (real WebSocket semantics).
  fireClose() {
    this.readyState = 3;
    this.emit("close", {});
  }
}

beforeEach(() => {
  FakeWS.instances = [];
  localStorage.clear();
  localStorage.setItem("ljb.deviceId", "dev-abc");
  vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe("useStationState", () => {
  it("opens /ws and sends hello{deviceId,role:'remote'} on open", () => {
    renderHook(() => useStationState());
    const ws = FakeWS.instances[0]!;
    expect(ws.url).toMatch(/\/ws$/);
    act(() => ws.fireOpen());
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      type: "hello",
      deviceId: "dev-abc",
      role: "remote",
    });
  });
  it("becomes live and stores the snapshot on a state frame", () => {
    const { result } = renderHook(() => useStationState());
    const ws = FakeWS.instances[0]!;
    act(() => ws.fireOpen());
    act(() =>
      ws.fireMessage(JSON.stringify({ type: "state", state: { current: null, paused: false } })),
    );
    expect(result.current.status).toBe("live");
    expect(result.current.snapshot).toMatchObject({ paused: false });
  });
  it("exposes the live socket on connect and CLEARS it on an unsolicited disconnect", () => {
    const { result } = renderHook(() => useStationState());
    const ws = FakeWS.instances[0]!;
    act(() => ws.fireOpen());
    // Connected: the exposed socket points at the live socket.
    expect(result.current.socket).toBe(ws);
    // Server/network drops the connection (does NOT go through our teardownSocket()).
    act(() => ws.fireClose());
    // Regression: the exposed socket must clear immediately, not linger as a CLOSED socket
    // until the reconnect timer eventually fires.
    expect(result.current.socket).toBeNull();
    expect(result.current.status).toBe("closed");
  });
});
