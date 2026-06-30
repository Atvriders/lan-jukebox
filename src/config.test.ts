import { describe, it, expect } from "vitest";
import { loadConfig, loadWebConfig, loadMediaConfig, loadStationConfig } from "./config.js";

const SECRET = "x".repeat(32);
const base = {
  PUBLIC_BASE_URL: "https://jukebox.waterburp.com",
  SESSION_SECRET: SECRET,
  VIEWER_PASSWORD: "hunter2",
};

describe("loadWebConfig", () => {
  it("throws when VIEWER_PASSWORD unset and ALLOW_NO_PASSWORD is not 'true'", () => {
    const { VIEWER_PASSWORD: _VIEWER_PASSWORD, ...noPw } = base;
    expect(() => loadWebConfig(noPw)).toThrow(/VIEWER_PASSWORD/);
  });
  it("allows no password when ALLOW_NO_PASSWORD === 'true'", () => {
    const { VIEWER_PASSWORD: _VIEWER_PASSWORD, ...noPw } = base;
    const cfg = loadWebConfig({ ...noPw, ALLOW_NO_PASSWORD: "true" });
    expect(cfg.allowNoPassword).toBe(true);
    expect(cfg.viewerPassword).toBe("");
  });
  it("throws when SESSION_SECRET shorter than 32 chars", () => {
    expect(() => loadWebConfig({ ...base, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
  });
  it("requires PUBLIC_BASE_URL and strips a trailing slash", () => {
    const cfg = loadWebConfig({ ...base, PUBLIC_BASE_URL: "https://jb.waterburp.com/" });
    expect(cfg.publicBaseUrl).toBe("https://jb.waterburp.com");
  });
  it("defaults ALLOWED_WS_ORIGINS to [publicBaseUrl]", () => {
    const cfg = loadWebConfig(base);
    expect(cfg.allowedWsOrigins).toEqual(["https://jukebox.waterburp.com"]);
  });
  it("always sets trustProxy true (always behind the tunnel; no env knob) and derives secureCookies from NODE_ENV", () => {
    const dev = loadWebConfig(base);
    expect(dev.trustProxy).toBe(true);
    expect(dev.secureCookies).toBe(false);
    // No TRUST_PROXY knob: trustProxy stays true regardless of any env value.
    expect(loadWebConfig({ ...base, TRUST_PROXY: "false" }).trustProxy).toBe(true);
    const prod = loadWebConfig({ ...base, NODE_ENV: "production" });
    expect(prod.secureCookies).toBe(true);
  });
});

describe("loadMediaConfig", () => {
  it("defaults the player-client ladder to android_vr,web_embedded,tv (spec §8)", () => {
    expect(loadMediaConfig({}).playerClients).toBe("android_vr,web_embedded,tv");
  });
  it("treats MAX_TRACK_DURATION_SEC=0 as no ceiling (null)", () => {
    expect(loadMediaConfig({ MAX_TRACK_DURATION_SEC: "0" }).maxTrackDurationSec).toBeNull();
  });
});

describe("loadStationConfig (station never auto-stops — no auto-stop field)", () => {
  it("provides prefetchDepth + maxConcurrentDownloads + logLevel and NO auto-stop field", () => {
    const s = loadStationConfig({});
    expect(s.prefetchDepth).toBeGreaterThanOrEqual(0);
    expect(s.maxConcurrentDownloads).toBeGreaterThanOrEqual(1);
    expect(s.logLevel).toBe("info");
    // Regression guard: the station runs forever, so no auto-stop key may exist.
    const autoStopKey = ["idle", "Timeout", "Ms"].join("");
    expect(Object.keys(s)).not.toContain(autoStopKey);
  });
});

describe("loadConfig", () => {
  it("composes media + station + web", () => {
    const cfg = loadConfig(base);
    expect(cfg.media.playerClients).toBe("android_vr,web_embedded,tv");
    expect(cfg.station.maxConcurrentDownloads).toBeGreaterThanOrEqual(1);
    expect(cfg.web.publicBaseUrl).toBe("https://jukebox.waterburp.com");
  });
});
