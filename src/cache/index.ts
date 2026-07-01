import { mkdir, readdir } from "node:fs/promises";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AudioInfo } from "../types/index.js";
import { getRootLogger } from "../util/logger.js";

interface CacheEntry {
  videoId: string;
  filePath: string;
  sizeBytes: number;
  lastUsed: number;
  pinned: boolean;
  audio: AudioInfo | null;
}

export class AudioCache {
  private readonly entries = new Map<string, CacheEntry>();
  private clock = 0;

  constructor(
    private readonly dir: string,
    private readonly maxBytes: number,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.reconcile();
  }

  /**
   * Adopt audio files left in the cache dir by prior runs into the in-memory index so they
   * (a) count toward totalBytes()/maxBytes and (b) participate in LRU eviction. The index is
   * never persisted (the station snapshot carries only queue/seed/settings), so without this
   * every restart would start with an empty map while a persistent CACHE_DIR volume still held
   * every file previous runs downloaded — those files would be untracked forever, never counted
   * and never evicted, so real disk usage grows unbounded across restarts on a station meant to
   * run indefinitely. Reconciling (rather than purging) lets a restart REUSE cached audio
   * instead of re-downloading it, while still honoring the cap.
   *
   * Only files whose name matches a known audio artifact are adopted; sidecar JSON
   * (station-snapshot / device-registry) and half-written `.tmp` staging files are ignored so
   * they are never served or evicted. Adopted entries are unpinned (pins are re-applied at
   * runtime when a track becomes current), and derive their cache KEY exactly as the runtime
   * register() calls do, so a later re-register overwrites the same entry rather than orphaning it.
   */
  private async reconcile(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return; // dir unreadable — nothing to reconcile
    }
    for (const name of names) {
      const key = cacheKeyForFile(name);
      if (key === null) continue;
      // Skip anything already registered (defensive: reconcile runs once at init, but never
      // clobber a live entry) and let register() do the stat/size guard + eviction bookkeeping.
      if (this.entries.has(key)) continue;
      this.register(key, join(this.dir, name));
    }
  }

  has(videoId: string): boolean {
    return this.entries.has(videoId);
  }

  get(videoId: string): string | null {
    const e = this.entries.get(videoId);
    if (!e) return null;
    e.lastUsed = ++this.clock;
    return e.filePath;
  }

  /** Real audio format captured at download time, or null if unknown / not cached. */
  getAudio(videoId: string): AudioInfo | null {
    return this.entries.get(videoId)?.audio ?? null;
  }

  register(videoId: string, filePath: string, audio: AudioInfo | null = null): void {
    const stat = statSyncSafe(filePath);
    // Refuse to register a file that does not exist OR is 0 bytes on disk: inserting a
    // size-0 ghost entry would make has() report true and get() hand out a path to an empty
    // file the player can't read (and serve it as audio/* with Content-Length 0). A 0-byte
    // file is exactly what a failed/aborted ffmpeg leaves behind, so guard against it here.
    if (stat === null || stat.size <= 0) return;
    const { size } = stat;
    const oldEntry = this.entries.get(videoId);
    // Free the old entry's accounting UP FRONT (delete from the map; remove its file if the
    // path actually changes) before the eviction loop. This makes totalBytes() reflect reality
    // throughout the loop. The previous approach subtracted a constant `oldSize` from
    // totalBytes() in the loop condition; if the old entry was ITSELF chosen as an eviction
    // victim mid-loop, it left the map yet `- oldSize` kept subtracting it — a phantom credit
    // that undercounted used bytes, exited the loop early, and could leave the cache over the
    // cap with other evictable entries still present.
    if (oldEntry) {
      this.entries.delete(videoId);
      if (oldEntry.filePath !== filePath) {
        try {
          rmSync(oldEntry.filePath, { force: true });
        } catch {
          // File already gone, ignore
        }
      }
    }
    // Evict to make room for the new entry. No `oldSize` term is needed now — the old entry's
    // bytes are genuinely gone from the map rather than being subtracted as a constant.
    while (this.totalBytes() + size > this.maxBytes) {
      let victim: CacheEntry | null = null;
      for (const e of this.entries.values()) {
        if (e.pinned) continue;
        if (victim === null || e.lastUsed < victim.lastUsed) victim = e;
      }
      if (victim === null) {
        // Every remaining entry is pinned: eviction can't reclaim more, so the cache is about to
        // exceed maxBytes with no recovery path. Surface it (rather than silently over-filling)
        // so an operator has a signal before the disk fills. A leaked/never-unpinned entry is the
        // usual cause — see the pin-lifecycle fix in the orchestrator/audio route.
        getRootLogger().warn(
          { totalBytes: this.totalBytes(), incomingBytes: size, maxBytes: this.maxBytes },
          "audio cache over CACHE_MAX_MB: all remaining entries pinned, cannot evict",
        );
        break;
      }
      const victimPath = victim.filePath;
      this.entries.delete(victim.videoId);
      try {
        rmSync(victimPath, { force: true });
      } catch {
        // File already gone, ignore
      }
    }
    // Now add the entry (the old one for this videoId, if any, was already removed above).
    this.entries.set(videoId, {
      videoId,
      filePath,
      sizeBytes: size,
      lastUsed: ++this.clock,
      pinned: oldEntry?.pinned ?? false,
      audio: audio ?? oldEntry?.audio ?? null,
    });
  }

  pin(videoId: string): void {
    const e = this.entries.get(videoId);
    if (e) e.pinned = true;
  }

  unpin(videoId: string): void {
    const e = this.entries.get(videoId);
    if (e) e.pinned = false;
  }

  totalBytes(): number {
    let total = 0;
    for (const e of this.entries.values()) total += e.sizeBytes;
    return total;
  }
}

// Map a cache-dir filename back to the cache KEY the runtime would register it under, or null
// if the file is not a recognized audio artifact (so reconcile skips snapshot/registry JSON and
// `.tmp` staging files). Mirrors the two register() call sites:
//   download  -> register("<id>",     "<id>.<ext>")            key = the 11-char video id
//   transcode -> register("<id>.m4a", "<id>.transcoded.m4a")   key = "<id>.m4a"
const RECONCILE_ID = "[A-Za-z0-9_-]{11}";
const TRANSCODED_RE = new RegExp(`^(${RECONCILE_ID})\\.transcoded\\.m4a$`);
// Any other single-extension file named "<id>.<ext>" is a raw download/prefetch artifact.
const DOWNLOAD_RE = new RegExp(`^(${RECONCILE_ID})\\.[A-Za-z0-9]+$`);
function cacheKeyForFile(name: string): string | null {
  const t = TRANSCODED_RE.exec(name);
  if (t) return `${t[1]!}.m4a`;
  // Guard AFTER the transcode check: "<id>.transcoded.m4a" also matches a naive "<id>.<ext>"
  // pattern, but its ext ("transcoded") is not the raw form — exclude it explicitly.
  if (name.includes(".transcoded.")) return null;
  const d = DOWNLOAD_RE.exec(name);
  if (d) return d[1]!;
  return null;
}

// statSync via the promise API is awkward in register() (sync needed before evict bookkeeping);
// use a tiny sync helper so register stays synchronous for callers. Returns null when the
// file is missing/unstattable so the caller can skip the registration entirely rather than
// inserting a misleading size-0 ghost entry.
function statSyncSafe(filePath: string): { size: number } | null {
  try {
    return { size: statSync(filePath).size };
  } catch {
    return null;
  }
}
