type Cb<T = void> = (err: unknown, result?: T) => void;

interface Entry {
  session: unknown;
  expiresAt: number;
}

export interface MemorySessionStoreOpts {
  /** Server-side session TTL in ms (mirrors the cookie maxAge). Default: 7 days. */
  ttlMs?: number;
  /**
   * Interval (ms) for the background sweep that evicts expired entries. Default: 1 hour.
   * Pass 0 to disable the sweep (useful in tests). The timer is `.unref()`'d so it never
   * keeps the process alive on its own.
   */
  sweepMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * In-memory session store with server-side TTL eviction.
 *
 * The cookie `maxAge` only expires the CLIENT cookie; without a server-side TTL every
 * abandoned session (browser closed, login started but never completed, cookie expired
 * naturally) would leak an entry in the Map forever — an unbounded memory leak in a
 * long-running process. Each entry carries an `expiresAt` (refreshed on every set, since
 * sessions are `rolling`); `get` treats expired entries as absent and deletes them, and a
 * periodic unref'd sweep reclaims entries that are never read again.
 *
 * For multi-instance / restart-surviving deployments prefer a real backing store with
 * native key expiry (e.g. Redis); this store is per-process and resets on restart.
 */
export class MemorySessionStore {
  private readonly store = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly sweepTimer: ReturnType<typeof setInterval> | null;

  constructor(opts: MemorySessionStoreOpts = {}) {
    this.ttlMs = opts.ttlMs ?? SEVEN_DAYS_MS;
    this.now = opts.now ?? (() => Date.now());
    const sweepMs = opts.sweepMs ?? ONE_HOUR_MS;
    if (sweepMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), sweepMs);
      if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
    } else {
      this.sweepTimer = null;
    }
  }

  set(sessionId: string, session: unknown, cb: Cb): void {
    this.store.set(sessionId, { session, expiresAt: this.now() + this.ttlMs });
    cb(null);
  }
  get(sessionId: string, cb: Cb<unknown>): void {
    const entry = this.store.get(sessionId);
    if (!entry) return cb(null, null);
    if (entry.expiresAt <= this.now()) {
      this.store.delete(sessionId);
      return cb(null, null);
    }
    cb(null, entry.session);
  }
  destroy(sessionId: string, cb: Cb): void {
    this.store.delete(sessionId);
    cb(null);
  }

  /** Evict every entry past its expiry. Exposed for tests; also run by the sweep timer. */
  sweep(): void {
    const t = this.now();
    for (const [id, entry] of this.store) {
      if (entry.expiresAt <= t) this.store.delete(id);
    }
  }

  /** Visible for tests: current live entry count (after no eviction). */
  get size(): number {
    return this.store.size;
  }

  /** Stop the background sweep (e.g. on shutdown / in tests). */
  close(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }
}
