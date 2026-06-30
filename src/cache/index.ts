import { mkdir } from "node:fs/promises";
import { rmSync, statSync } from "node:fs";
import type { AudioInfo } from "../types/index.js";

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
    // Refuse to register a file that does not exist on disk: inserting a size-0 ghost
    // entry would make has() report true and get() hand out a path the player can't read.
    if (stat === null) return;
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
      if (victim === null) break; // Can't evict anymore, will exceed limit but can't help it
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
