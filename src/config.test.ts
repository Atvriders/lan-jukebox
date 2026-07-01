import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  loadWebConfig,
  loadMediaConfig,
  loadStationConfig,
  materializeCookies,
  toNetscapeCookies,
  intEnv,
  strEnv,
} from "./config.js";

const SECRET = "x".repeat(32);
const base = {
  PUBLIC_BASE_URL: "https://jukebox.example.com",
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
    const cfg = loadWebConfig({ ...base, PUBLIC_BASE_URL: "https://jb.example.com/" });
    expect(cfg.publicBaseUrl).toBe("https://jb.example.com");
  });
  it("defaults ALLOWED_WS_ORIGINS to [publicBaseUrl]", () => {
    const cfg = loadWebConfig(base);
    expect(cfg.allowedWsOrigins).toEqual(["https://jukebox.example.com"]);
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
  it("loads historyMaxItems from HISTORY_MAX_ITEMS (default 100) so it can be wired to the Queue", () => {
    expect(loadMediaConfig({}).historyMaxItems).toBe(100);
    expect(loadMediaConfig({ HISTORY_MAX_ITEMS: "500" }).historyMaxItems).toBe(500);
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

describe("intEnv / strEnv treat whitespace-only values as unset (not 0 / not a real value)", () => {
  // Regression: intEnv only short-circuited on raw === undefined || "". A whitespace-only
  // value (a stray tab/newline from docker-compose/CI) slipped through, and Number("  ")
  // === 0 passed the finite/integer checks — silently returning 0 (disabling prefetch, or
  // throwing a misleading ">= 1" for min>=1 fields). strEnv had the same gap. Both now trim.
  it("intEnv returns the fallback for a whitespace-only value instead of 0", () => {
    expect(intEnv({ PREFETCH_DEPTH: "  " }, "PREFETCH_DEPTH", 1, { min: 0 })).toBe(1);
    expect(intEnv({ PREFETCH_DEPTH: "\t\n" }, "PREFETCH_DEPTH", 3, { min: 0 })).toBe(3);
  });
  it("intEnv does NOT throw a misleading '>= 1' for a whitespace-only min>=1 field", () => {
    expect(() => intEnv({ CACHE_MAX_MB: "  " }, "CACHE_MAX_MB", 2048, { min: 1 })).not.toThrow();
    expect(intEnv({ CACHE_MAX_MB: "  " }, "CACHE_MAX_MB", 2048, { min: 1 })).toBe(2048);
  });
  it("intEnv still trims a real numeric value with surrounding whitespace", () => {
    expect(intEnv({ PORT: " 9000 " }, "PORT", 8080)).toBe(9000);
  });
  it("strEnv returns null for a whitespace-only value instead of the raw whitespace", () => {
    expect(strEnv({ YT_PROXY: "  " }, "YT_PROXY")).toBeNull();
    expect(strEnv({ YT_PROXY: "\t" }, "YT_PROXY")).toBeNull();
  });
  it("prefetchDepth falls back to 1 (not 0) when PREFETCH_DEPTH is whitespace-only", () => {
    expect(loadStationConfig({ PREFETCH_DEPTH: "  " }).prefetchDepth).toBe(1);
  });
});

describe("loadConfig", () => {
  it("composes media + station + web", () => {
    const cfg = loadConfig(base);
    expect(cfg.media.playerClients).toBe("android_vr,web_embedded,tv");
    expect(cfg.station.maxConcurrentDownloads).toBeGreaterThanOrEqual(1);
    expect(cfg.web.publicBaseUrl).toBe("https://jukebox.example.com");
  });
});

describe("cookies (paste-into-compose)", () => {
  const line = (name: string, value: string) =>
    [".youtube.com", "TRUE", "/", "TRUE", "2000000000", name, value].join("\t");

  it("converts a browser 'Cookie:' header to Netscape lines for .youtube.com", () => {
    const out = toNetscapeCookies("Cookie: SID=abc; HSID=def; malformed");
    expect(out).toMatch(/^# Netscape HTTP Cookie File\n/);
    expect(out).toContain(line("SID", "abc"));
    expect(out).toContain(line("HSID", "def"));
    expect(out.endsWith("\n")).toBe(true);
    // a pair without '=' is skipped -> exactly two cookie lines
    expect(
      out
        .trim()
        .split("\n")
        .filter((l) => l.startsWith(".youtube.com")).length,
    ).toBe(2);
  });

  it("passes exported cookies.txt through, adding the header only when missing", () => {
    const raw = line("SID", "abc");
    expect(toNetscapeCookies(raw)).toBe(`# Netscape HTTP Cookie File\n${raw}\n`);
    const withHeader = `# Netscape HTTP Cookie File\n${raw}\n`;
    expect(toNetscapeCookies(withHeader)).toBe(withHeader);
  });

  it("materializes YT_COOKIES_TEXT to <cacheDir>/yt-cookies.txt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lj-ck-"));
    const media = loadMediaConfig({ CACHE_DIR: dir, YT_COOKIES_TEXT: "SID=abc; HSID=def" });
    const path = await materializeCookies(media);
    expect(path).toBe(join(dir, "yt-cookies.txt"));
    expect(readFileSync(path as string, "utf8")).toContain(line("SID", "abc"));
  });

  it("prefers an explicit YT_COOKIES path over YT_COOKIES_TEXT", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lj-ck-"));
    const media = loadMediaConfig({
      CACHE_DIR: dir,
      YT_COOKIES: "/mnt/cookies.txt",
      YT_COOKIES_TEXT: "SID=abc",
    });
    expect(await materializeCookies(media)).toBe("/mnt/cookies.txt");
  });

  it("returns null when neither cookies option is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lj-ck-"));
    expect(await materializeCookies(loadMediaConfig({ CACHE_DIR: dir }))).toBeNull();
  });
});
