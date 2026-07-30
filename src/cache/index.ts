import { mkdir, readdir } from "node:fs/promises";
import { rmSync, statSync, statfsSync } from "node:fs";
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
    // Host free-space floor (MB). Optional + 0 = disabled so existing two-arg construction sites
    // stay valid; CACHE_MAX_MB alone only bounds what THIS cache tracks, which is not enough when
    // the volume is shared (the live host filled its disk and the station crash-looped).
    private readonly minFreeDiskMb: number = 0,
  ) {}

  async init(): Promise<void> {
    // Never crash the always-on station on a bad cache dir. A full disk (ENOSPC), a read-only or
    // mis-permissioned volume would otherwise throw out of main() -> process.exit(1) -> restart
    // loop — which is exactly how a full host took the live station down. Log and continue: the
    // server still boots, the UI works, and downloads surface their own errors per track.
    try {
      await mkdir(this.dir, { recursive: true });
    } catch (err) {
      getRootLogger().error(
        { err, dir: this.dir },
        "could not create CACHE_DIR — starting with an unusable cache (downloads will fail until this is fixed)",
      );
      return; // nothing to reconcile if the dir isn't there
    }
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
    // Enforce the cap on what we just adopted. register() only makes room for the file it is
    // admitting, so an inherited cache can still end up over maxBytes (e.g. a single adopted file
    // larger than the whole cap, admitted after everything else was evicted). Older buggy builds
    // leaked pins, so the cap silently stopped applying and those bytes would otherwise persist
    // across every future restart — trim once here so the first boot reclaims them. Nothing is
    // pinned yet at init time, so this can always make progress.
    this.evictToCap(0);
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
    this.evictToCap(size);
    // Second, independent guard: the cap bounds what this cache TRACKS, but the volume can still
    // be full (logs, other containers, an under-provisioned LVM volume). Run it after the cap
    // eviction and before the entry is admitted; the file is already on disk at this point, so
    // the free-space reading already accounts for its bytes.
    this.enforceFreeDisk(size);
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

  /**
   * Evict LRU entries until `totalBytes() + incomingBytes` fits under maxBytes, or nothing more
   * can be evicted. Shared by register() (incomingBytes = the file being admitted) and the
   * post-reconcile startup trim (incomingBytes = 0).
   */
  private evictToCap(incomingBytes: number): void {
    while (this.totalBytes() + incomingBytes > this.maxBytes) {
      if (!this.evictLru()) {
        // Every remaining entry is pinned: eviction can't reclaim more, so the cache is about to
        // exceed maxBytes with no recovery path. Surface it (rather than silently over-filling)
        // so an operator has a signal before the disk fills. A leaked/never-unpinned entry is the
        // usual cause — see the pin-lifecycle fix in the orchestrator/audio route.
        getRootLogger().warn(
          { totalBytes: this.totalBytes(), incomingBytes, maxBytes: this.maxBytes },
          "audio cache over CACHE_MAX_MB: all remaining entries pinned, cannot evict",
        );
        break;
      }
    }
  }

  /**
   * Best-effort floor on HOST free space, checked before a freshly downloaded file is admitted.
   * The live host ran out of disk (its volume was never expanded) and the station died, so the
   * cache must be able to give bytes back to the filesystem even while it is under its own cap.
   * Evicts LRU entries (unpinned first, exactly as the cap path does) until the floor is met or
   * nothing more can be evicted. Never throws: a statfs failure just skips the check.
   */
  private enforceFreeDisk(incomingBytes: number): void {
    if (this.minFreeDiskMb <= 0) return; // guard disabled
    const floorBytes = this.minFreeDiskMb * 1024 * 1024;
    // Convergence guard: the disk is shared (logs, other containers, an under-provisioned volume),
    // so the shortfall is often NOT ours to fix. Without this, a host that is full for an external
    // reason would make us evict EVERY unpinned entry — deleting the whole cache and re-downloading
    // it all — while never reaching the floor. Stop as soon as an eviction stops actually freeing
    // space (or after a bounded number of them) and let the warning below tell the operator.
    let lastFree = -1;
    let evictions = 0;
    const MAX_EVICTIONS = 50;
    for (;;) {
      const freeBytes = freeBytesSafe(this.dir);
      if (freeBytes === null) return; // statfs unavailable — skip rather than guess
      if (freeBytes >= floorBytes) return;
      if (freeBytes <= lastFree || evictions >= MAX_EVICTIONS) {
        // Evicting is not moving the needle (or we have evicted enough): the shortfall is external.
        getRootLogger().warn(
          { freeBytes, floorBytes, evictions, minFreeDiskMb: this.minFreeDiskMb },
          "host disk below MIN_FREE_DISK_MB and evicting is not reclaiming it (external usage?)",
        );
        return;
      }
      lastFree = freeBytes;
      evictions += 1;
      if (!this.evictLru()) {
        getRootLogger().warn(
          { freeBytes, floorBytes, incomingBytes, minFreeDiskMb: this.minFreeDiskMb },
          "host disk below MIN_FREE_DISK_MB and nothing left to evict",
        );
        return;
      }
    }
  }

  /**
   * Drop the least-recently-used UNPINNED entry (map + file). Returns false when every remaining
   * entry is pinned, which is the callers' signal that eviction can make no further progress.
   */
  private evictLru(): boolean {
    let victim: CacheEntry | null = null;
    for (const e of this.entries.values()) {
      if (e.pinned) continue;
      if (victim === null || e.lastUsed < victim.lastUsed) victim = e;
    }
    if (victim === null) return false;
    const victimPath = victim.filePath;
    this.entries.delete(victim.videoId);
    try {
      rmSync(victimPath, { force: true });
    } catch {
      // File already gone, ignore
    }
    return true;
  }

  pin(videoId: string): void {
    const e = this.entries.get(videoId);
    if (e) e.pinned = true;
  }

  unpin(videoId: string): void {
    const e = this.entries.get(videoId);
    if (e) e.pinned = false;
  }

  /**
   * Forget a track entirely — drop the entry AND unlink its file. Used to self-heal a cached
   * track that turned out to be unusable (corrupt/undecodable), so a retry re-downloads instead
   * of re-serving the same broken bytes from the LRU. Unlike LRU eviction this ignores the pin
   * (the bad track is usually the pinned current one), and it never throws: a missing/locked
   * file is fine, the entry is gone either way.
   */
  evict(videoId: string): void {
    // Drop BOTH the source entry and the derived `${videoId}.m4a` transcode the audio route
    // registers (file `${videoId}.transcoded.m4a`). Evicting only the source leaves the transcode
    // behind, and chooseDelivery serves that cached .m4a instead of re-downloading — so the
    // self-heal would keep replaying the SAME corrupt audio it was called to get rid of.
    for (const key of [videoId, `${videoId}.m4a`]) {
      const e = this.entries.get(key);
      if (!e) continue;
      this.entries.delete(key);
      try {
        rmSync(e.filePath, { force: true });
      } catch {
        // File already gone, ignore
      }
    }
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

// Bytes still available to us on the filesystem holding `path`, or null when that can't be
// determined (statfs unsupported/permission-denied/path gone) so the caller skips the check
// instead of evicting on a bogus reading. `bavail` (not `bfree`) is used: reserved-for-root
// blocks are not ours to spend. The sync variant mirrors statSyncSafe above — register() must
// stay synchronous for its callers, so the guard it runs cannot await.
function freeBytesSafe(path: string): number | null {
  try {
    const fs = statfsSync(path, { bigint: false });
    const free = fs.bavail * fs.bsize;
    return Number.isFinite(free) && free >= 0 ? free : null;
  } catch {
    return null;
  }
}
