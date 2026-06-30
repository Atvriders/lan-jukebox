import { spawn as nodeSpawn } from "node:child_process";
import type { AudioInfo } from "../types/index.js";

export interface Delivery {
  contentType: string;
  needsTranscode: boolean;
}

/** Containers we can hand to a browser <audio> unchanged, mapped to their MIME type. */
export const MIME_BY_EXT: Readonly<Record<string, string>> = {
  webm: "audio/webm",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  opus: "audio/ogg",
  ogg: "audio/ogg",
};

/** The container we transcode unplayable/unknown audio into (AAC in MP4). */
export const TRANSCODE_CONTENT_TYPE = "audio/mp4";

function normExt(ext: string): string {
  return ext.replace(/^\./, "").toLowerCase();
}

function isOpusFamily(codec: string): boolean {
  const c = codec.toLowerCase();
  return c === "opus" || c === "vorbis";
}

function isAacFamily(codec: string): boolean {
  const c = codec.toLowerCase();
  // yt-dlp emits "aac" or an ISO codec string like "mp4a.40.2".
  return c === "aac" || c.startsWith("mp4a");
}

export function chooseDelivery(audio: AudioInfo | null, ext: string): Delivery {
  // No captured format -> we can't prove the bytes are browser-safe -> transcode.
  if (!audio) {
    return { contentType: TRANSCODE_CONTENT_TYPE, needsTranscode: true };
  }
  const e = normExt(ext);
  // opus/vorbis in a webm|ogg|opus container -> serve as-is.
  if (isOpusFamily(audio.codec) && (e === "webm" || e === "ogg" || e === "opus")) {
    return { contentType: MIME_BY_EXT[e]!, needsTranscode: false };
  }
  // aac in an m4a|mp4 container -> serve as-is.
  if (isAacFamily(audio.codec) && (e === "m4a" || e === "mp4")) {
    return { contentType: MIME_BY_EXT[e]!, needsTranscode: false };
  }
  // Anything else (mp3, ac-3, flac, codec/container mismatch, unknown) -> transcode.
  return { contentType: TRANSCODE_CONTENT_TYPE, needsTranscode: true };
}

/** Hard ceiling for a single transcode. A stalled/hung ffmpeg (malformed input, blocked
 *  write) would otherwise leave the Promise pending forever — and because the caller runs
 *  this inside a Semaphore slot, a hung transcode permanently consumes a download slot and
 *  eventually deadlocks all downloads/transcodes. We kill the child and reject on timeout. */
export const TRANSCODE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Transcode/remux `srcPath` to a clean AAC `.m4a` at `destPath` via ffmpeg.
 * Resolves on exit code 0; rejects with the ffmpeg stderr tail otherwise.
 * A hung ffmpeg is force-killed after `timeoutMs` so the Promise always settles and the
 * caller's Semaphore slot is released (no slot leak / no download deadlock).
 * Injectable spawn for tests (default = node:child_process spawn).
 */
export function transcodeToM4a(
  srcPath: string,
  destPath: string,
  spawnFn: typeof nodeSpawn = nodeSpawn,
  timeoutMs: number = TRANSCODE_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      srcPath,
      "-vn", // audio only — drop any embedded cover-art video stream
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart", // moov atom up front so range requests work without a full read
      "-f",
      "mp4",
      destPath,
    ];
    const ff = spawnFn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let errTail = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      // Force the child down so its file descriptors/handle are released, then reject.
      // The subsequent 'close'/'error' events are ignored via the `settled` guard.
      try {
        ff.kill("SIGKILL");
      } catch {
        // already dead / no handle — nothing to do
      }
      settled = true;
      reject(new Error(`ffmpeg transcode timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Don't let a pending transcode timer keep the event loop alive on shutdown.
    timer.unref?.();

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    ff.stderr?.on("data", (d: Buffer) => {
      errTail = (errTail + d.toString()).slice(-2000);
    });
    ff.on("error", (err) => finish(() => reject(err)));
    ff.on("close", (code) => {
      finish(() => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg transcode failed (exit ${code}): ${errTail.trim()}`));
      });
    });
  });
}
