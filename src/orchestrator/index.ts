import { EventEmitter } from "node:events";
import type {
  AudioInfo,
  CurrentItem,
  PreparingState,
  QueueItem,
  Requester,
  StationSettings,
  StationSnapshot,
  StationSnapshotFile,
  TrackMeta,
} from "../types/index.js";
import { AUTOPLAY_REQUESTER, DEFAULT_SETTINGS } from "../types/index.js";
import { Mutex } from "../util/mutex.js";
import { Queue } from "../queue/index.js";
import { applySettingsPatch } from "./settings.js";
import { BrowserPlayerSink } from "./browser-player-sink.js";

export interface StationControllerDeps {
  queue?: Queue;
  settings?: Partial<StationSettings>;
  download: (
    videoId: string,
    opts?: { onProgress?: (pct: number) => void; durationSec?: number | null },
  ) => Promise<{ path: string; audio: AudioInfo | null }>;
  pin?: (videoId: string, path: string, audio: AudioInfo | null) => void;
  unpin?: (videoId: string) => void;
  // Drop a cached track (entry + file). Used to SELF-HEAL a corrupt cached file: a track that the
  // browser refused to play, or that failed to load, would otherwise be re-served from the very
  // same bad bytes on every future attempt. Best-effort and optional — never load-bearing.
  evict?: (videoId: string) => void;
  prefetch?: (videoId: string, durationSec?: number | null) => Promise<void>;
  // Read the real audio format of an already-cached track (prefetch/audio-route registered it).
  // Used by crossfadeAdvance to populate the crossfaded-in track's `.audio` (there is no download
  // in the crossfade path to source it from), so its NowPlaying format badge still renders.
  getAudio?: (videoId: string) => AudioInfo | null;
  now?: () => number;
  onSettingsChanged?: (s: StationSettings) => void;
  // Injectable timer for the dry-hold radio self-retry (defaults to global setTimeout/clearTimeout).
  // Overridable so tests can drive the backoff deterministically without real wall-clock waits.
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (h: ReturnType<typeof setTimeout>) => void;
  /** Base backoff (ms) for the dry-hold radio retry; doubles each attempt up to a cap. */
  radioRetryBaseMs?: number;
}

export class StationController extends EventEmitter {
  readonly queue: Queue;
  private sink: BrowserPlayerSink | null = null;
  private readonly lock = new Mutex();
  private readonly now: () => number;
  private _settings: StationSettings;
  private _seed: TrackMeta | null = null;
  private _paused = false;
  // Set when the queue drained with no radio: we hold paused with the last `current` preserved
  // (spec §3/§4 never-stops). Distinct from a manual pause() so a later enqueue can auto-start.
  private _dryHeld = false;
  // Set by pause() when it interrupts a dry-hold, consumed by resume() so the station restarts
  // instead of sending a `play` that nothing can act on. Cleared whenever a track actually goes
  // live (loadCurrentLocked) so it can never go stale across normal playback.
  private _pausedFromDryHold = false;
  private preparing: PreparingState | null = null;
  // advance-exactly-once guard: each fresh play opens a new generation; the next trackEnd/error
  // is only honored when it matches the live generation (so an error+trackEnd pair can't double-skip).
  private playGeneration = 0;
  private startedAt: number | null = null;
  private pausedAt: number | null = null;
  private pausedAccumMs = 0;
  // The queue-item id currently loaded+playing on the sink (null = nothing live). Lets an
  // enqueue-race double-schedule of startNextLocked short-circuit instead of restarting the
  // just-started head from 0 (redundant reload/pin + a visible restart).
  private liveItemId: string | null = null;
  // The actual QueueItem the sink was last told to load/play (same object the queue holds while
  // it is current, so setCurrentAudio keeps its `.audio` fresh). snapshot() pins now-playing to
  // THIS item, not the raw queue head: queue.advance() moves the head to the next track and
  // broadcasts it the instant a promotion happens, but the sink isn't told to load that next
  // track until its (slow, real yt-dlp) download completes. Reporting the raw head during that
  // window made NowPlaying show/count a track that wasn't playing yet (and, for skip/jump, while
  // the PREVIOUS track was still audible). Retaining liveItem keeps the card on the truly-live
  // track across the next track's download; the separate `preparing` field signals "loading next".
  private liveItem: QueueItem | null = null;
  // The videoId whose cache entry (source + derived `${videoId}.m4a` transcode) is currently
  // pinned. Unpinned when a different track becomes current so pins don't grow without bound
  // and the LRU can honor CACHE_MAX_MB (spec: cache is bounded; the station plays forever).
  private pinnedVideoId: string | null = null;
  // True while loadCurrentLocked is awaiting a download. Lets seek()/pause() (which run OUTSIDE
  // the station lock) detect that a load is in flight and defer their effect to completion.
  private _loading = false;
  // Set by pause() when it runs WHILE a load is in flight: the load then completes PAUSED (prepare
  // the audio but don't auto-play) so a pause issued mid-download survives instead of being lost.
  // Distinct from the dry-hold `_paused` state, which a fresh load intentionally clears + plays.
  private _pausedDuringLoad = false;
  // A seek issued while a load is in flight (download still awaiting) — applied when the load
  // completes so the concurrent seek's position isn't clobbered by the original startMs.
  private pendingSeekMs: number | null = null;
  // radio hooks (wired by RadioEngine in 1.6; null = no radio, hold-paused on drain).
  private radioContinuation: (() => Promise<TrackMeta | null>) | null = null;
  private radioTopUp: (() => void) | null = null;
  private upcomingRadio: QueueItem[] = [];
  // Dry-hold radio self-retry: when the queue drains and radioContinuation() returns null
  // because of a TRANSIENT upstream failure (related()/artistTracks() swallow all errors to []),
  // the station would otherwise stay parked in dry-hold forever until a human intervenes —
  // violating "when the queue drains it autoplays related tracks forever". Schedule a bounded,
  // backing-off re-attempt so a blip (bgutil POT briefly down, momentary rate-limit) self-heals.
  private radioRetryHandle: ReturnType<typeof setTimeout> | null = null;
  private radioRetryAttempt = 0;
  // Consecutive download-failure counter. A YouTube-side outage (metadata resolves but every
  // download fails: expired URL, PoTokenSabr, disk full) would otherwise walk the whole candidate
  // list firing a rapid BURST of failed yt-dlp spawns + related() fetches with zero backoff. A
  // short, capped inter-attempt delay degrades that into a slow retry instead of a thundering herd.
  private downloadFailStreak = 0;
  private static readonly DOWNLOAD_FAIL_BACKOFF_CAP_MS = 30_000;
  private static readonly DOWNLOAD_FAIL_BACKOFF_BASE_MS = 1_000;
  // Ceiling on the failure-driven walk taken INSIDE a single lock task. loadCurrentLocked ⇄
  // playNextLocked is mutual recursion: every individual await in it is bounded, but a long run of
  // failing tracks chains them, so the TOTAL time the station lock is held is not. Past this many
  // consecutive failure-driven advances we stop walking and dry-hold instead; the armed backoff
  // retry resumes the search in a FRESH lock task, so the lock is released between attempts and
  // skip/resume/enqueue stay responsive. The normal path walks exactly ONE advance, so 10 is far
  // above anything healthy while still bounding the hold to a handful of failures.
  private static readonly MAX_FAIL_WALK = 10;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (h: ReturnType<typeof setTimeout>) => void;
  private readonly radioRetryBaseMs: number;
  private static readonly RADIO_RETRY_CAP_MS = 60_000;
  // Never-hang backstops (see withWatchdog). The station mutex serializes EVERY playback op, so a
  // single injected dependency that never settles inside a lock task holds that lock forever: the
  // station freezes mid-track with no crash, no restart and no recovery, and every later
  // resume/skip/enqueue queues behind it.
  //
  // Both ceilings are LAST-RESORT backstops against an unknown-unknown hang — NOT policy timers.
  // runYtDlp is now guaranteed to settle (it settles on 'exit' as well as 'close' and kills the
  // whole process group), and both dependencies below bound their own work, so neither watchdog
  // fires in normal operation. They are therefore sized strictly ABOVE the true worst case of
  // the work they guard: a FALSE trip is worse than a slow legitimate operation, because it skips
  // a legitimate track (download) or drops a legitimate radio pick (radio) — and, worse, a trip
  // ABANDONS a call that still holds the callee's own mutex, so a ceiling set BELOW the real worst
  // case makes every following call queue behind the abandoned one and hold the STATION lock for
  // the full ceiling: it would re-create the very freeze these exist to prevent, on a fixed cycle.
  //
  // Download worst case = QUEUEING + WORK, not work alone. `deps.download` is the coalesced
  // downloader wired in src/index.ts: it consults the cache, then runs the real fetch inside a
  // SHARED Semaphore(MAX_TRANSCODE_JOBS, default 2) that also gates prefetch, the /audio route's
  // downloads and its ffmpeg transcodes — so this await includes the wait for a permit.
  //   • work: youtube.download bounds its WHOLE client-fallback ladder with one TOTAL deadline of
  //     DOWNLOAD_LADDER_ATTEMPTS (2) × the auto-scaled per-attempt timeout = 2 ×
  //     DOWNLOAD_TIMEOUT_CAP_MS (30 min, see scaleDownloadTimeout) = 60 min at the cap.
  //   • queueing: BOUNDED — but only because every permit holder is itself now time-bounded (a
  //     download by that same 60-min ladder budget, a transcode by TRANSCODE_TIMEOUT_MS = 10 min).
  //     It is not zero and not fixed: it is (work queued ahead of us) / 2 permits, so it grows with
  //     how many prefetches + /audio requests are in flight.
  // 120 min = the 60-min ladder plus 60 min of permit-queue headroom (one other full-length ladder
  // on each permit, or a dozen queued 10-min transcodes). Under EXTREME contention a trip is still
  // possible — this is a backstop, not a proof — and that degrades into the normal "this track
  // failed, move on" path in loadCurrentLocked's catch (trackError banner → discard → backoff →
  // next candidate): the station loses ONE track and keeps playing, which is acceptable for an
  // always-on radio; a freeze is not. (An operator who raises YTDLP_TIMEOUT_MS above the 30-min cap,
  // or drops MAX_TRANSCODE_JOBS to 1, lengthens both terms and must raise this constant with them.)
  private static readonly DOWNLOAD_WATCHDOG_MS = 120 * 60_000;
  // Radio worst case is QUEUEING + WORK too, for the same reason the download ceiling is:
  // nextCandidate() now QUEUES on RadioEngine's own mutex, so the station's call can wait behind at
  // most ONE in-flight top-up production before its own runs. The ceiling must therefore cover 2 ×
  // the per-production worst case, not 1 ×.
  //   • one production: RadioEngine bounds nextCandidate() with an INTERNAL ~120s time budget
  //     (RADIO_BUDGET_MS) that it checks BETWEEN fetches, plus at most one already-started fetch —
  //     and a single metadata lookup is itself the client-fallback ladder, 5 rungs × the 60s yt-dlp
  //     metadata timeout = 5 min (Timeout is retryable across clients). 120s + 5 min ≈ 7 min.
  //   • queueing: at most one such production ahead of us on that mutex — the same ~7 min.
  // 2 × (120s + 5 min) ≈ 14 min worst case; 20 min gives real headroom, so this can never
  // false-trip (a healthy related() lookup is seconds). Same honest framing as the download
  // ceiling: a LAST-RESORT backstop, not a policy timer — and a trip must not be cheap, because
  // abandoning a call that still owns RadioEngine's mutex makes the NEXT caller queue behind it.
  // A genuine trip is treated exactly like "radio returned nothing": no radio this round →
  // dry-hold → armed backing-off retry (see radioContinuationWatched) — never a throw out of the
  // lock task.
  private static readonly RADIO_WATCHDOG_MS = 20 * 60_000;

  constructor(private readonly deps: StationControllerDeps) {
    super();
    this.now = deps.now ?? (() => Date.now());
    this.setTimeoutFn = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = deps.clearTimeout ?? ((h) => clearTimeout(h));
    this.radioRetryBaseMs = deps.radioRetryBaseMs ?? 5_000;
    this.queue = deps.queue ?? new Queue();
    this._settings = applySettingsPatch({ ...DEFAULT_SETTINGS }, deps.settings ?? {});
    this.queue.on("prefetch", (videoId: string | null) => {
      if (videoId && this.deps.prefetch) {
        // The queue emits the upcoming-head videoId; look up its duration from the same
        // head item so the prefetch download's yt-dlp timeout can auto-scale for long
        // tracks (mirrors loadCurrentLocked threading item.meta.durationSec).
        const head = this.queue.snapshot().upcoming[0];
        const durationSec =
          head && head.meta.videoId === videoId ? head.meta.durationSec : undefined;
        void this.deps.prefetch(videoId, durationSec);
      }
    });
    this.queue.on("changed", () => {
      this.emit("changed");
      this.radioTopUp?.();
    });
  }

  get isPaused(): boolean {
    return this._paused;
  }
  get settings(): StationSettings {
    return { ...this._settings };
  }
  get seed(): TrackMeta | null {
    return this._seed;
  }
  get activeSink(): boolean {
    return this.sink !== null;
  }

  setRadioContinuation(fn: (() => Promise<TrackMeta | null>) | null): void {
    this.radioContinuation = fn;
  }
  setRadioTopUp(fn: (() => void) | null): void {
    this.radioTopUp = fn;
  }
  /** RadioEngine writes its pre-resolved buffer here for the UI "upcoming-radio preview". */
  setUpcomingRadio(items: QueueItem[]): void {
    this.upcomingRadio = items;
    this.emit("changed");
  }

  async enqueue(meta: TrackMeta, requester: Requester): Promise<QueueItem> {
    if (requester.source === "user") this._seed = meta;
    const item = await this.queue.add(meta, requester, requester.source === "autoplay");
    // Auto-start when a sink is attached and the station is idle: either nothing is loaded
    // (cold start) or it is holding paused on a dry queue (spec §3/§4 — adding a song must
    // restart the station). A manual pause() does NOT auto-start (that's a deliberate stop).
    if (
      this.sink &&
      (this.queue.current === null || this._dryHeld) &&
      (!this._paused || this._dryHeld)
    ) {
      void this.lock.runExclusive(() => this.startNextLocked());
    }
    return item;
  }

  attachSink(sink: BrowserPlayerSink): void {
    this.sink = sink;
    sink.on("trackEnd", this.onSinkTrackEnd);
    sink.on("error", this.onSinkError);
    this._paused = false;
    void this.lock.runExclusive(() => this.resumeOrStartLocked());
    this.emit("changed");
  }

  detachSink(): void {
    const s = this.sink;
    if (!s) return;
    s.off("trackEnd", this.onSinkTrackEnd);
    s.off("error", this.onSinkError);
    // bump the generation so a late trackEnd from the now-detached sink can't advance us.
    this.playGeneration += 1;
    this.sink = null;
    this._paused = true;
    this.freezePosition();
    this.emit("changed");
  }

  private readonly onSinkTrackEnd = (): void => {
    const gen = this.playGeneration;
    void this.lock.runExclusive(async () => {
      if (gen !== this.playGeneration) return; // stale signal — already advanced
      this.playGeneration += 1; // consume this generation
      await this.advanceAndPlayLocked("archive");
    });
  };
  private readonly onSinkError = (message?: unknown): void => {
    const gen = this.playGeneration;
    const reason = typeof message === "string" && message ? message : "playback error";
    void this.lock.runExclusive(async () => {
      if (gen !== this.playGeneration) return;
      this.playGeneration += 1;
      // Surface the failed track to the UI BEFORE we discard it (the item is still `current`),
      // so the client's "Skipped '<title>' — <reason>" banner can name what was dropped.
      const failed = this.queue.current;
      this.emitTrackError(failed, reason);
      // Self-heal a corrupt cached track: the browser could not play THIS file, so drop its cache
      // entry instead of re-serving the same bad bytes on every future attempt. Best-effort — the
      // discard/advance below happens either way.
      if (failed) this.evictTrack(failed.meta.videoId);
      await this.advanceAndPlayLocked("discard"); // failed track is NOT archived to history
    });
  };

  /**
   * Self-heal a bad cached track: drop its cache entry (and the derived transcode) so the next
   * attempt re-downloads instead of re-serving the same corrupt file forever. Called only when a
   * track is being discarded after a playback error or a failed load — never for a live track.
   * Best-effort by contract, and wrapped so a throwing dep can never escape a catch block or a
   * lock task (both callers are voided background work where that would be an unhandled rejection).
   */
  private evictTrack(videoId: string): void {
    try {
      this.deps.evict?.(videoId);
    } catch {
      /* best-effort: a failed eviction only means the next attempt may hit the same bad file */
    }
  }

  /**
   * Emit a {@link ServerBroadcastMessage} `trackError` payload over the "trackError" event so the
   * composition root can broadcast it to every subscriber. Best-effort: a missing item is a no-op.
   */
  private emitTrackError(item: QueueItem | null, reason: string): void {
    if (!item) return;
    this.emit("trackError", {
      videoId: item.meta.videoId,
      title: item.meta.title,
      reason,
    });
  }

  private async resumeOrStartLocked(): Promise<void> {
    this._dryHeld = false;
    if (this.queue.current) {
      await this.loadCurrentLocked(this.positionMs());
    } else {
      await this.startNextLocked();
    }
  }

  /**
   * Finish the current track (archive on clean end, discard on error) and move on to the next
   * track / radio / dry-hold. The single advance path for trackEnd/error/skip/jump.
   */
  private async advanceAndPlayLocked(disposition: "archive" | "discard"): Promise<void> {
    // Capture the advance generation up front. radioContinuation() below is an awaited network call
    // (seconds); a clear()/detachSink() during it bumps the generation OUTSIDE this.lock, and this
    // whole chain would otherwise keep going and restart playback (radio) after the user cleared.
    // Re-checked after that await. (loadCurrentLocked, reached below, self-guards its own download.)
    const advGen = this.playGeneration;
    // repeat="one": a CLEAN end replays the SAME current from 0 (an error still advances, so a
    // broken track can never wedge the station on itself forever).
    if (disposition === "archive" && this._settings.repeat === "one" && this.queue.current) {
      await this.loadCurrentLocked(0);
      return;
    }
    // Decide where to go BEFORE retiring `current`, so a dry queue keeps the finished track
    // as `current` (spec §3/§4: hold paused with current/position preserved, no teardown).
    const hasUpcoming = this.queue.snapshot().upcoming.length > 0;
    if (!hasUpcoming) {
      const radioMeta = await this.radioContinuationWatched();
      // A clear() ran during radioContinuation() → the station is idle; abandon this advance BEFORE
      // adding a radio track / arming a dry-hold retry / playing (all of which would un-idle it).
      if (advGen !== this.playGeneration) return;
      // Re-read the queue AFTER that awaited (seconds-long) lookup: an enqueue that landed DURING
      // it is already sitting in `upcoming`, and the pre-await `hasUpcoming` is stale. enqueue()
      // does NOT auto-start in that window either (a live `current` is still held and _dryHeld is
      // false), so without this re-check the station would dry-hold with a real track queued.
      const gainedUpcoming = this.queue.snapshot().upcoming.length > 0;
      if (radioMeta) {
        // Keep the pick even when a track arrived meanwhile: radio adds APPEND, and a user add
        // sorts ahead of trailing radio filler, so the newly-enqueued track still plays first.
        await this.queue.add(radioMeta, AUTOPLAY_REQUESTER, true);
      } else if (gainedUpcoming) {
        // Radio had nothing, but the queue is no longer dry — fall through to the normal promote
        // path below (never requeueHistory/dry-hold: there is a genuine next track waiting).
      } else if (this._settings.repeat === "all" && (await this.queue.requeueHistory()) > 0) {
        // repeat="all": explicit queue dry AND radio yielded nothing → re-cycle the FULL played
        // set (incl. the just-finished current) back into `upcoming`. requeueHistory clears
        // `current`, so the promotion below plays the recycled head instead of dry-holding.
      } else {
        // queue dry, no radio, nothing to recycle: hold paused. On a CLEAN end keep the finished
        // track as `current` (spec §3/§4: current/position preserved, no teardown). On an ERROR
        // discard the failed track (it must not stay displayed as now-playing).
        if (disposition === "discard") await this.queue.discardCurrent();
        this.enterDryHoldLocked();
        return;
      }
    }
    // requeueHistory() already retired `current` (set it to null); only archive/discard when a
    // live current still needs retiring. playNextLocked then promotes the head.
    if (this.queue.current) {
      if (disposition === "archive") await this.queue.advance();
      else await this.queue.discardCurrent();
    }
    await this.playNextLocked();
  }

  /**
   * Hold paused on a dry queue. Bumps the generation so any later stale/duplicate trackEnd/error
   * (whose handler captured the now-consumed generation) cannot match and double-advance us out
   * of the held-paused state. Position is frozen so it survives in the snapshot.
   */
  private enterDryHoldLocked(): void {
    this.playGeneration += 1; // re-arm: a stale signal can never match the consumed generation
    this._paused = true;
    this._dryHeld = true;
    this.freezePosition();
    this.emit("changed");
    // If radio COULD have produced a track (autoplay on, a seed exists, a continuation is wired)
    // but returned null, the drain was a TRANSIENT upstream failure (related() swallows all
    // errors to []) — not a genuine cold start. Schedule a backing-off retry so the always-on
    // station resumes autoplay on its own instead of parking forever (spec: drains autoplay
    // related tracks forever). A true cold start (no seed) schedules nothing.
    if (this._settings.autoplay && this._seed !== null && this.radioContinuation !== null) {
      this.scheduleRadioRetryLocked();
    }
  }

  /**
   * Dry-hold at the end of a CUT-SHORT failure walk (MAX_FAIL_WALK, see loadCurrentLocked), with a
   * retry GUARANTEED to be armed. enterDryHoldLocked only schedules its retry when radio could have
   * produced a track (autoplay + a seed + a wired continuation); here the walk was abandoned with
   * real candidates possibly still sitting in `upcoming`, and the retry is the ONLY thing that will
   * resume the search — so arm it unconditionally rather than leaving the station stopped. The
   * retry runs startNextLocked in a fresh lock task, which picks the search back up where we left.
   */
  private enterDryHoldAndRetryLocked(): void {
    this.enterDryHoldLocked();
    if (this.radioRetryHandle === null) this.scheduleRadioRetryLocked();
  }

  /**
   * Arm the next backing-off dry-hold radio retry (idempotent — replaces any pending timer).
   * The always-on station must NEVER permanently give up: there is no attempt cap. The exponential
   * delay is clamped at RADIO_RETRY_CAP_MS, so a persistently-failing upstream degrades into a
   * steady ~60s poll that self-heals the instant related() recovers (loadCurrentLocked resets the
   * backoff on the next successful load). The exponent stops growing once the delay is already at
   * the cap, so `2 ** attempt` can never overflow to Infinity on an indefinitely-failing feed.
   */
  private scheduleRadioRetryLocked(): void {
    this.cancelRadioRetry();
    const delay = Math.min(
      StationController.RADIO_RETRY_CAP_MS,
      this.radioRetryBaseMs * 2 ** this.radioRetryAttempt,
    );
    if (delay < StationController.RADIO_RETRY_CAP_MS) this.radioRetryAttempt += 1;
    this.radioRetryHandle = this.setTimeoutFn(() => {
      this.radioRetryHandle = null;
      const gen = this.playGeneration;
      void this.lock.runExclusive(async () => {
        // Only retry if we are STILL dry-held on the same generation and nothing has intervened
        // (a manual enqueue/resume/skip clears _dryHeld and cancels this). Re-attempt radio; if it
        // still yields nothing, enterDryHoldLocked re-arms the next (longer) backoff.
        if (gen !== this.playGeneration || !this._dryHeld || !this.sink) return;
        await this.startNextLocked();
      });
    }, delay);
  }

  /** Cancel any pending dry-hold radio retry and reset the backoff (call when leaving dry-hold). */
  private cancelRadioRetry(): void {
    if (this.radioRetryHandle !== null) {
      this.clearTimeoutFn(this.radioRetryHandle);
      this.radioRetryHandle = null;
    }
  }

  /**
   * Inter-attempt delay for the consecutive-failure streak. The FIRST failure advances immediately
   * (an isolated bad track shouldn't add latency); only a RUN of consecutive failures (a whole-feed
   * outage, or a sink that throws on every track) backs off, doubling up to a cap, so a mass
   * failure degrades into a slow retry instead of a thundering burst of yt-dlp spawns.
   */
  private failBackoffMs(): number {
    return this.downloadFailStreak <= 1
      ? 0
      : Math.min(
          StationController.DOWNLOAD_FAIL_BACKOFF_CAP_MS,
          StationController.DOWNLOAD_FAIL_BACKOFF_BASE_MS * 2 ** (this.downloadFailStreak - 2),
        );
  }

  /** Await `ms` via the injectable timer (0 resolves immediately so tests need no fake clock). */
  private delay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.setTimeoutFn(() => resolve(), ms);
    });
  }

  /**
   * Race `p` against the injectable timer and reject if it has not settled within `ms`.
   *
   * The never-stops invariant: EVERY await reachable inside a lock task must be bounded. A
   * dependency that never settles (a yt-dlp child whose 'close' never fires because a grandchild
   * still holds its stdio, a wedged upstream mutex) otherwise holds the station lock forever and
   * the station is dead until the process restarts. Ceilings are last-resort backstops, not policy
   * timeouts — see DOWNLOAD_WATCHDOG_MS / RADIO_WATCHDOG_MS.
   *
   * The timer is always cleared on the settle path (nothing leaks; tests drive setTimeout/
   * clearTimeout through the injected deps), and `p`'s own settlement is ALWAYS handled, so a late
   * rejection arriving after a trip can never surface as an unhandled rejection. The timer is armed
   * only if `p` is still pending on the next microtask, so an already-settled dependency (the
   * common cached/fast path) costs no timer at all.
   */
  private withWatchdog<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let handle: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const disarm = (): void => {
        settled = true;
        if (handle !== null) {
          this.clearTimeoutFn(handle);
          handle = null;
        }
      };
      void p.then(
        (value) => {
          disarm();
          resolve(value);
        },
        (err: unknown) => {
          disarm();
          reject(err); // pass the original failure through untouched (callers read err.message)
        },
      );
      queueMicrotask(() => {
        if (settled) return;
        handle = this.setTimeoutFn(() => {
          handle = null;
          reject(new Error(`station watchdog: ${what} did not settle within ${ms}ms`));
        }, ms);
      });
    });
  }

  /**
   * `radioContinuation()` under the never-hang watchdog, degraded to `null` on ANY failure.
   * Radio is best-effort by contract (related()/artistTracks() already swallow their own errors to
   * []), so a watchdog trip — or a continuation that rejects outright — is treated exactly like
   * "radio had nothing this round": the caller falls through to the dry-hold + backing-off
   * self-retry. It must NEVER throw out of a lock task: on the voided lock promise that would be an
   * unhandled rejection AND would skip the dry-hold (leaving the station stopped with no retry).
   */
  private async radioContinuationWatched(): Promise<TrackMeta | null> {
    if (!this.radioContinuation) return null;
    try {
      return await this.withWatchdog(
        this.radioContinuation(),
        StationController.RADIO_WATCHDOG_MS,
        "radio continuation",
      );
    } catch {
      return null; // hung or failed lookup → "no radio this round", never a throw
    }
  }

  /**
   * Promote the next track (head → radio → dry-hold) WITHOUT first retiring a held `current`.
   * Used by attach/enqueue auto-start: when dry-held the finished track is still `current`, so
   * we archive it here only once there is genuinely something to advance into.
   */
  private async startNextLocked(): Promise<void> {
    if (this._dryHeld) {
      // A held current is normally the already-finished track: retire it before promoting the new
      // one. Only when it genuinely went LIVE, though — a dry-hold that ended a cut-short failure
      // walk (MAX_FAIL_WALK) holds a candidate that was promoted by discardCurrent and never
      // played, and archiving that would silently drop a real track from the queue. When there is
      // no current at all, playNextLocked's own advance does the promotion.
      if (this.queue.current && this.liveItemId === this.queue.current.id) {
        await this.queue.advance();
      }
      this._dryHeld = false;
    }
    await this.playNextLocked();
  }

  // Core never-stopping advance: promote head → if none, ask radio → if none, hold paused.
  // `failWalk` is how many consecutive FAILURE-driven advances this same lock task has already
  // taken (see loadCurrentLocked); every normal caller starts a fresh walk at 0.
  private async playNextLocked(failWalk = 0): Promise<void> {
    // Advance generation for the radioContinuation() await below (see advanceAndPlayLocked): a
    // clear() during that network call must abandon this advance rather than restart radio.
    const pnGen = this.playGeneration;
    // Spurious auto-start guard (enqueue-race): if `current` is already the live, actively-playing
    // track (not paused, not dry-held), a second scheduled startNextLocked would re-load+restart it
    // from 0. Two near-simultaneous cold-start enqueues both observe current===null and both
    // schedule this; the first plays the head, so the second must be a no-op here.
    if (
      this.queue.current &&
      this.liveItemId === this.queue.current.id &&
      !this._paused &&
      !this._dryHeld
    ) {
      return;
    }
    if (!this.queue.current) {
      const item = await this.queue.advance();
      if (!item) {
        const radioMeta = await this.radioContinuationWatched();
        // A clear() ran during radioContinuation() → abandon before adding radio / arming a
        // dry-hold retry, so the station stays idle instead of restarting.
        if (pnGen !== this.playGeneration) return;
        if (radioMeta) await this.queue.add(radioMeta, AUTOPLAY_REQUESTER, true);
        // Re-read the queue AFTER that awaited (seconds-long) lookup (same stale-`upcoming` bug
        // advanceAndPlayLocked guards): an enqueue that landed DURING it is already sitting in
        // `upcoming`, and the pre-await advance() miss is stale. enqueue() cannot auto-start it
        // either — this lock task holds the lock — so without the re-read the station would
        // dry-hold with a real track queued. Either way this is the SAME single advance the radio
        // branch already did (never two), so it cannot double-advance; a user add sorts ahead of
        // trailing radio filler, so the newly-enqueued track still wins the promotion.
        const gained = radioMeta !== null || this.queue.snapshot().upcoming.length > 0;
        if (!gained || (await this.queue.advance()) === null) {
          // queue dry, no radio: hold paused, preserve last current/seed. NO teardown.
          this.enterDryHoldLocked();
          return;
        }
      }
    }
    await this.loadCurrentLocked(0, failWalk);
  }

  private async loadCurrentLocked(startMs: number, failWalk = 0): Promise<void> {
    const item = this.queue.current;
    if (!item || !this.sink) {
      this.emit("changed");
      return;
    }
    // Capture the advance generation for the WHOLE load. The download below is awaited (and can
    // take minutes for a long mix), during which clear() or detachSink() — the only two paths that
    // bump the generation OUTSIDE this.lock — may run. If either did, this load is superseded and
    // its post-download play step must NOT run (it would resurrect a track after clear() idled the
    // station, or call this.sink.play() on a sink detachSink() just nulled). Re-checked after the
    // await (skip/pause/crossfade all bump INSIDE the lock, serialized behind us, so they can't
    // false-trigger this).
    const loadGen = this.playGeneration;
    // A new load supersedes any seek that targeted the previous load window.
    this.pendingSeekMs = null;
    this.setPreparing({
      videoId: item.meta.videoId,
      title: item.meta.title,
      phase: "resolving",
    });
    let path: string;
    let audio: AudioInfo | null;
    this._pausedDuringLoad = false; // fresh load window; only a pause() during THIS load counts
    this._loading = true; // a load is in flight → pause()/seek() defer to completion
    try {
      this.setPreparing({
        videoId: item.meta.videoId,
        title: item.meta.title,
        phase: "downloading",
        percent: 0,
      });
      // Under the never-hang watchdog: a download dep that NEVER settles would hold the station
      // lock forever. A trip rejects into the catch below, which is exactly the normal
      // "this track failed" path (trackError banner → discard → backoff → next candidate).
      const res = await this.withWatchdog(
        this.deps.download(item.meta.videoId, {
          // Thread the track duration so the yt-dlp timeout auto-scales for long
          // mixes/concerts instead of being SIGKILLed at the short default.
          durationSec: item.meta.durationSec,
          onProgress: (pct) =>
            this.setPreparing({
              videoId: item.meta.videoId,
              title: item.meta.title,
              phase: "downloading",
              percent: pct,
            }),
        }),
        StationController.DOWNLOAD_WATCHDOG_MS,
        `download ${item.meta.videoId}`,
      );
      path = res.path;
      audio = res.audio;
    } catch (err) {
      this._loading = false;
      // Supersede check (same loadGen as the success path): a clear() or detachSink() ran during
      // the (failed) download. Bail WITHOUT surfacing a "Skipped" banner, discarding, or walking to
      // the next candidate — any of which would resurrect playback (radio) after the user cleared,
      // which is exactly the stuck-download-then-Clear escape hatch clear() exists for.
      if (loadGen !== this.playGeneration) {
        this.setPreparing(null);
        return;
      }
      // download failed → discard + try the next (radio/next track). Best-effort.
      this.setPreparing(null);
      // Surface the failure to the UI (banner) BEFORE discarding, while `item` is still known.
      const reason = err instanceof Error && err.message ? err.message : "download failed";
      this.emitTrackError(item, reason);
      // Self-heal: a half-written / corrupt cached file makes every retry of this track fail the
      // same way. Drop its cache entry so the next attempt re-downloads (best-effort).
      this.evictTrack(item.meta.videoId);
      await this.queue.discardCurrent();
      // Back off before walking to the next candidate so a mass-failure (whole-feed outage) is a
      // slow retry, not a tight burst of yt-dlp spawns + related() fetches. Delay grows with the
      // consecutive-failure streak up to a cap; a successful load resets the streak to 0.
      this.downloadFailStreak += 1;
      // Bound the walk (see MAX_FAIL_WALK): this method and playNextLocked call each other, so a
      // long run of failing tracks would hold the station lock for an unbounded TOTAL even though
      // each await is bounded. Stop walking and dry-hold instead — the guaranteed armed retry
      // continues the search in a FRESH lock task (startNextLocked leaves this freshly-promoted,
      // never-played candidate in place), so the lock is free for skip/resume/enqueue meanwhile.
      // The in-lock backoff below is skipped with it; the retry's own backoff paces the next try.
      if (failWalk >= StationController.MAX_FAIL_WALK) {
        this.enterDryHoldAndRetryLocked();
        return;
      }
      await this.delay(this.failBackoffMs());
      // A clear() during the backoff wait supersedes this advance too — don't walk to the next.
      if (loadGen !== this.playGeneration) return;
      await this.playNextLocked(failWalk + 1);
      return;
    }
    this._loading = false;
    // Supersede check (see loadGen capture above): a clear() or detachSink() ran during the
    // download. Do NOT pin/adopt/play — bailing here leaves the station in the idle/detached state
    // that clear()/detachSink() established rather than restarting a track behind the user's back.
    if (loadGen !== this.playGeneration) {
      this.setPreparing(null);
      return;
    }
    // The commit tail runs under error handling for the same reason the download does: this whole
    // method is a VOIDED lock task, so a throw here (a sink whose socket died between the supersede
    // check and the write, a synchronous 'changed'/pin listener that threw) would surface as an
    // unhandled rejection AND leave the station with nothing playing and no advance armed — a stop
    // with no recovery. It is straight-line synchronous, so nothing can supersede us mid-way.
    let started = false; // the sink was already told to load/play → the track IS live
    try {
      // Forward the real audio format so /audio/:id can serve playable opus/webm/m4a as-is (not
      // transcode) and the NowPlaying format badge can render. Pin under the same audio so the
      // cache carries it too.
      this.queue.setCurrentAudio(item.meta.videoId, audio);
      // Release the PREVIOUS track's pin before pinning the new one, so pins don't accumulate
      // without bound and defeat LRU eviction (spec: the cache honors CACHE_MAX_MB; a station that
      // plays forever must not pin every track it ever played). The unpin dep also releases the
      // derived `${videoId}.m4a` transcode key (see src/index.ts wiring). Skip when the same
      // videoId is re-pinned (repeat="one") so we never unpin the track we are about to pin.
      if (this.pinnedVideoId && this.pinnedVideoId !== item.meta.videoId) {
        this.deps.unpin?.(this.pinnedVideoId);
      }
      this.deps.pin?.(item.meta.videoId, path, audio);
      this.pinnedVideoId = item.meta.videoId;
      this.setPreparing(null);
      this.playGeneration += 1; // fresh live track → re-arm the advance guard
      this.liveItemId = item.id;
      // Retain the exact item the sink was told to load so snapshot()/now-playing tracks the
      // actually-playing track (not the raw queue head that may have already advanced). `item` is
      // the same object the queue holds while current, so setCurrentAudio mutates it in place.
      this.liveItem = item;
      this._dryHeld = false;
      this._pausedFromDryHold = false; // a real track is live again — the remembered hold is stale
      // A track is live again: cancel any pending dry-hold radio retry and reset its backoff so a
      // future drain starts fresh from the base delay.
      this.cancelRadioRetry();
      this.radioRetryAttempt = 0;
      // A concurrent seek during the (awaited) download re-anchored the position; honor it over the
      // original startMs so the user's seek is not clobbered when the load completes.
      const effectiveStartMs = this.pendingSeekMs ?? startMs;
      this.pendingSeekMs = null;
      // A pause() issued WHILE this track was still downloading must survive: prepare/anchor the
      // audio but load it PAUSED (no play, keep _paused=true) so playback doesn't start behind the
      // user's back. Otherwise this is an intentional (re)start — clear _paused and play. Note we
      // key off _pausedDuringLoad, NOT the plain _paused flag: a dry-hold sets _paused=true too, and
      // an intentional restart out of dry-hold must resume playback.
      if (this._pausedDuringLoad) {
        this._paused = true;
        this._pausedDuringLoad = false;
        this.markTrackStarted(effectiveStartMs, true);
        this.sink.load({ audioUrl: `/audio/${item.meta.videoId}`, startMs: effectiveStartMs });
      } else {
        this._paused = false;
        this.markTrackStarted(effectiveStartMs);
        this.sink.play({ audioUrl: `/audio/${item.meta.videoId}`, startMs: effectiveStartMs });
      }
      started = true;
      // Clear the consecutive-failure streak only once the track is genuinely LIVE, not merely
      // downloaded: the commit tail can still throw (a sink whose socket died), and zeroing the
      // streak before that would re-zero the backoff on every failed commit — turning a sink that
      // throws on EVERY track into an undamped spin instead of a backing-off retry.
      this.downloadFailStreak = 0;
      this.emit("changed");
    } catch (err) {
      // The sink already has the track: only the trailing broadcast failed. Swallow it — tearing
      // down an audible track would be a strictly worse outcome than one missed 'changed' (every
      // later change re-broadcasts the full snapshot anyway).
      if (started) return;
      // Nothing is playing and nothing will ever signal trackEnd for this item, so treat it exactly
      // like a failed download: banner → discard → back off → walk on to the next candidate.
      const reason = err instanceof Error && err.message ? err.message : "playback start failed";
      this.setPreparing(null);
      this.emitTrackError(item, reason);
      // Self-heal: the file we just handed the sink may itself be the problem, so drop its cache
      // entry — the next attempt re-downloads instead of re-serving the same bad bytes forever.
      this.evictTrack(item.meta.videoId);
      // Capture the generation AFTER the (partially-run) tail, which may already have bumped it:
      // only a clear()/detachSink() landing during the awaits below must abort the advance.
      const tailGen = this.playGeneration;
      await this.queue.discardCurrent();
      if (tailGen !== this.playGeneration) return;
      // Damp this path on the SAME consecutive-failure streak as a failed download: a sink that
      // throws on every track (dead socket) would otherwise spin through the whole queue at full
      // speed — the downloads may even be cached, so nothing else paces it. Bound the walk too.
      this.downloadFailStreak += 1;
      if (failWalk >= StationController.MAX_FAIL_WALK) {
        this.enterDryHoldAndRetryLocked();
        return;
      }
      await this.delay(this.failBackoffMs());
      if (tailGen !== this.playGeneration) return;
      await this.playNextLocked(failWalk + 1);
    }
  }

  skip(): void {
    // Explicit user action: do NOT gate on the trackEnd/error generation guard. That guard exists
    // to de-dup stale end/error signals; applying it here would drop a Skip pressed during a load
    // window (loadCurrentLocked bumps the generation on completion, so the captured gen would be
    // stale by the time this closure runs). The lock serializes us, so we always act on the live
    // state; bump the generation ourselves so any in-flight/late end signal for the skipped track
    // can't also advance.
    void this.lock.runExclusive(async () => {
      this.playGeneration += 1;
      this._dryHeld = false;
      await this.queue.advance();
      await this.playNextLocked();
    });
  }
  pause(): void {
    this._paused = true;
    // Remember that this pause happened DURING a dry-hold. We still clear _dryHeld (a manual pause
    // is deliberate: enqueue's auto-start must not fire behind the user's back), but resume() needs
    // the fact back — otherwise it takes the plain sink.resume() branch, sends `play` for a queue
    // that has nothing left to play, and (because pause() also cancels the radio retry) the station
    // never restarts: a permanent silent stop from a single Pause press on a drained queue.
    this._pausedFromDryHold = this._dryHeld;
    this._dryHeld = false; // a manual pause is deliberate; it is not the dry-queue hold
    // If a load is in flight, record that the pause happened DURING it so loadCurrentLocked lands
    // the track PAUSED instead of auto-playing over the user's pause when the download completes.
    if (this._loading) this._pausedDuringLoad = true;
    this.cancelRadioRetry(); // a deliberate stop cancels the auto-resume retry
    this.freezePosition();
    this.sink?.pause();
    this.emit("changed");
  }
  resume(): void {
    // When holding paused on a dry queue, resume() restarts the station: advance past the
    // finished (held) track into whatever is now queued / radio (spec §3/§4 never-stops).
    // `_pausedFromDryHold` covers the same state after a manual Pause cleared _dryHeld — without
    // it, Pause-then-Resume on a drained queue is a permanent silent stop (see pause()).
    if ((this._dryHeld || this._pausedFromDryHold) && this.sink) {
      // Restore the hold before restarting: startNextLocked's "retire the finished held track"
      // step is gated on _dryHeld, so without this we would RELOAD the already-finished track
      // from 0 instead of advancing into the queue/radio.
      this._dryHeld = true;
      this._pausedFromDryHold = false;
      // Explicit user action: no generation gate (see skip()). The lock serializes us; bump the
      // generation so a stale end/error can't also fire.
      void this.lock.runExclusive(async () => {
        this.playGeneration += 1;
        await this.startNextLocked();
      });
      return;
    }
    this._paused = false;
    this.thawPosition();
    this.sink?.resume();
    this.emit("changed");
  }

  /**
   * The Player has begun an equal-power crossfade into the queued next track and already started
   * that track's <audio> element — advance current→next WITHOUT loading/playing the sink (the
   * Player is already playing it). Runs under the playback lock so it serializes against the normal
   * trackEnd/error advance and skip/jump.
   *
   * No-op unless a sink is attached, we are genuinely playing (not dry-held), and there is a next
   * track (upcoming[0]); when the queue has no next the Player instead sends `trackEnded` (no
   * crossfade with nothing to fade into) and the normal trackEnded→advance / radio / dry-hold path
   * handles the end.
   *
   * Advance-exactly-once: bumping playGeneration re-arms the guard so a stale/late `trackEnded` or
   * `error` for the just-faded-out (old) track — whose handler captured the pre-bump generation —
   * cannot also advance. The contract guarantees the Player sends EITHER `crossfadeAdvance` OR
   * `trackEnded` for a given track (never both), so this is defense against a race, not a duplicate.
   * Deliberately does NOT call loadCurrentLocked/sink.load: the next audio is already audible. The
   * prefetch of the NEW upcoming[0] and radioTopUp fire automatically via queue.advance()'s change
   * event (the same wiring loadCurrentLocked relies on).
   */
  crossfadeAdvance(): void {
    // Capture the advance generation at signal time (mirrors onSinkTrackEnd). playGeneration only
    // ever increments, so if a Skip/jump/load raced this in-flight crossfade — bumping the
    // generation before our lock task runs — the captured value no longer matches and this fade
    // targeted an already-retired track: no-op so we don't double-advance (server on T3 while the
    // speaker plays T2).
    const gen = this.playGeneration;
    void this.lock.runExclusive(async () => {
      if (gen !== this.playGeneration) return; // a skip/jump/load already advanced — stale crossfade
      if (!this.sink || this._dryHeld) return;
      // No next track → let the Player's trackEnded path (radio/dry-hold) handle the end instead.
      if (this.queue.snapshot().upcoming.length === 0) return;
      // Re-arm BEFORE advancing so any end/error signal captured for the outgoing track is stale.
      this.playGeneration += 1;
      const item = await this.queue.advance();
      // Race guard: nothing was actually promoted (e.g. the queue drained between the check and the
      // advance) — leave the end handling to the normal trackEnded path.
      if (!item) return;
      // Adopt the already-playing next track as live WITHOUT a load/play. advance() archived the
      // finished (faded-out) track to history and fired prefetch(newHead) + radioTopUp via its
      // 'changed'/'prefetch' events, so the head is warming and radio tops up on its own.
      this.liveItemId = item.id;
      this.liveItem = item;
      this._paused = false;
      this.markTrackStarted(0); // fresh track → position clock restarts at 0
      // Populate the crossfaded-in track's `.audio` from the cache (loadCurrentLocked normally does
      // this via setCurrentAudio off the download result, which the crossfade path skips). Without
      // it the NowPlaying format badge would blank out for the whole duration of every crossfaded
      // track. Mutates the item in place (the same object the queue holds while current).
      const xfAudio = item.audio ?? this.deps.getAudio?.(item.meta.videoId) ?? null;
      this.queue.setCurrentAudio(item.meta.videoId, xfAudio);
      // Mirror loadCurrentLocked's pin bookkeeping (its unpin/pin/pinnedVideoId sequence) so a
      // pure-crossfade run neither leaks pins nor leaves the new current LRU-evictable mid-song:
      // release the PREVIOUS track's pin — deps.unpin also drops its derived `${videoId}.m4a`
      // transcode key, which loadCurrentLocked's unpin never reaches on a crossfade-only advance —
      // then pin the new current and re-point pinnedVideoId at it. There is no fresh download path
      // here (the next audio is already playing; calling deps.download would re-fetch and break
      // both the "next is already audible" contract and the crossfade tests), but prefetch / the
      // audio route already cache-registered the file, so deps.pin's register() no-ops on the
      // absent path and simply (re-)pins that existing entry.
      if (this.pinnedVideoId && this.pinnedVideoId !== item.meta.videoId) {
        this.deps.unpin?.(this.pinnedVideoId);
      }
      this.deps.pin?.(item.meta.videoId, "", item.audio);
      this.pinnedVideoId = item.meta.videoId;
      this.emit("changed");
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async keeps the rejected-promise contract (callers await; RangeError surfaces via .rejects, not a sync throw)
  async seek(positionMs: number): Promise<boolean> {
    const item = this.queue.current;
    if (!item) return false;
    const max =
      item.meta.durationSec && item.meta.durationSec > 0 ? item.meta.durationSec * 1000 : 0;
    if (!Number.isFinite(positionMs) || positionMs < 0 || (max > 0 && positionMs > max)) {
      throw new RangeError("positionMs out of range");
    }
    // A seek issued while the track is still downloading is remembered and applied when the load
    // completes (loadCurrentLocked reads pendingSeekMs), so the in-flight load's original startMs
    // does not clobber it.
    if (this._loading) this.pendingSeekMs = positionMs;
    this.markTrackStarted(positionMs, this._paused);
    this.sink?.seek(positionMs);
    this.emit("changed");
    return true;
  }

  /**
   * Player <audio> 'timeupdate' telemetry (ws.ts → client {type:"position",ms}). Re-anchors the
   * position clock to the browser's authoritative currentTime so the broadcast progress bar
   * tracks real playback. Ignored when no current track / out of range. Does NOT emit 'changed'
   * (avoids a broadcast storm at ~1 Hz); the next settings/queue change carries the fresh anchor.
   */
  reportPosition(ms: number): void {
    const item = this.queue.current;
    if (!item || !Number.isFinite(ms) || ms < 0) return;
    this.markTrackStarted(ms, this._paused);
  }

  remove(itemId: string): Promise<boolean> {
    return this.queue.remove(itemId);
  }
  reorder(itemId: string, toIndex: number): Promise<boolean> {
    return this.queue.reorder(itemId, toIndex);
  }
  async jump(itemId: string): Promise<boolean> {
    const snap = this.queue.snapshot();
    const idx = snap.upcoming.findIndex((i) => i.id === itemId);
    if (idx === -1) return false;
    // Move the target to the head, then advance into it.
    await this.queue.reorder(itemId, 0);
    // Explicit user action: no generation gate (see skip()). Otherwise a Jump pressed during a
    // load window would reorder the item to the head yet never force-play it.
    await this.lock.runExclusive(async () => {
      this.playGeneration += 1;
      this._dryHeld = false;
      await this.queue.advance();
      await this.playNextLocked();
    });
    return true;
  }
  shuffle(rng?: () => number): Promise<void> {
    return this.queue.shuffle(rng);
  }
  async clear(): Promise<void> {
    // Intentionally NOT taking this.lock: a loadCurrentLocked may be holding it across a slow
    // (up to 30-min) download, and Clear is the control the user reaches for to escape exactly
    // that — it must stay responsive. Instead we bump the generation so any in-flight load aborts
    // its post-download play step (see the guard in loadCurrentLocked) rather than resurrecting a
    // track after the queue was cleared, and we tear down every path that could restart playback.
    this.playGeneration += 1; // an in-flight load / a late trackEnd|error for the old track is now stale
    // Kill any armed dry-hold radio retry and drop the dry-hold flag so a queued (or about-to-fire)
    // retry can't call startNextLocked and spontaneously restart radio seconds after the clear.
    this.cancelRadioRetry();
    this.radioRetryAttempt = 0;
    this._dryHeld = false;
    await this.queue.clear();
    // queue.clear() empties the queue (current→null) but the browser <audio> keeps playing the old
    // track and liveItem/liveItemId stay stale, so the snapshot still reports it as now-playing and
    // audio keeps sounding until the next enqueue cuts it off. Stop the sink and drop the
    // now-playing anchor so the station truly goes idle. Release the pin too so the just-cleared
    // track becomes LRU-evictable (nothing is holding it now).
    this.sink?.stop();
    if (this.pinnedVideoId) {
      this.deps.unpin?.(this.pinnedVideoId);
      this.pinnedVideoId = null;
    }
    this.liveItem = null;
    this.liveItemId = null;
    // queue.clear() already emitted 'changed' while liveItem was still stale, so re-emit AFTER
    // resetting so subscribers see the idle state.
    this.emit("changed");
  }

  updateSettings(patch: Partial<Record<keyof StationSettings, unknown>>): StationSettings {
    this._settings = applySettingsPatch(this._settings, patch);
    this.deps.onSettingsChanged?.({ ...this._settings });
    if (this.sink) this.sink.setVolume(this._settings.volume);
    this.emit("changed");
    return { ...this._settings };
  }
  setVolume(pct: number): StationSettings {
    return this.updateSettings({ volume: pct });
  }

  snapshot(): StationSnapshot {
    const snap = this.queue.snapshot();
    // Report the track the sink was actually last told to play (liveItem), NOT the raw queue head.
    // When the head already IS the live track use the fresh clone (it carries the up-to-date
    // `.audio` from setCurrentAudio); while the next track is still downloading, keep showing the
    // retained liveItem so now-playing doesn't jump to a track that isn't audible yet. Before any
    // track has ever loaded (cold start / restore, liveItemId===null) fall back to the head so the
    // persisted/promoted track still shows. positionMs and durationMs are BOTH taken from this base
    // so the progress bar can't overlay one track's elapsed time on another track's duration.
    const liveMatchesHead = this.liveItemId !== null && snap.current?.id === this.liveItemId;
    const base = liveMatchesHead ? snap.current : (this.liveItem ?? snap.current);
    const current: CurrentItem | null = base
      ? {
          ...base,
          positionMs: this.positionMs(),
          durationMs:
            base.meta.durationSec && base.meta.durationSec > 0 ? base.meta.durationSec * 1000 : 0,
        }
      : null;
    return {
      ...this._settings,
      current,
      upcoming: snap.upcoming,
      upcomingRadio: this.upcomingRadio.map((i) => ({ ...i })),
      history: snap.history,
      seed: this._seed,
      paused: this._paused,
      preparing: this.preparing ? { ...this.preparing } : null,
      // server fills the player-presence + live-listeners fields; orchestrator reports defaults.
      activePlayerPresent: false,
      activePlayerLabel: null,
      listeners: [],
    };
  }

  // A persisted QueueItem is only trustworthy if its meta.videoId and requester.deviceId are
  // strings; legacy/corrupt items (null meta, numeric videoId, …) are skipped, not restored.
  private static isValidQueueItem(it: unknown): it is QueueItem {
    const q = it as QueueItem | null | undefined;
    return typeof q?.meta?.videoId === "string" && typeof q?.requester?.deviceId === "string";
  }
  // A persisted seed is only trustworthy with a string videoId (RadioEngine feeds it to
  // youtube.related(seed.videoId)); anything else is dropped to a cold start.
  private static isValidSeed(s: unknown): s is TrackMeta {
    return typeof (s as TrackMeta | null | undefined)?.videoId === "string";
  }

  async restore(file: StationSnapshotFile): Promise<void> {
    this._seed = StationController.isValidSeed(file.seed) ? file.seed : null;
    this._settings = applySettingsPatch(this._settings, file.settings);
    // Per-item validate the radio buffer too (same guarantee as the explicit queue below) so a
    // single malformed entry can't be broadcast verbatim to the UI.
    this.upcomingRadio = Array.isArray(file.upcomingRadio)
      ? file.upcomingRadio.filter((i) => StationController.isValidQueueItem(i))
      : [];
    // Restore the persisted history so the History panel is not empty after a restart. The
    // snapshot faithfully saves history, but the queue's `_history` ring starts empty and only
    // advance() appends to it — without this the whole pre-restart history is silently lost.
    // Per-item validated with the same guard as the explicit queue below.
    if (Array.isArray(file.history)) {
      await this.queue.restoreHistory(
        file.history.filter((i) => StationController.isValidQueueItem(i)),
      );
    }
    const items: QueueItem[] = [
      ...(file.current ? [file.current] : []),
      ...(Array.isArray(file.queue) ? file.queue : []),
    ];
    for (const it of items) {
      if (!StationController.isValidQueueItem(it)) continue;
      await this.queue.add(it.meta, it.requester, it.fromRadio === true);
    }
    // Promote the first item to "current" without playing (no sink yet on a cold restore).
    if (this.queue.current === null && this.queue.snapshot().upcoming.length > 0) {
      await this.queue.advance();
    }
    this._paused = true;
    // Only finite, non-negative positions are honored; NaN/Infinity/negative → 0 so the position
    // clock never serializes a non-finite positionMs into the broadcast snapshot.
    const pos = file.positionMs;
    const safePos = typeof pos === "number" && Number.isFinite(pos) && pos >= 0 ? pos : 0;
    this.markTrackStarted(safePos, true);
    this.emit("changed");
  }

  // ── position bookkeeping ─────────────────────────────────────────────────
  private positionMs(): number {
    if (this.startedAt === null) return 0;
    const pausedNow = this.pausedAt !== null ? this.now() - this.pausedAt : 0;
    return Math.max(0, this.now() - this.startedAt - this.pausedAccumMs - pausedNow);
  }
  private markTrackStarted(baseMs = 0, keepPaused = false): void {
    const paused = keepPaused && this._paused;
    this.startedAt = this.now() - baseMs;
    this.pausedAccumMs = 0;
    this.pausedAt = paused ? this.now() : null;
  }
  private freezePosition(): void {
    if (this.pausedAt === null) this.pausedAt = this.now();
  }
  private thawPosition(): void {
    if (this.pausedAt !== null) {
      this.pausedAccumMs += this.now() - this.pausedAt;
      this.pausedAt = null;
    }
  }
  private setPreparing(state: PreparingState | null): void {
    this.preparing = state;
    this.emit("changed");
  }
}
