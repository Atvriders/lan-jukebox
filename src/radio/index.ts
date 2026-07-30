import type { AutoplaySource, QueueItem, TrackMeta } from "../types/index.js";
import { AUTOPLAY_REQUESTER } from "../types/index.js";
import type { YouTubeService } from "../youtube/index.js";
import type { StationController } from "../orchestrator/index.js";
import { Mutex } from "../util/mutex.js";

export interface RadioDeps {
  youtube: Pick<YouTubeService, "related" | "artistTracks">;
  station: Pick<StationController, "seed" | "queue" | "enqueue" | "setUpcomingRadio">;
  settings: () => { autoplay: boolean; autoplaySource: AutoplaySource };
  /** Radio autoplay skips candidates longer than this many seconds; 0 = no cap. User-requested
   * tracks bypass this — the cap lives only here in the radio engine, never on explicit adds. */
  maxAutoplayDurationSec: number;
  recentWindow?: number;
}

/** TIER 2 fan-out cap: at most this many DISTINCT recently-played tracks are tried as alternate
 * seeds when the primary seed's pool is dry. Bounded (one yt-dlp fetch each) so an exhausted pool
 * can never walk the whole 100-item history ring. */
const MAX_ALT_SEEDS = 4;

/** Internal time budget for ONE nextCandidate(). Checked BETWEEN fetches (never mid-fetch), so the
 * whole call is bounded at ~budget + one already-started fetch: a metadata fetch is itself capped by
 * YTDLP_TIMEOUT_MS (60s) × the 5-rung client ladder = 5 min worst case, giving a ~7 min ceiling for
 * nextCandidate(). That ceiling is what lets the station's RADIO_WATCHDOG_MS (20 min — it covers
 * TWO productions, since a caller can queue behind one on the mutex below) sit safely ABOVE the
 * real worst case instead of false-tripping on legitimately slow-but-working lookups.
 * Exhausting the budget is NOT an error — it just stops TIER 2's walk-back early and falls through
 * to TIER 3, which needs no network at all, so the station still gets a track. */
const RADIO_BUDGET_MS = 120_000;

/**
 * The always-playing station engine. When the explicit queue is draining, it fetches
 * related/artist tracks for the current seed, filters out anything recently seen (current +
 * upcoming + history + everything radio already picked) and live streams, and appends the
 * next one via station.enqueue(AUTOPLAY_REQUESTER). No hard chain cap — the station never
 * runs out (spec §4); the de-dup is a BOUNDED recent-history Set, not a permanent ban.
 *
 * Picking is GRADUATED so the station can never go silent (see nextCandidateLocked): TIER 1 the
 * user's seed, TIER 2 up to MAX_ALT_SEEDS recently-played tracks as alternate seeds, TIER 3 a
 * least-recently-played repeat. "Never stops" beats "never repeats".
 */
export class RadioEngine {
  private readonly recent = new Set<string>();
  private readonly recentOrder: string[] = [];
  private readonly recentWindow: number;
  // QUEUEING production lock. radioTopUp fires ensureAhead on EVERY queue 'changed'
  // (fire-and-forget) and radioContinuation adds a second concurrent entry point. Overlapping runs
  // each snapshot the SAME de-dup `seen` set BEFORE their awaited network fetch and BEFORE
  // remember(), so they would all pick the same first-eligible track and enqueue DUPLICATES (real
  // YouTube RD-Mix returns a stable set, so the same few ids recur — hence Scientist ×4, Yellow ×6).
  // Serializing fixes that: every pick observes the previous pick's remember(), so picks stay
  // distinct.
  // WHY IT QUEUES AND IS NOT A TRY-LOCK: the STATION's radioContinuation() is the CRITICAL path that
  // decides whether music continues, and the optional background top-up routinely owns the slot at
  // the exact moment a track ends (the same 'changed' burst that drains the queue also fires the
  // top-up). A try-lock would answer the station with null on essentially every track end — a paused
  // dry-hold per track, far worse than a short wait. So the STATION WAITS and the TOP-UP is the one
  // that backs off (see ensureAhead). That back-off also bounds the wait: at most one top-up
  // production can ever sit ahead of the station, and the station never calls twice concurrently (it
  // holds the station lock), so the station queues behind ONE production at most.
  // NO LOCK INVERSION: nothing under this mutex takes the STATION lock — a production only reads
  // seed/settings/queue.snapshot(), and the top-up's station.enqueue() runs after the pick, outside
  // it — so a station-lock holder waiting here is always waiting on work that can finish.
  private readonly mutex = new Mutex();
  // Count of nextCandidate() calls queued or running on `mutex`. Bumped SYNCHRONOUSLY at call time
  // (so it covers waiters, not just the current holder) and dropped in a finally. Read ONLY by
  // ensureAhead: the optional top-up skips its work while any production is pending, so it never
  // stacks extra productions in front of the station.
  private pendingProductions = 0;
  // Re-entrancy guard for ensureAhead: our own enqueue fires 'changed' → radioTopUp → ensureAhead,
  // so a burst of changes would otherwise pile up overlapping top-ups. One top-up at a time.
  private topUpInFlight = false;

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

  /**
   * Produce the next radio track. Serialized through the queueing `mutex` so concurrent callers
   * (radioTopUp on every 'changed' AND radioContinuation on a drain) never both pick the same
   * first-eligible track before either remember()s it — the duplicate-queue bug. Each serialized
   * call sees the previous call's remember() in `seen`, so it moves on to the next distinct track.
   * Never throws. The STATION (radioContinuation → nextCandidate) may WAIT here and is always served
   * a real pick; only the optional top-up ever backs off, so radio can never be denied on the path
   * that keeps music playing.
   * WAITING IS BOUNDED, NOT CANCELLABLE: the orchestrator's RADIO_WATCHDOG_MS abandons the CALLER
   * but cannot release a callee's lock, so what stops a stalled run from handing its stall to
   * everyone behind it is that the work inside is TIME-BOUNDED — RADIO_BUDGET_MS plus at most one
   * already-started fetch (~7 min, see nextCandidateLocked) — so a queued caller waits at most two
   * of those, comfortably under the 20 min watchdog, which is sized for exactly that pair.
   * That bound, not a try-lock, is the protection. The counter is dropped in a `finally` (and Mutex
   * keeps its own chain alive across rejections), so a rejected or abandoned run can never leave
   * radio permanently disabled.
   */
  async nextCandidate(): Promise<TrackMeta | null> {
    this.pendingProductions++;
    try {
      return await this.mutex.runExclusive(() => this.nextCandidateLocked());
    } finally {
      this.pendingProductions--;
    }
  }

  private async nextCandidateLocked(): Promise<TrackMeta | null> {
    const { autoplay, autoplaySource } = this.deps.settings();
    if (!autoplay) return null;
    const seed = this.deps.station.seed;
    if (seed === null) return null;

    const seen = this.seenIds();
    // Start of the RADIO_BUDGET_MS window used by the TIER 2 walk-back below. The engine takes no
    // injected clock (unlike Queue/StationController), and this reading is only ever an elapsed
    // "have we spent too long" check — never persisted, exposed or compared across processes — so
    // reading Date.now() directly here is fine.
    const startedAt = Date.now();

    // TIER 1 — PRIMARY source: the user's explicit seed. Mine related/artist tracks off it. Always
    // runs (no budget check here): one fetch is the minimum work a production must be allowed to do.
    const primary = await this.fetchCandidates(seed, autoplaySource);
    const next = primary?.find((c) => this.eligible(c, seen));
    if (next) {
      this.remember(next.videoId);
      return next;
    }

    const snap = this.deps.station.queue.snapshot();

    // TIER 2 — RE-SEED FALLBACK (never-stops invariant): the primary seed's related pool is
    // exhausted — every candidate is already seen/live/too-long. Without a fallback, nextCandidate
    // returns null forever and the station dry-holds PERMANENTLY. Walk BACK through history and try
    // up to MAX_ALT_SEEDS DISTINCT recently-played tracks as alternate related-sources; the first
    // eligible hit wins. One recent track is NOT enough on a mined-out station — its Mix overlaps
    // the same already-played tracks — hence several, but BOUNDED so this can never loop the whole
    // ring, and every fetch stays best-effort (a failing alternate is skipped, never thrown).
    // Skipped entirely when the primary fetch itself FAILED (primary === null): YouTube is down, so
    // more fetches would just burn the same timeout again — fall through to TIER 3, which needs no
    // network at all. Each ADDITIONAL fetch is also gated on RADIO_BUDGET_MS: MAX_ALT_SEEDS slow
    // rung-laddered fetches would otherwise stack minutes onto one call, and this call is awaited
    // under the station lock. Stopping early is harmless — TIER 3 below still yields a track.
    if (primary !== null) {
      const tried = new Set<string>([seed.videoId]);
      let alts = 0;
      for (let i = snap.history.length - 1; i >= 0 && alts < MAX_ALT_SEEDS; i--) {
        const alt = snap.history[i]?.meta;
        if (!alt?.videoId || tried.has(alt.videoId)) continue;
        if (Date.now() - startedAt >= RADIO_BUDGET_MS) break; // spent → fall through to TIER 3
        tried.add(alt.videoId);
        alts++;
        const fallback = await this.fetchCandidates(alt, autoplaySource);
        const altNext = fallback?.find((c) => this.eligible(c, seen));
        if (altNext) {
          this.remember(altNext.videoId);
          return altNext;
        }
      }
    }

    // TIER 3 — NEVER-DRY GUARANTEE. Every source is exhausted: the whole Mix already sits in the
    // bounded history ring (the live freeze: 100/100 history slots, 21 of them the same artist, so
    // EVERY candidate was `seen` → null → permanent dry-hold, station silent for 45h). For an
    // ALWAYS-ON station "never stops" beats "never repeats", so RELAX the de-dup instead of going
    // silent: replay the LEAST-RECENTLY-PLAYED track, ranking each played videoId by its LAST
    // position in the ring (a track played 21 times ranks by its most recent play, not its first).
    // Still excluded: the CURRENT track, live streams and anything over the duration cap —
    // eligible() enforces all three once it is handed the current-only set instead of `seen`.
    // `recent` is deliberately IGNORED here; relaxing it IS the point. Needs no fetch, so this also
    // keeps the station playing while YouTube itself is unreachable.
    // ORDERING: fresh discovery (tiers 1-2) always wins and a repeat is strictly the last resort —
    // it engages only when NOTHING is queued ahead, so a transient fetch failure can never inject
    // repeats while there is still music to play. Re-snapshot first: TIER 2's fetches are
    // network-slow, so a user add may have landed since `snap`.
    // Returning null is now reserved for the genuine nothing-at-all cases: cold start, autoplay off,
    // no seed, or no usable candidate from YouTube AND nothing ever played.
    const dry = this.deps.station.queue.snapshot();
    if (dry.upcoming.length > 0) return null;
    const playing = new Set<string>();
    if (dry.current?.meta?.videoId) playing.add(dry.current.meta.videoId);
    const lastPlay = new Map<string, { meta: TrackMeta; at: number }>();
    dry.history.forEach((i, at) => {
      if (i.meta?.videoId) lastPlay.set(i.meta.videoId, { meta: i.meta, at });
    });
    const oldest = [...lastPlay.values()]
      .sort((a, b) => a.at - b.at)
      .find((e) => this.eligible(e.meta, playing));
    if (!oldest) return null;
    this.remember(oldest.meta.videoId);
    return oldest.meta;
  }

  async ensureAhead(lowWater = 1): Promise<void> {
    // Re-entrancy guard: radioTopUp fires this on every queue 'changed' — INCLUDING our own
    // enqueue's change and publishPreview's change — so without it a burst of changes spawns many
    // overlapping top-ups that each drive the loop and overshoot lowWater / re-enter. One
    // top-up at a time is sufficient; the next real drain fires 'changed' and tops up again.
    if (this.topUpInFlight) return;
    // …and YIELD TO THE STATION. Production queues now, so the OPTIONAL path must be the one that
    // backs off: if a production is already queued or running — most likely the station's own
    // radioContinuation, which fires at exactly the moment a track ends — skip this top-up outright
    // instead of stacking another production in front of it. Nothing is lost: the next 'changed'
    // fires radioTopUp → ensureAhead again. WHICH PATH IS WHICH: the STATION
    // (radioContinuation → nextCandidate) always WAITS and always gets its pick; the TOP-UP
    // (radioTopUp → ensureAhead) is the one that gives way, here and again inside the loop.
    if (this.pendingProductions > 0) return;
    this.topUpInFlight = true;
    try {
      // Append radio tracks until the explicit upcoming list reaches lowWater (or we run dry).
      // Bounded by lowWater so a no-candidate result terminates the loop.
      // NO self-deadlock against the production mutex: this loop calls the PUBLIC nextCandidate (so
      // it still can't race radioContinuation into a duplicate pick) and holds the lock across no
      // await of its own — each iteration acquires and releases it in turn, so our own next
      // iteration never waits on our own previous one.
      let enqueued = false;
      for (let guard = 0; guard < lowWater + 1; guard++) {
        const upcoming = this.deps.station.queue.snapshot().upcoming.length;
        if (upcoming >= lowWater) break;
        // Re-check before every ADDITIONAL pick: the station may have started a production during
        // the previous iteration's enqueue await, and it must never end up waiting behind one more
        // optional top-up pick. Stopping early is harmless; 'changed' brings us back.
        if (this.pendingProductions > 0) break;
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
    } finally {
      this.topUpInFlight = false;
    }
  }

  /** Mirror the current radio-tagged upcoming items into the station's upcoming-radio preview. */
  private publishPreview(): void {
    const radioUpcoming = this.deps.station.queue
      .snapshot()
      .upcoming.filter((i) => i.fromRadio === true);
    this.deps.station.setUpcomingRadio(radioUpcoming);
  }
}
