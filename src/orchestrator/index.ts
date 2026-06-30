import { EventEmitter } from "node:events";
import type {
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
    opts?: { onProgress?: (pct: number) => void },
  ) => Promise<{ path: string }>;
  pin?: (videoId: string, path: string) => void;
  unpin?: (videoId: string) => void;
  prefetch?: (videoId: string) => Promise<void>;
  now?: () => number;
  onSettingsChanged?: (s: StationSettings) => void;
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
  // radio hooks (wired by RadioEngine in 1.6; null = no radio, hold-paused on drain).
  private radioContinuation: (() => Promise<TrackMeta | null>) | null = null;
  private radioTopUp: (() => void) | null = null;
  private upcomingRadio: QueueItem[] = [];

  constructor(private readonly deps: StationControllerDeps) {
    super();
    this.now = deps.now ?? (() => Date.now());
    this.queue = deps.queue ?? new Queue();
    this._settings = applySettingsPatch({ ...DEFAULT_SETTINGS }, deps.settings ?? {});
    this.queue.on("prefetch", (videoId: string | null) => {
      if (videoId && this.deps.prefetch) void this.deps.prefetch(videoId);
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
  private readonly onSinkError = (): void => {
    const gen = this.playGeneration;
    void this.lock.runExclusive(async () => {
      if (gen !== this.playGeneration) return;
      this.playGeneration += 1;
      await this.advanceAndPlayLocked("discard"); // failed track is NOT archived to history
    });
  };

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
    // Decide where to go BEFORE retiring `current`, so a dry queue keeps the finished track
    // as `current` (spec §3/§4: hold paused with current/position preserved, no teardown).
    const hasUpcoming = this.queue.snapshot().upcoming.length > 0;
    if (!hasUpcoming) {
      const radioMeta = this.radioContinuation ? await this.radioContinuation() : null;
      if (radioMeta) {
        await this.queue.add(radioMeta, AUTOPLAY_REQUESTER, true);
      } else {
        // queue dry, no radio: hold paused. On a CLEAN end keep the finished track as `current`
        // (spec §3/§4: current/position preserved, no teardown). On an ERROR discard the failed
        // track (it must not stay displayed as now-playing). startNextLocked retires either.
        if (disposition === "discard") await this.queue.discardCurrent();
        this.enterDryHoldLocked();
        return;
      }
    }
    if (disposition === "archive") await this.queue.advance();
    else await this.queue.discardCurrent();
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
    this.setPreparing({
      videoId: item.meta.videoId,
      title: item.meta.title,
      phase: "resolving",
    });
    let path: string;
    try {
      this.setPreparing({
        videoId: item.meta.videoId,
        title: item.meta.title,
        phase: "downloading",
        percent: 0,
      });
      const res = await this.deps.download(item.meta.videoId, {
        onProgress: (pct) =>
          this.setPreparing({
            videoId: item.meta.videoId,
            title: item.meta.title,
            phase: "downloading",
            percent: pct,
          }),
      });
      path = res.path;
    } catch {
      // download failed → discard + try the next (radio/next track). Best-effort.
      this.setPreparing(null);
      await this.queue.discardCurrent();
      await this.playNextLocked();
      return;
    }
    this.deps.pin?.(item.meta.videoId, path);
    this.setPreparing(null);
    this.playGeneration += 1; // fresh live track → re-arm the advance guard
    this._paused = false;
    this._dryHeld = false;
    this.markTrackStarted(startMs);
    this.sink.play({ audioUrl: `/audio/${item.meta.videoId}`, startMs });
    this.emit("changed");
  }

  skip(): void {
    const gen = this.playGeneration;
    void this.lock.runExclusive(async () => {
      if (gen !== this.playGeneration) return;
      this.playGeneration += 1;
      this._dryHeld = false;
      await this.queue.advance();
      await this.playNextLocked();
    });
  }
  pause(): void {
    this._paused = true;
    this._dryHeld = false; // a manual pause is deliberate; it is not the dry-queue hold
    this.freezePosition();
    this.sink?.pause();
    this.emit("changed");
  }
  resume(): void {
    // When holding paused on a dry queue, resume() restarts the station: advance past the
    // finished (held) track into whatever is now queued / radio (spec §3/§4 never-stops).
    if (this._dryHeld && this.sink) {
      const gen = this.playGeneration;
      void this.lock.runExclusive(async () => {
        if (gen !== this.playGeneration) return;
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

  // eslint-disable-next-line @typescript-eslint/require-await -- async keeps the rejected-promise contract (callers await; RangeError surfaces via .rejects, not a sync throw)
  async seek(positionMs: number): Promise<boolean> {
    const item = this.queue.current;
    if (!item) return false;
    const max =
      item.meta.durationSec && item.meta.durationSec > 0 ? item.meta.durationSec * 1000 : 0;
    if (!Number.isFinite(positionMs) || positionMs < 0 || (max > 0 && positionMs > max)) {
      throw new RangeError("positionMs out of range");
    }
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
    const gen = this.playGeneration;
    await this.lock.runExclusive(async () => {
      if (gen !== this.playGeneration) return;
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
    const current: CurrentItem | null = snap.current
      ? {
          ...snap.current,
          positionMs: this.positionMs(),
          durationMs:
            snap.current.meta.durationSec && snap.current.meta.durationSec > 0
              ? snap.current.meta.durationSec * 1000
              : 0,
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
      // server fills the player-presence fields; orchestrator reports defaults.
      activePlayerPresent: false,
      activePlayerLabel: null,
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
