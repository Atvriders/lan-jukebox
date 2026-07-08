import type { AutoplaySource, QueueItem, TrackMeta } from "../types/index.js";
import { AUTOPLAY_REQUESTER } from "../types/index.js";
import type { YouTubeService } from "../youtube/index.js";
import type { StationController } from "../orchestrator/index.js";

export interface RadioDeps {
  youtube: Pick<YouTubeService, "related" | "artistTracks">;
  station: Pick<StationController, "seed" | "queue" | "enqueue" | "setUpcomingRadio">;
  settings: () => { autoplay: boolean; autoplaySource: AutoplaySource };
  /** Radio autoplay skips candidates longer than this many seconds; 0 = no cap. User-requested
   * tracks bypass this — the cap lives only here in the radio engine, never on explicit adds. */
  maxAutoplayDurationSec: number;
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

  /**
   * True when a radio candidate is usable: real videoId, not a live stream, not recently seen, and
   * (when a cap is configured) not longer than the autoplay duration cap. A candidate with unknown
   * duration (durationSec == null) is NOT rejected by the cap — we can't tell. User-requested tracks
   * bypass this cap entirely; it lives only here in the radio engine.
   */
  private eligible(c: TrackMeta, seen: Set<string>): boolean {
    if (!c.videoId || c.isLive || seen.has(c.videoId)) return false;
    const cap = this.deps.maxAutoplayDurationSec;
    if (cap > 0 && c.durationSec != null && c.durationSec > cap) return false;
    return true;
  }

  /**
   * Best-effort fetch of related/artist tracks off one source track. Resolves to an array (possibly
   * empty) or null on any error / contract violation — NEVER throws (nextCandidate must not throw).
   * A dep that resolves to a non-array (null/undefined/contract violation) idles too.
   */
  private async fetchCandidates(
    source: TrackMeta,
    autoplaySource: AutoplaySource,
  ): Promise<TrackMeta[] | null> {
    try {
      const result =
        autoplaySource === "artist"
          ? await this.deps.youtube.artistTracks(source)
          : await this.deps.youtube.related(source.videoId);
      return Array.isArray(result) ? result : null;
    } catch {
      return null; // best-effort: a source error idles, never throws
    }
  }

  async nextCandidate(): Promise<TrackMeta | null> {
    const { autoplay, autoplaySource } = this.deps.settings();
    if (!autoplay) return null;
    const seed = this.deps.station.seed;
    if (seed === null) return null;

    const seen = this.seenIds();

    // PRIMARY source: the user's explicit seed. Mine related/artist tracks off it.
    const primary = await this.fetchCandidates(seed, autoplaySource);
    if (primary === null) return null;
    const next = primary.find((c) => this.eligible(c, seen));
    if (next) {
      this.remember(next.videoId);
      return next;
    }

    // RE-SEED FALLBACK (never-stops invariant): the primary seed's related pool is exhausted — every
    // candidate is already seen/live/too-long. Without this, nextCandidate would return null forever
    // and the station would dry-hold PERMANENTLY. Fall back ONCE to the most-recently-played history
    // track as an alternate related-source so discovery keeps flowing. The user's explicit seed
    // stays PRIMARY; the alternate is only used when the primary is dry (one extra fetch, no loops).
    const history = this.deps.station.queue.snapshot().history;
    const alt = [...history]
      .reverse()
      .find((i) => i.meta?.videoId && i.meta.videoId !== seed.videoId)?.meta;
    if (!alt) return null;
    const fallback = await this.fetchCandidates(alt, autoplaySource);
    if (fallback === null) return null;
    const altNext = fallback.find((c) => this.eligible(c, seen));
    if (!altNext) return null;
    this.remember(altNext.videoId);
    return altNext;
  }

  async ensureAhead(lowWater = 1): Promise<void> {
    // Append radio tracks until the explicit upcoming list reaches lowWater (or we run dry).
    // Bounded by lowWater so a no-candidate result terminates the loop.
    let enqueued = false;
    for (let guard = 0; guard < lowWater + 1; guard++) {
      const upcoming = this.deps.station.queue.snapshot().upcoming.length;
      if (upcoming >= lowWater) break;
      const next = await this.nextCandidate();
      if (!next) break;
      await this.deps.station.enqueue(next, AUTOPLAY_REQUESTER);
      enqueued = true;
    }
    // Publish the radio-tagged upcoming items as the UI "upcoming-radio preview" so the field
    // reflects reality (radio picks are appended into the explicit `upcoming` queue tagged
    // fromRadio, so the preview mirrors those rather than a separate pre-resolved buffer). Without
    // this, setUpcomingRadio had zero runtime callers and the preview was permanently empty.
    // ONLY when we actually enqueued: setUpcomingRadio emits "changed" → radioTopUp → ensureAhead,
    // so publishing unconditionally (even when nothing was added) would recurse forever.
    if (enqueued) this.publishPreview();
  }

  /** Mirror the current radio-tagged upcoming items into the station's upcoming-radio preview. */
  private publishPreview(): void {
    const radioUpcoming = this.deps.station.queue
      .snapshot()
      .upcoming.filter((i) => i.fromRadio === true);
    this.deps.station.setUpcomingRadio(radioUpcoming);
  }
}
