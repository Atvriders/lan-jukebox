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
    poTokenProviderUrl: strEnv(env, "PO_TOKEN_PROVIDER_URL"),
    playerClients: strEnv(env, "YT_PLAYER_CLIENTS") ?? "android_vr,web_embedded,tv",
    ytdlpTimeoutMs: intEnv(env, "YTDLP_TIMEOUT_MS", 60_000, { min: 1 }),
  };
}

export function loadStationConfig(env: Env = process.env): StationConfig {
  return {
    prefetchDepth: intEnv(env, "PREFETCH_DEPTH", 1, { min: 0 }),
    // Must be >= 1: a Semaphore(0) deadlocks (no download ever acquires a slot).
    maxConcurrentDownloads: intEnv(env, "MAX_TRANSCODE_JOBS", 2, { min: 1 }),
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
    port: intEnv(env, "PORT", 8080, { min: 1, max: 65535 }),
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
