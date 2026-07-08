import type { AudioInfo } from "../types/index.js";
import type { DownloadOptions, DownloadResult } from "../youtube/index.js";
import type { Semaphore } from "./semaphore.js";

export interface CoalescedDownloadDeps {
  /** The underlying network download (yt-dlp) — spawned at most once per in-flight videoId. */
  download: (videoId: string, opts: DownloadOptions) => Promise<DownloadResult>;
  /** Cache lookup: the on-disk path for an already-downloaded videoId, or null. Bumps LRU. */
  cacheGet: (videoId: string) => string | null;
  /** The cached audio format for a hit (null when unknown). */
  cacheGetAudio: (videoId: string) => AudioInfo | null;
  /** Shared concurrency gate so every real download (load AND prefetch) is serialized under it. */
  semaphore: Pick<Semaphore, "run">;
}

/**
 * Build a download function that BOTH the orchestrator's load path (`deps.download`) and its
 * prefetch path (`deps.prefetch`) share, so the same videoId is never fetched twice concurrently.
 *
 * Root fix for the "user song fails then a radio track plays instead" bug: on enqueue into an
 * idle/empty queue the Queue emits "prefetch" for the upcoming head → deps.prefetch(id) spawns
 * yt-dlp, and the orchestrator then promotes that SAME id to current → loadCurrentLocked calls
 * deps.download(id) spawning a SECOND yt-dlp for the identical id. Because youtube.download writes
 * with `--no-part` straight to the final `<id>.<ext>` path, two concurrent processes interleave/
 * truncate the file → the browser <audio> fails to decode → the track is discarded and the next
 * (radio) track becomes current. Coalescing by videoId (plus a cache pre-check) guarantees one
 * writer per id and lets a finished prefetch satisfy the load instead of re-downloading. All
 * downloads run through the shared Semaphore so the concurrency cap actually bounds them.
 */
export function createCoalescedDownload(
  deps: CoalescedDownloadDeps,
): (videoId: string, opts?: DownloadOptions) => Promise<DownloadResult> {
  const inflight = new Map<string, Promise<DownloadResult>>();
  return (videoId: string, opts: DownloadOptions = {}): Promise<DownloadResult> => {
    // Already on disk (e.g. a prefetch or a prior play finished): serve it, never re-download.
    const cachedPath = deps.cacheGet(videoId);
    if (cachedPath) {
      return Promise.resolve({ path: cachedPath, audio: deps.cacheGetAudio(videoId) });
    }
    // Join the in-flight download for this id if one exists (a load joining its own prefetch, or
    // vice versa); otherwise start exactly one, gated by the shared semaphore. Clear the map entry
    // when it settles so a later re-download (LRU eviction, a failed attempt) can start fresh.
    let p = inflight.get(videoId);
    if (!p) {
      p = deps.semaphore
        .run(() => deps.download(videoId, opts))
        .finally(() => {
          inflight.delete(videoId);
        });
      inflight.set(videoId, p);
    }
    return p;
  };
}
