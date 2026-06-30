import type { AutoplaySource, QueueItem, TrackMeta } from "../types/index.js";
import { AUTOPLAY_REQUESTER } from "../types/index.js";
import type { YouTubeService } from "../youtube/index.js";
import type { StationController } from "../orchestrator/index.js";

export interface RadioDeps {
  youtube: Pick<YouTubeService, "related" | "artistTracks">;
  station: Pick<StationController, "seed" | "queue" | "enqueue">;
  settings: () => { autoplay: boolean; autoplaySource: AutoplaySource };
  recentWindow?: number;
}

/**
 * The always-playing station engine. When the explicit queue is draining, it fetches
 * related/artist tracks for the current seed, filters out anything recently seen (current +
 * upcoming + history + everything radio already picked) and live streams, and appends the
 * next one via station.enqueue(AUTOPLAY_REQUESTER). No hard chain cap — the station never
 * runs out (spec §4); the de-dup is a BOUNDED recent-history Set, not a permanent ban.
 */
export class RadioEngine {
  private readonly recent = new Set<string>();
  private readonly recentOrder: string[] = [];
  private readonly recentWindow: number;

  constructor(private readonly deps: RadioDeps) {
    this.recentWindow = deps.recentWindow ?? 50;
  }

  reset(): void {
    this.recent.clear();
    this.recentOrder.length = 0;
  }

  private remember(videoId: string): void {
    if (this.recent.has(videoId)) return;
    this.recent.add(videoId);
    this.recentOrder.push(videoId);
    while (this.recentOrder.length > this.recentWindow) {
      const evicted = this.recentOrder.shift();
      if (evicted !== undefined) this.recent.delete(evicted);
    }
  }

  // Seed the de-dup window from the live queue so we never re-pick something already queued/played.
  private seenIds(): Set<string> {
    const seen = new Set<string>(this.recent);
    const snap = this.deps.station.queue.snapshot();
    const collect = (i: QueueItem | null) => {
      if (i?.meta?.videoId) seen.add(i.meta.videoId);
    };
    collect(snap.current);
    snap.upcoming.forEach(collect);
    snap.history.forEach(collect);
    return seen;
  }

  async nextCandidate(): Promise<TrackMeta | null> {
    const { autoplay, autoplaySource } = this.deps.settings();
    if (!autoplay) return null;
    const seed = this.deps.station.seed;
    if (seed === null) return null;

    let candidates: TrackMeta[];
    try {
      const result =
        autoplaySource === "artist"
          ? await this.deps.youtube.artistTracks(seed)
          : await this.deps.youtube.related(seed.videoId);
      // A dep that resolves to a non-array (null/undefined/contract violation) idles too, rather
      // than throwing out of nextCandidate (best-effort: a source error idles, never throws).
      if (!Array.isArray(result)) return null;
      candidates = result;
    } catch {
      return null; // best-effort: a source error idles, never throws
    }
    const seen = this.seenIds();
    const next = candidates.find((c) => c.videoId && !c.isLive && !seen.has(c.videoId));
    if (!next) return null;
    this.remember(next.videoId);
    return next;
  }

  async ensureAhead(lowWater = 1): Promise<void> {
    // Append radio tracks until the explicit upcoming list reaches lowWater (or we run dry).
    // Bounded by lowWater so a no-candidate result terminates the loop.
    for (let guard = 0; guard < lowWater + 1; guard++) {
      const upcoming = this.deps.station.queue.snapshot().upcoming.length;
      if (upcoming >= lowWater) return;
      const next = await this.nextCandidate();
      if (!next) return;
      await this.deps.station.enqueue(next, AUTOPLAY_REQUESTER);
    }
  }
}
