import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// Isolated from app.test.ts because it mocks the audio route away: the point here is only WHAT
// buildApp hands that route, not what the route then does with it.
const registerAudioRoute = vi.hoisted(() => vi.fn());
vi.mock("../audio/index.js", () => ({ registerAudioRoute }));

import { buildApp, type AppDeps } from "./app.js";
import type { WebConfig } from "../config.js";

function deps(over: Partial<AppDeps> = {}): AppDeps {
  const cfg: WebConfig = {
    publicBaseUrl: "https://j",
    viewerPassword: "letmein",
    allowNoPassword: false,
    sessionSecret: "x".repeat(32),
    port: 8080,
    host: "0.0.0.0",
    trustProxy: true,
    allowedWsOrigins: ["https://j"],
    nodeEnv: "test",
    secureCookies: false,
  };
  return {
    cfg,
    station: Object.assign(new EventEmitter(), { snapshot: vi.fn(), reportPosition: vi.fn() }),
    youtube: { resolve: vi.fn(), search: vi.fn(), download: vi.fn() },
    registry: { listConnected: vi.fn(() => []), isSpeaker: vi.fn(() => false) },
    broadcaster: { attach: vi.fn(), broadcast: vi.fn() },
    cache: { get: vi.fn(() => null), has: vi.fn(() => false), register: vi.fn(), pin: vi.fn() },
    cacheDir: "/tmp/lan-jukebox-test-cache",
    downloads: { run: vi.fn(async (f: () => Promise<unknown>) => f()) },
    radio: { reset: vi.fn() },
    searchLimit: 5,
    ...over,
  } as unknown as AppDeps;
}

describe("buildApp → audio route wiring", () => {
  beforeEach(() => registerAudioRoute.mockClear());

  it("forwards transcodeBitrateKbps so TRANSCODE_BITRATE_KBPS is not a dead knob", async () => {
    // Regression: the config value existed and was documented, but stopped at the composition
    // root — the route silently kept its own default, so setting the env var did nothing at all.
    await buildApp(deps({ transcodeBitrateKbps: 320 }));
    expect(registerAudioRoute).toHaveBeenCalledTimes(1);
    expect(registerAudioRoute.mock.calls[0]![1]).toMatchObject({ transcodeBitrateKbps: 320 });
  });

  it("passes it through as undefined when unset, leaving the route on its own default", async () => {
    await buildApp(deps());
    expect(registerAudioRoute.mock.calls[0]![1]).toMatchObject({
      transcodeBitrateKbps: undefined,
    });
  });
});
