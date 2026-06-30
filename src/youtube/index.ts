import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { MediaConfig } from "../config.js";
import type { AudioInfo, TrackMeta } from "../types/index.js";
import { runYtDlp } from "./ytdlp.js";
import { YtError, YtErrorKind, classifyYtdlpError, isRetryableAcrossClients } from "./errors.js";

type RunFn = typeof runYtDlp;

/** Canonical YouTube video ids are exactly 11 url-safe-base64 chars. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Player clients appended after the configured ones to form the fallback ladder. These
 * are the clients that, in practice, most often recover when YouTube breaks the
 * first-choice client (extraction/PO-token/age-gate). Order = most→least reliable for
 * audio. Anything already in the configured list is skipped (deduped) by buildLadder.
 */
const FALLBACK_CLIENTS = ["android_vr", "web_embedded", "tv", "web_safari", "mweb"] as const;

/**
 * Build the ordered, de-duplicated list of player_client values to try: the operator's
 * configured `YT_PLAYER_CLIENTS` first (each tried individually), then the standard
 * fallbacks. A comma-separated config entry like "android_vr,web_embedded,tv" becomes
 * three separate ladder rungs so a single broken client no longer dooms the request.
 */
export function buildClientLadder(configured: string): string[] {
  const seen = new Set<string>();
  const ladder: string[] = [];
  for (const c of [...configured.split(","), ...FALLBACK_CLIENTS]) {
    const client = c.trim();
    if (!client || seen.has(client)) continue;
    seen.add(client);
    ladder.push(client);
  }
  return ladder;
}

export interface DownloadResult {
  path: string;
  audio: AudioInfo | null;
}

/** Live download progress reported to a `download()` caller's `onProgress`. */
export interface DownloadProgress {
  /** Completion percentage 0–100 (clamped). */
  percent: number;
  /** Bytes downloaded so far (absent when yt-dlp can't report it, e.g. "NA"). */
  downloadedBytes?: number;
  /** Total bytes (absent when the size is unknown — common for streamed audio). */
  totalBytes?: number;
}

/**
 * yt-dlp `--progress-template` we hand it so each progress line is a compact,
 * pipe-delimited record we can parse deterministically (vs scraping the human
 * `[download] 45.2% of ~210MiB` line). The `download:` prefix lets us distinguish
 * progress lines from other `--newline` stdout (warnings, the AUDIOFMT print, …).
 */
export const DOWNLOAD_PROGRESS_TEMPLATE =
  "download:%(progress._percent_str)s|%(progress._downloaded_bytes)s|%(progress._total_bytes)s";

/**
 * Parse one `--progress-template`-formatted line. Returns null for any non-progress or
 * malformed line so a caller can ignore it (best-effort: a bad line never breaks the
 * download). Percent is required (and clamped to [0,100]); byte counts are optional —
 * yt-dlp emits "NA" when a size is unknown, which we map to `undefined`.
 */
export function parseDownloadProgress(line: string): DownloadProgress | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("download:")) return null;
  const body = trimmed.slice("download:".length);
  const [pctRaw, dlRaw, totalRaw] = body.split("|");
  if (pctRaw === undefined) return null;
  const pct = Number.parseFloat(pctRaw.replace("%", "").trim());
  if (!Number.isFinite(pct)) return null;
  const num = (s: string | undefined): number | undefined => {
    if (s === undefined) return undefined;
    const v = Number.parseInt(s.trim(), 10);
    return Number.isFinite(v) ? v : undefined;
  };
  return {
    percent: Math.max(0, Math.min(100, pct)),
    downloadedBytes: num(dlRaw),
    totalBytes: num(totalRaw),
  };
}

/** ≈ms of download budget per second of audio (a 1h track gets ~2h to download). */
export const DOWNLOAD_PER_SEC_MS = 2000;
/** Hard ceiling for an auto-scaled download timeout (30 min). */
export const DOWNLOAD_TIMEOUT_CAP_MS = 30 * 60_000;

/**
 * Auto-scale the yt-dlp download timeout by track duration so a long mix/concert isn't
 * killed by the short default. We give ~`DOWNLOAD_PER_SEC_MS` of budget per second of
 * audio, never going below the operator's configured base and never above the 30-min
 * cap — EXCEPT we never shrink a configured base that is itself above the cap.
 *
 *   effective = clamp(max(base, durationSec * PER_SEC_MS), base, max(base, CAP))
 *
 * A null/unknown duration falls back to the configured base (no scaling).
 */
export function scaleDownloadTimeout(
  configuredMs: number,
  durationSec: number | null | undefined,
): number {
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) {
    return configuredMs;
  }
  const budget = Math.ceil(durationSec) * DOWNLOAD_PER_SEC_MS;
  const cap = Math.max(configuredMs, DOWNLOAD_TIMEOUT_CAP_MS);
  return Math.min(cap, Math.max(configuredMs, budget));
}

/** Per-call download options: track duration (for timeout scaling) + a live progress hook. */
export interface DownloadOptions {
  /** Track length in seconds; scales the yt-dlp timeout so long audio isn't cut off. */
  durationSec?: number | null;
  /** Fired for every parsed progress line as the download streams (best-effort). */
  onProgress?: (p: DownloadProgress) => void;
}

/** Marker prefixing the yt-dlp --print line so we can locate it amid other stdout. */
const AUDIO_PRINT_PREFIX = "AUDIOFMT::";
/** Printed after the file lands on disk, reflecting the REAL post-processed format. */
const AUDIO_PRINT_TEMPLATE = `after_move:${AUDIO_PRINT_PREFIX}%(acodec)s|%(abr)s|%(tbr)s|%(asr)s`;

/** Parse "codec|abr|tbr|asr" (yt-dlp emits "NA" for missing numerics). null when codec is unknown. */
export function parseAudioInfo(stdout: string): AudioInfo | null {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith(AUDIO_PRINT_PREFIX));
  if (!line) return null;

  const [codecRaw, abrRaw, tbrRaw, asrRaw] = line.slice(AUDIO_PRINT_PREFIX.length).split("|");
  const codec = (codecRaw ?? "").trim();
  if (!codec || codec === "NA" || codec === "none") return null;

  const num = (s: string | undefined): number | null => {
    if (s === undefined) return null;
    const v = Number.parseFloat(s.trim());
    return Number.isFinite(v) ? v : null;
  };
  const bitrate = num(abrRaw) ?? num(tbrRaw);
  const asr = num(asrRaw);

  return {
    codec,
    bitrateKbps: bitrate !== null ? Math.round(bitrate) : 0,
    sampleRateHz: asr !== null ? Math.round(asr) : 0,
  };
}

interface RawThumbnail {
  url?: string;
  height?: number;
  width?: number;
}

interface RawInfo {
  id: string;
  title?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
  is_live?: boolean;
  live_status?: string;
  thumbnail?: string;
  /** --flat-playlist (ytsearch) entries expose an array of thumbnails, not a single `thumbnail`. */
  thumbnails?: RawThumbnail[];
}

/**
 * yt-dlp exposes the thumbnail differently per mode: `-J` on a single video sets a
 * `thumbnail` string, while `--flat-playlist` search entries only carry a `thumbnails`
 * array. Prefer the single field; otherwise pick the highest-resolution array entry.
 */
function pickThumbnail(j: RawInfo): string | null {
  if (typeof j.thumbnail === "string" && j.thumbnail) return j.thumbnail;
  const arr = j.thumbnails;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  let best: RawThumbnail | null = null;
  for (const t of arr) {
    if (!t || typeof t.url !== "string" || !t.url) continue;
    const area = (t.height ?? 0) * (t.width ?? 0);
    const bestArea = best ? (best.height ?? 0) * (best.width ?? 0) : -1;
    if (best === null || area > bestArea) best = t;
  }
  return best?.url ?? null;
}

function toMeta(j: RawInfo): TrackMeta {
  const isLive =
    j.is_live === true || j.live_status === "is_live" || j.live_status === "is_upcoming";
  return {
    videoId: j.id,
    title: j.title ?? "Unknown title",
    channel: j.channel ?? j.uploader ?? "Unknown",
    // yt-dlp emits duration as a float (e.g. 183.145). durationSec is typed/documented as
    // whole seconds and other consumers (orchestrator durationMs, rest seek bounds, picker
    // formatting) assume a clean integer — normalize at the source.
    durationSec: typeof j.duration === "number" ? Math.floor(j.duration) : null,
    isLive,
    thumbnailUrl: pickThumbnail(j),
  };
}

export class YouTubeService {
  constructor(
    private readonly cfg: MediaConfig,
    private readonly run: RunFn = runYtDlp,
  ) {}

  /**
   * Extractor args for a SINGLE player_client. `client` overrides the configured value
   * so the fallback ladder can probe one client per attempt.
   */
  private extractorArgs(client: string): string[] {
    const args = ["--extractor-args", `youtube:player_client=${client}`];
    // When a bgutil PO-token provider sidecar is configured, point the auto-discovered
    // bgutil HTTP plugin at it so yt-dlp can fetch a PO token for PO-token-gated clients
    // (web/mweb). The plugin itself performs the fetch; we only supply its base_url.
    if (this.cfg.poTokenProviderUrl) {
      args.push(
        "--extractor-args",
        `youtubepot-bgutilhttp:base_url=${this.cfg.poTokenProviderUrl}`,
      );
    }
    if (this.cfg.ytProxy) args.push("--proxy", this.cfg.ytProxy);
    if (this.cfg.ytCookiesFile) args.push("--cookies", this.cfg.ytCookiesFile);
    return args;
  }

  /**
   * Run `fn` against each player_client in the ladder until one succeeds. A *retryable*
   * failure (extraction/PO-token/age-gate/transport) advances to the next client; a
   * *terminal* failure (Private/Unavailable/MembersOnly/GeoBlocked/Live/TooLong) aborts
   * the ladder immediately since no client swap can fix it. If every client fails, the
   * LAST error is rethrown so the caller surfaces a concrete reason — never a silent skip.
   */
  private async withClientFallback<T>(fn: (client: string) => Promise<T>): Promise<T> {
    const ladder = buildClientLadder(this.cfg.playerClients);
    let lastErr: unknown;
    for (const client of ladder) {
      try {
        return await fn(client);
      } catch (err) {
        lastErr = err;
        if (!isRetryableAcrossClients(err)) throw err;
      }
    }
    throw lastErr ?? new YtError(YtErrorKind.Unknown, "no player clients configured");
  }

  async resolve(videoId: string): Promise<TrackMeta> {
    if (!VIDEO_ID_RE.test(videoId)) {
      throw new YtError(
        YtErrorKind.Unavailable,
        `"${videoId}" is not a YouTube video id (likely a playlist, Mix, or channel result)`,
      );
    }
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const meta = await this.withClientFallback(async (client) => {
      const { stdout, stderr, code } = await this.run(
        [
          "-J",
          "--no-playlist",
          "--no-warnings",
          "--no-progress",
          ...this.extractorArgs(client),
          "--",
          url,
        ],
        this.cfg.ytdlpTimeoutMs,
      );
      if (code !== 0) throw classifyYtdlpError(stderr, code);
      // yt-dlp exited 0 but may emit non-JSON stdout (empty/truncated/a stray warning).
      // A raw SyntaxError is not a YtError, so isRetryableAcrossClients would treat it as
      // retryable and burn the whole ladder before surfacing "Unexpected end of JSON input".
      // Convert it to a typed YtError(Unknown) so the failure is classified and legible.
      let raw: RawInfo;
      try {
        raw = JSON.parse(stdout) as RawInfo;
      } catch {
        throw new YtError(YtErrorKind.Unknown, "yt-dlp returned non-JSON output");
      }
      return toMeta(raw);
    });
    if (meta.isLive) throw new YtError(YtErrorKind.Live, "live streams are not supported");
    // NOTE: the MAX_TRACK_DURATION_SEC config is enforced here ONLY as an absolute sanity
    // ceiling (unset/null = no ceiling) so a pathological multi-hour stream can't slip past.
    // Set the compose default high enough (e.g. 14400 = 4h) that normal long content passes.
    if (
      this.cfg.maxTrackDurationSec !== null &&
      meta.durationSec !== null &&
      meta.durationSec > this.cfg.maxTrackDurationSec
    ) {
      throw new YtError(
        YtErrorKind.TooLong,
        `track is ${meta.durationSec}s, over the ${this.cfg.maxTrackDurationSec}s sanity ceiling`,
      );
    }
    return meta;
  }

  async search(query: string, limit = this.cfg.searchResultCount): Promise<TrackMeta[]> {
    const { stdout, stderr, code } = await this.run(
      [
        "-J",
        "--flat-playlist",
        "--no-warnings",
        "--no-progress",
        "--",
        `ytsearch${limit}:${query}`,
      ],
      this.cfg.ytdlpTimeoutMs,
    );
    if (code !== 0) throw classifyYtdlpError(stderr, code);

    // Convert non-JSON stdout into a typed domain error rather than letting a raw
    // SyntaxError escape to the REST route. Throwing (vs returning [])
    // is deliberate: both callers special-case YtError for user-facing messaging, and an
    // empty result would silently masquerade as "no results".
    let parsed: { entries?: RawInfo[] };
    try {
      parsed = JSON.parse(stdout) as { entries?: RawInfo[] };
    } catch {
      throw new YtError(YtErrorKind.Unknown, "search: yt-dlp returned non-JSON output");
    }
    return (parsed.entries ?? []).map(toMeta);
  }

  /**
   * Fetch YouTube's own Mix/radio ("autoplay") feed for a seed video and return the
   * upcoming related tracks as TrackMeta. This powers the panel's "autoplay" setting.
   *
   * HONESTY: this is NOT a genre classifier — there is no audio analysis. We ask
   * yt-dlp for the flat-playlist of the `RD<videoId>` Mix list (the same radio YouTube
   * would auto-play after the seed) and map the entries. The seed video itself (and any
   * duplicates) are filtered out so the caller gets only NEW tracks.
   *
   * Best-effort: a yt-dlp failure resolves to `[]` (the caller falls back to idle)
   * rather than throwing, since autoplay should never break normal playback.
   */
  async related(videoId: string): Promise<TrackMeta[]> {
    // Best-effort per the contract above: ANY failure — non-zero exit, unparseable
    // output, OR a runner-level rejection (timeout YtError, ENOENT spawn error) —
    // resolves to [] rather than throwing, mirroring artistTracks(). Autoplay must
    // never break normal playback.
    try {
      const url = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
      // Use the SAME client fallback ladder as resolve()/download(): a first-client outage
      // (the exact YouTube-side breakage the ladder exists for) must not permanently disable
      // autoplay radio. A retryable extraction error advances to the next client; the outer
      // try/catch still honors the best-effort contract by resolving to [] if every client fails.
      const parsed = await this.withClientFallback(async (client) => {
        const { stdout, stderr, code } = await this.run(
          [
            "-J",
            "--flat-playlist",
            "--no-warnings",
            "--no-progress",
            ...this.extractorArgs(client),
            "--",
            url,
          ],
          this.cfg.ytdlpTimeoutMs,
        );
        if (code !== 0) throw classifyYtdlpError(stderr, code);
        // Non-JSON on a zero exit → typed YtError(Unknown) so it's retried across the ladder
        // (a SyntaxError is not a YtError and would be treated as retryable anyway, but a typed
        // error keeps the failure classified rather than leaking a raw SyntaxError).
        try {
          return JSON.parse(stdout) as { entries?: RawInfo[] };
        } catch {
          throw new YtError(YtErrorKind.Unknown, "related: yt-dlp returned non-JSON output");
        }
      });

      const seen = new Set<string>([videoId]);
      const out: TrackMeta[] = [];
      for (const entry of parsed.entries ?? []) {
        if (!entry || typeof entry.id !== "string" || seen.has(entry.id)) continue;
        seen.add(entry.id);
        out.push(toMeta(entry));
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Autoplay SOURCE = "artist": find more songs by the last track's artist by running a
   * plain YouTube search for the track's `channel` (artist/uploader) name and returning
   * the result entries as TrackMeta. The seed track's own id is filtered out.
   *
   * HONESTY: this is NOT a verified discography or a genre classifier. It is only as
   * accurate as the `channel` string and YouTube's search ranking — e.g. a topic
   * channel name, a label, or a generic uploader will skew results. It keys off the
   * single last track, not the session.
   *
   * Best-effort: any failure — a missing/unknown channel, a yt-dlp non-zero exit, the
   * runner rejecting, or unparseable output — resolves to `[]` (the caller idles)
   * rather than throwing, so autoplay never breaks normal playback.
   */
  async artistTracks(meta: TrackMeta): Promise<TrackMeta[]> {
    const artist = (meta.channel ?? "").trim();
    // Without a usable artist name there is nothing to search for. yt-dlp's `toMeta`
    // uses "Unknown" as the channel fallback, which would search for the literal word.
    if (!artist || artist === "Unknown") return [];

    try {
      const limit = Math.max(1, this.cfg.searchResultCount);
      // Strip characters that could confuse the ytsearch query, then bias toward the
      // artist's songs. (yt-dlp treats the text after `ytsearchN:` as a plain query.)
      const query = `${artist.replace(/["\n\r]/g, " ")} songs`;
      const { stdout, code } = await this.run(
        [
          "-J",
          "--flat-playlist",
          "--no-warnings",
          "--no-progress",
          "--",
          `ytsearch${limit}:${query}`,
        ],
        this.cfg.ytdlpTimeoutMs,
      );
      if (code !== 0) return [];

      const parsed = JSON.parse(stdout) as { entries?: RawInfo[] };
      const seen = new Set<string>([meta.videoId]);
      const out: TrackMeta[] = [];
      for (const entry of parsed.entries ?? []) {
        if (!entry || typeof entry.id !== "string" || seen.has(entry.id)) continue;
        seen.add(entry.id);
        out.push(toMeta(entry));
      }
      return out;
    } catch {
      return [];
    }
  }

  async download(
    videoId: string,
    outDir: string,
    opts: DownloadOptions = {},
  ): Promise<DownloadResult> {
    if (!VIDEO_ID_RE.test(videoId)) {
      throw new YtError(
        YtErrorKind.Unavailable,
        `"${videoId}" is not a YouTube video id (likely a playlist, Mix, or channel result)`,
      );
    }
    // Auto-scale the timeout so a long mix/concert isn't killed by the short default.
    const timeoutMs = scaleDownloadTimeout(this.cfg.ytdlpTimeoutMs, opts.durationSec);
    // Per progress line: parse it and (best-effort) forward to the caller. A throw inside
    // onProgress is swallowed at the runner (runYtDlp's emitLine), so it can't break the
    // download; we also guard the parse here.
    const onLine = opts.onProgress
      ? (line: string): void => {
          const p = parseDownloadProgress(line);
          if (p) opts.onProgress!(p);
        }
      : undefined;
    const maxMb = Math.floor(this.cfg.cacheMaxBytes / (1024 * 1024));
    const stdout = await this.withClientFallback(async (client) => {
      const args = [
        "-f",
        "bestaudio[acodec=opus]/bestaudio/best",
        "--no-playlist",
        // Write the download in place rather than to a separate `<id>.<fmt>.part` file, so a
        // killed/timed-out attempt (SIGKILL on timeout skips yt-dlp's own cleanup) cannot
        // leave a partial artifact that the readdir-based file detection below could pick up.
        "--no-part",
        "--max-filesize",
        `${Math.max(1, Math.min(maxMb, 500))}M`,
        "--socket-timeout",
        "30",
        "--retries",
        "3",
        "--no-warnings",
        // Emit one progress record per line (vs in-place \r rewrites) so the line-splitter
        // can surface live download progress through onProgress.
        "--newline",
        "--progress-template",
        DOWNLOAD_PROGRESS_TEMPLATE,
        "--print",
        AUDIO_PRINT_TEMPLATE,
        ...this.extractorArgs(client),
      ];
      args.push(
        "-o",
        join(outDir, "%(id)s.%(ext)s"),
        "--",
        `https://www.youtube.com/watch?v=${videoId}`,
      );

      const { stdout, stderr, code } = await this.run(args, timeoutMs, onLine);
      if (code !== 0) throw classifyYtdlpError(stderr, code);
      return stdout;
    });

    const files = await readdir(outDir);
    // Never select a partial/intermediate artifact. A previous client's timed-out attempt is
    // SIGKILLed (no yt-dlp cleanup), so a `<videoId>.<fmt>.part` (or `.ytdl`/`.temp`) can
    // linger in outDir; readdir typically returns it first (creation order), and the bare
    // `startsWith(videoId + ".")` predicate would match it — returning a truncated file to play
    // or cache. Filter those out so only the finalized audio file is ever chosen.
    const produced = files.find(
      (f) =>
        f.startsWith(`${videoId}.`) &&
        !f.endsWith(".part") &&
        !f.endsWith(".ytdl") &&
        !f.endsWith(".temp"),
    );
    if (!produced) {
      throw new YtError(
        YtErrorKind.Unknown,
        `download completed but no file for ${videoId} was found`,
      );
    }
    return { path: join(outDir, produced), audio: parseAudioInfo(stdout) };
  }
}
