import { EventEmitter } from "node:events";
import type { QueueItem, QueueSnapshot, Requester, TrackMeta } from "../types/index.js";
import { Mutex } from "../util/mutex.js";

export interface QueueOptions {
  historyMax?: number;
  idFactory?: () => string;
  now?: () => number;
}

export class Queue extends EventEmitter {
  private _current: QueueItem | null = null;
  private _upcoming: QueueItem[] = [];
  private _history: QueueItem[] = [];
  // UNCAPPED record of every track that has cleanly advanced this cycle, kept separately
  // from the bounded `_history` ring so repeat="all" can re-cycle the FULL set even when it
  // exceeds historyMax. Reset on requeueHistory() / clear().
  private _played: QueueItem[] = [];
  private readonly mutex = new Mutex();
  private readonly historyMax: number;
  private readonly idFactory: () => string;
  private readonly now: () => number;

  constructor(opts: QueueOptions = {}) {
    super();
    this.historyMax = opts.historyMax ?? 100;
    this.idFactory = opts.idFactory ?? (() => crypto.randomUUID());
    this.now = opts.now ?? (() => Date.now());
  }

  get current(): QueueItem | null {
    return this._current;
  }

  snapshot(): QueueSnapshot {
    const clone = (i: QueueItem) => ({ ...i });
    return {
      current: this._current ? clone(this._current) : null,
      upcoming: this._upcoming.map(clone),
      history: this._history.map(clone),
    };
  }

  add(meta: TrackMeta, requester: Requester, fromRadio = false): Promise<QueueItem> {
    return this.mutex.runExclusive(() => {
      const item: QueueItem = {
        id: this.idFactory(),
        meta,
        requester,
        addedAt: this.now(),
        audio: null,
        fromRadio,
      };
      this._upcoming.push(item);
      this.emitChange();
      return item;
    });
  }

  advance(): Promise<QueueItem | null> {
    return this.mutex.runExclusive(() => {
      if (this._current) {
        this._played.push(this._current);
        this._history.push(this._current);
        if (this._history.length > this.historyMax) {
          this._history.splice(0, this._history.length - this.historyMax);
        }
      }
      this._current = this._upcoming.shift() ?? null;
      this.emitChange();
      return this._current;
    });
  }

  discardCurrent(): Promise<QueueItem | null> {
    return this.mutex.runExclusive(() => {
      this._current = this._upcoming.shift() ?? null;
      this.emitChange();
      return this._current;
    });
  }

  remove(itemId: string): Promise<boolean> {
    return this.mutex.runExclusive(() => {
      const idx = this._upcoming.findIndex((i) => i.id === itemId);
      if (idx === -1) return false;
      this._upcoming.splice(idx, 1);
      this.emitChange();
      return true;
    });
  }

  reorder(itemId: string, toIndex: number): Promise<boolean> {
    return this.mutex.runExclusive(() => {
      const from = this._upcoming.findIndex((i) => i.id === itemId);
      if (from === -1) return false;
      const clamped = Math.max(0, Math.min(toIndex, this._upcoming.length - 1));
      const [item] = this._upcoming.splice(from, 1);
      if (item) this._upcoming.splice(clamped, 0, item);
      this.emitChange();
      return true;
    });
  }

  shuffle(rng: () => number = Math.random): Promise<void> {
    return this.mutex.runExclusive(() => {
      const u = this._upcoming;
      for (let i = u.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = u[i]!;
        u[i] = u[j]!;
        u[j] = tmp;
      }
      this.emitChange();
    });
  }

  requeueHistory(): Promise<number> {
    return this.mutex.runExclusive(() => {
      const recycled = [...this._played];
      if (this._current) recycled.push(this._current);
      if (recycled.length === 0) return 0;
      this._played = [];
      this._history = [];
      this._current = null;
      this._upcoming.push(...recycled);
      this.emitChange();
      return recycled.length;
    });
  }

  clear(): Promise<void> {
    return this.mutex.runExclusive(() => {
      this._current = null;
      this._upcoming = [];
      this._played = [];
      this.emitChange();
    });
  }

  private emitChange(): void {
    this.emit("changed", this.snapshot());
    this.emit("prefetch", this._upcoming[0]?.meta?.videoId ?? null);
  }
}
