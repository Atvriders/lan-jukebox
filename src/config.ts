import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MediaConfig, StationConfig, WebConfig, AppConfig } from "./types/index.js";
import { LEVELS, isValidLevel } from "./util/logger.js";

export type { MediaConfig, StationConfig, WebConfig, AppConfig } from "./types/index.js";

type Env = Record<string, string | undefined>;

export function intEnv(
  env: Env,
  key: string,
  fallback: number,
  opts?: { min?: number; max?: number },
): number {
  // Trim first so a whitespace-only value (a stray tab/newline from docker-compose/CI) is
  // treated as unset rather than parsed: Number("  ") === 0, which would silently pass the
  // finite/integer checks and yield 0 (disabling prefetch, or throwing a misleading ">= 1").
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Invalid ${key}: expected an integer, got "${raw}"`);
  }
  if (opts?.min !== undefined && n < opts.min) {
    throw new Error(`Invalid ${key}: expected >= ${opts.min}, got "${raw}"`);
  }
  if (opts?.max !== undefined && n > opts.max) {
    throw new Error(`Invalid ${key}: expected <= ${opts.max}, got "${raw}"`);
  }
  return n;
}

export function strEnv(env: Env, key: string): string | null {
  // Trim so a whitespace-only value is treated as unset (null) rather than returned as a
  // real value, matching intEnv's handling.
  const raw = env[key]?.trim();
  return raw === undefined || raw === "" ? null : raw;
}

/**
 * Validate LOG_LEVEL against the SAME level set the logger uses (imported, never duplicated)
 * and fail fast on an unrecognized value — consistent with how intEnv/PORT/SESSION_SECRET
 * reject bad config in this file. Case is normalized so a valid level in any case
 * (e.g. "WARN" from docker-compose/CI) is accepted, not rejected.
 */
function parseLogLevel(raw: string | null): string {
  if (raw === null) return "info";
  if (!isValidLevel(raw)) {
    throw new Error(`Invalid LOG_LEVEL: got "${raw}" (expected one of ${LEVELS.join(", ")})`);
  }
  return raw.toLowerCase();
}

export function loadMediaConfig(env: Env = process.env): MediaConfig {
  const maxDur = strEnv(env, "MAX_TRACK_DURATION_SEC");
  // SponsorBlock: unset/empty → music-focused default; a literal "off" → disabled (null);
  // any other value → that raw CSV, passed straight through to yt-dlp.
  const sponsorblockRaw = strEnv(env, "YT_SPONSORBLOCK");
  return {
    cacheDir: strEnv(env, "CACHE_DIR") ?? "/data/cache",
    cacheMaxBytes: intEnv(env, "CACHE_MAX_MB", 2048, { min: 1 }) * 1024 * 1024,
    historyMaxItems: intEnv(env, "HISTORY_MAX_ITEMS", 100, { min: 1 }),
    searchResultCount: intEnv(env, "SEARCH_RESULT_COUNT", 5, { min: 1 }),
    // 0 (or negative) means "no ceiling", matching the null-handling convention used
    // throughout the codebase. A bare 0 would otherwise reject EVERY positive-duration
    // track in the youtube guard, silently breaking all playback.
    maxTrackDurationSec:
      maxDur === null ? null : intEnv(env, "MAX_TRACK_DURATION_SEC", 0, { min: 0 }) || null,
    ytProxy: strEnv(env, "YT_PROXY"),
    ytCookiesFile: strEnv(env, "YT_COOKIES"),
    // Inline cookies.txt CONTENT pasted straight into compose — materialized to a file at
    // startup (see materializeCookies) since yt-dlp's --cookies only accepts a path.
    ytCookiesText: strEnv(env, "YT_COOKIES_TEXT"),
    sponsorblockCategories:
      sponsorblockRaw === null
        ? "music_offtopic,intro,outro,sponsor,selfpromo,preview,interaction"
        : sponsorblockRaw.toLowerCase() === "off"
          ? null
          : sponsorblockRaw,
    poTokenProviderUrl: strEnv(env, "PO_TOKEN_PROVIDER_URL"),
    playerClients: strEnv(env, "YT_PLAYER_CLIENTS") ?? "android_vr,web_embedded,tv",
    ytdlpTimeoutMs: intEnv(env, "YTDLP_TIMEOUT_MS", 60_000, { min: 1 }),
  };
}

/**
 * Normalize pasted cookie text to Netscape cookies.txt (what yt-dlp's --cookies wants). Accepts
 * BOTH forms so a paste "just works":
 *  - an exported cookies.txt (tab-separated Netscape lines; the "# Netscape HTTP Cookie File"
 *    header is added if missing), OR
 *  - a raw browser "Cookie:" REQUEST HEADER ("name=value; name=value; …" on one line, e.g. copied
 *    from DevTools → Network → a youtube.com request). The header form is converted, assuming the
 *    youtube.com origin (domain ".youtube.com", path "/", Secure). Header cookies carry no expiry,
 *    so a far-future one is stamped in.
 */
export function toNetscapeCookies(text: string): string {
  const t = text.trim().replace(/^cookie:\s*/i, "");
  // Already Netscape: tab-separated fields or the file header present → use as-is (+ header).
  if (t.includes("\t") || /^#\s*(netscape|http\s+cookie)/i.test(t)) {
    const withHeader = /^#\s*(netscape|http\s+cookie)/i.test(t)
      ? t
      : `# Netscape HTTP Cookie File\n${t}`;
    return withHeader.endsWith("\n") ? withHeader : `${withHeader}\n`;
  }
  // Otherwise treat it as a "Cookie:" request header and convert each name=value pair.
  const EXPIRY = "2000000000"; // ~2033; a browser Cookie header has no per-cookie expiry
  const out = ["# Netscape HTTP Cookie File"];
  for (const pair of t.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    // Secure=TRUE is correct for YouTube's https-only auth cookies (and required for the
    // __Secure-/__Host- prefixed ones) so yt-dlp sends them.
    out.push([".youtube.com", "TRUE", "/", "TRUE", EXPIRY, name, value].join("\t"));
  }
  return `${out.join("\n")}\n`;
}

/**
 * Resolve the effective yt-dlp cookies FILE path. An explicit YT_COOKIES path always wins.
 * Otherwise, if YT_COOKIES_TEXT (inline cookies content pasted into compose) is set, write it to
 * `<cacheDir>/yt-cookies.txt` (0600, since these are auth cookies) and return that path — yt-dlp's
 * --cookies only accepts a path, not the cookie text. Returns null when neither is configured.
 * Called once at startup before the YouTubeService is used.
 */
export async function materializeCookies(media: MediaConfig): Promise<string | null> {
  if (media.ytCookiesFile) return media.ytCookiesFile;
  const text = media.ytCookiesText?.trim();
  if (!text) return null;
  await mkdir(media.cacheDir, { recursive: true });
  const path = join(media.cacheDir, "yt-cookies.txt");
  await writeFile(path, toNetscapeCookies(text), { mode: 0o600 });
  return path;
}

export function loadStationConfig(env: Env = process.env): StationConfig {
  return {
    prefetchDepth: intEnv(env, "PREFETCH_DEPTH", 1, { min: 0 }),
    // Must be >= 1: a Semaphore(0) deadlocks (no download ever acquires a slot).
    maxConcurrentDownloads: intEnv(env, "MAX_TRANSCODE_JOBS", 2, { min: 1 }),
    // 0 = no cap (radio autoplay never skips on length); user-requested tracks are never capped.
    maxAutoplayDurationSec: intEnv(env, "RADIO_MAX_AUTOPLAY_SEC", 900, { min: 0 }),
    logLevel: parseLogLevel(strEnv(env, "LOG_LEVEL")),
  };
}

export function loadWebConfig(env: Env = process.env): WebConfig {
  const publicBaseUrlRaw = strEnv(env, "PUBLIC_BASE_URL");
  const sessionSecret = strEnv(env, "SESSION_SECRET");
  const viewerPassword = strEnv(env, "VIEWER_PASSWORD");
  const allowNoPassword = strEnv(env, "ALLOW_NO_PASSWORD") === "true";
  if (!publicBaseUrlRaw) throw new Error("PUBLIC_BASE_URL is required");
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET is required and must be at least 32 characters");
  }
  if (!viewerPassword && !allowNoPassword) {
    throw new Error("VIEWER_PASSWORD is required (set ALLOW_NO_PASSWORD=true to bypass)");
  }
  const publicBaseUrl = publicBaseUrlRaw.replace(/\/$/, "");
  const nodeEnv = strEnv(env, "NODE_ENV") ?? "development";
  return {
    publicBaseUrl,
    viewerPassword: viewerPassword ?? "",
    allowNoPassword,
    sessionSecret,
    port: intEnv(env, "PORT", 3018, { min: 1, max: 65535 }),
    host: strEnv(env, "HOST") ?? "0.0.0.0",
    // The app is always served behind the user's Cloudflare Tunnel, so X-Forwarded-*
    // headers are always trustworthy here. Always-on; no env knob.
    trustProxy: true,
    allowedWsOrigins: (strEnv(env, "ALLOWED_WS_ORIGINS") ?? publicBaseUrl)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    nodeEnv,
    secureCookies: nodeEnv === "production",
  };
}

export function loadConfig(env: Env = process.env): AppConfig {
  return {
    media: loadMediaConfig(env),
    station: loadStationConfig(env),
    web: loadWebConfig(env),
  };
}
