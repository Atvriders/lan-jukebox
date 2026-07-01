import { describe, it, expect, vi, afterEach } from "vitest";
import { api, ApiError } from "./api.js";

function mockOnce(ok: boolean, json: unknown, status = ok ? 200 : 400, statusText?: string) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    statusText,
    headers: { get: () => null },
    json: async () => json,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
afterEach(() => vi.unstubAllGlobals());

describe("api client", () => {
  it("login POSTs the LoginRequest body as JSON with credentials", async () => {
    const fn = mockOnce(true, { displayName: "Al", deviceId: "d1" });
    const s = await api.login({ password: "pw", displayName: "Al", deviceId: "d1" });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("/api/login");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).credentials).toBe("include");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      password: "pw",
      displayName: "Al",
      deviceId: "d1",
    });
    expect(s.deviceId).toBe("d1");
  });
  it("state GETs /api/state with credentials", async () => {
    const fn = mockOnce(true, { current: null, isThisDeviceSpeaker: false });
    const r = await api.state();
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("/api/state");
    expect((init as RequestInit).method).toBeUndefined(); // GET
    expect((init as RequestInit).credentials).toBe("include");
    expect(r.isThisDeviceSpeaker).toBe(false);
  });
  it("add POSTs { urlOrQuery } and surfaces candidates", async () => {
    const fn = mockOnce(true, { candidates: [{ videoId: "v1", title: "T" }] });
    const r = await api.add("some song");
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("/api/add");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ urlOrQuery: "some song" });
    expect(r.candidates?.[0]?.videoId).toBe("v1");
  });
  it("pick POSTs { candidateId }", async () => {
    const fn = mockOnce(true, { queued: { id: "i1", title: "T" } });
    const r = await api.pick("v1");
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("/api/pick");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ candidateId: "v1" });
    expect(r.queued.id).toBe("i1");
  });
  it("control POSTs { action } and forwards a value when given", async () => {
    const fn = mockOnce(true, { ok: true });
    await api.control("seek", 42000);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("/api/control");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      action: "seek",
      value: 42000,
    });
  });
  it("control omits value when not provided (bodyless-ish action like pause)", async () => {
    const fn = mockOnce(true, { ok: true });
    await api.control("pause");
    expect(JSON.parse(String((fn.mock.calls[0]![1] as RequestInit).body))).toEqual({
      action: "pause",
    });
  });
  it("speaker POSTs { action } and returns the active player id", async () => {
    const fn = mockOnce(true, { ok: true, activePlayerDeviceId: "d1" });
    const r = await api.speaker("claim");
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("/api/speaker");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ action: "claim" });
    expect(r.activePlayerDeviceId).toBe("d1");
  });
  it("lyrics GETs /api/lyrics with the trackId query and surfaces the null branch", async () => {
    const fn = mockOnce(true, { lyrics: null, source: "lyrics.ovh" });
    const r = await api.lyrics("v1");
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("/api/lyrics?trackId=v1");
    expect((init as RequestInit).method).toBeUndefined(); // GET
    expect(r.lyrics).toBeNull();
  });
  it("logout resolves on an empty 204 body without parsing JSON", async () => {
    const fn = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    });
    vi.stubGlobal("fetch", fn);
    await expect(api.logout()).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledWith("/api/logout", expect.objectContaining({ method: "POST" }));
  });
  it("throws ApiError with the status AND the body's error message on non-OK", async () => {
    mockOnce(false, { error: "bad password" }, 401);
    await expect(
      api.login({ password: "x", displayName: "y", deviceId: "z" }),
    ).rejects.toMatchObject({ status: 401, message: "bad password" });
  });
  it("falls back to statusText when the non-OK body has no parseable JSON", async () => {
    const fn = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError("boom");
      },
    });
    vi.stubGlobal("fetch", fn);
    await expect(api.state()).rejects.toMatchObject({
      status: 500,
      message: "Internal Server Error",
    });
  });
  it("ApiError is an Error subclass named ApiError", () => {
    const e = new ApiError(403, "forbidden");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ApiError");
    expect(e.status).toBe(403);
  });
});
