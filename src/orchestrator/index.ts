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
  prefetch?: (videoId: string, durationSec?: number | null) => Promise<void>;
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
  private readonly setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (h: ReturnType<typeof setTimeout>) => void;
  private readonly radioRetryBaseMs: number;
  private static readonly RADIO_RETRY_CAP_MS = 60_000;

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
      this.emitTrackError(this.queue.current, reason);
      await this.advanceAndPlayLocked("discard"); // failed track is NOT archived to history
    });
  };

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
      const radioMeta = this.radioContinuation ? await this.radioContinuation() : null;
      if (radioMeta) {
        await this.queue.add(radioMeta, AUTOPLAY_REQUESTER, true);
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

  /** Await `ms` via the injectable timer (0 resolves immediately so tests need no fake clock). */
  private delay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.setTimeoutFn(() => resolve(), ms);
    });
  }

  /**
   * Promote the next track (head → radio → dry-hold) WITHOUT first retiring a held `current`.
   * Used by attach/enqueue auto-start: when dry-held the finished track is still `current`, so
   * we archive it here only once there is genuinely something to advance into.
   */
  private async startNextLocked(): Promise<void> {
    if (this._dryHeld) {
      // A held current is the already-finished track; retire it before promoting the new one.
      await this.queue.advance();
      this._dryHeld = false;
    }
    await this.playNextLocked();
  }

  // Core never-stopping advance: promote head → if none, ask radio → if none, hold paused.
  private async playNextLocked(): Promise<void> {
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
        const radioMeta = this.radioContinuation ? await this.radioContinuation() : null;
        if (radioMeta) {
          await this.queue.add(radioMeta, AUTOPLAY_REQUESTER, true);
          await this.queue.advance();
        } else {
          // queue dry, no radio: hold paused, preserve last current/seed. NO teardown.
          this.enterDryHoldLocked();
          return;
        }
      }
    }
    await this.loadCurrentLocked(0);
  }

  private async loadCurrentLocked(startMs: number): Promise<void> {
    const item = this.queue.current;
    if (!item || !this.sink) {
      this.emit("changed");
      return;
    }
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
      const res = await this.deps.download(item.meta.videoId, {
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
      });
      path = res.path;
      audio = res.audio;
    } catch (err) {
      this._loading = false;
      // download failed → discard + try the next (radio/next track). Best-effort.
      this.setPreparing(null);
      // Surface the failure to the UI (banner) BEFORE discarding, while `item` is still known.
      const reason = err instanceof Error && err.message ? err.message : "download failed";
      this.emitTrackError(item, reason);
      await this.queue.discardCurrent();
      // Back off before walking to the next candidate so a mass-failure (whole-feed outage) is a
      // slow retry, not a tight burst of yt-dlp spawns + related() fetches. Delay grows with the
      // consecutive-failure streak up to a cap; a successful load resets the streak to 0.
      this.downloadFailStreak += 1;
      // The FIRST failure advances immediately (an isolated bad track shouldn't add latency);
      // only a RUN of consecutive failures (a whole-feed outage) backs off, doubling up to a cap,
      // so a mass failure degrades into a slow retry instead of a thundering burst of yt-dlp spawns.
      const backoff =
        this.downloadFailStreak <= 1
          ? 0
          : Math.min(
              StationController.DOWNLOAD_FAIL_BACKOFF_CAP_MS,
              StationController.DOWNLOAD_FAIL_BACKOFF_BASE_MS * 2 ** (this.downloadFailStreak - 2),
            );
      await this.delay(backoff);
      await this.playNextLocked();
      return;
    }
    this._loading = false;
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
    // A track is live again: cancel any pending dry-hold radio retry and reset its backoff so a
    // future drain starts fresh from the base delay. Also reset the download-failure streak.
    this.cancelRadioRetry();
    this.radioRetryAttempt = 0;
    this.downloadFailStreak = 0;
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
    this.emit("changed");
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
    if (this._dryHeld && this.sink) {
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
    void this.lock.runExclusive(async () => {
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
  clear(): Promise<void> {
    return this.queue.clear();
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
