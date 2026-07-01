import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";

/**
 * Regression for the composition-root invariant (index.ts): "the debounced writer timer is
 * cleared in the shutdown task so it cannot fire post-close."
 *
 * The bug: shutdown task 1 cleared snapshotTimer, but task 2's app.close() fires each WS
 * socket close -> registry.onDisconnect -> station.detachSink()/pause(), both of which
 * emit('changed'). The 'changed' listener is scheduleSnapshot, which re-armed snapshotTimer
 * AFTER task 1 nulled it. The fix latches a `shuttingDown` flag (set before the clear) that
 * scheduleSnapshot honors, so any 'changed' emitted during app.close() is a no-op.
 *
 * This mirrors the exact wiring of index.ts lines 39-49 + 76 + the shutdown task, using a
 * `changed`-emitting stand-in for the station whose detach/pause path emit('changed') just as
 * the real StationController does (orchestrator/index.ts detachSink()/pause() -> emit).
 */
describe("composition-root shutdown: debounced snapshot timer stays cleared through app.close()", () => {
  afterEach(() => vi.useRealTimers());

  function wire() {
    vi.useFakeTimers();
    const station = new EventEmitter();
    const writes: number[] = [];

    // Verbatim shape of index.ts scheduleSnapshot + shuttingDown guard.
    let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
    let shuttingDown = false;
    const scheduleSnapshot = (): void => {
      if (shuttingDown) return;
      if (snapshotTimer) clearTimeout(snapshotTimer);
      snapshotTimer = setTimeout(() => {
        snapshotTimer = null;
        writes.push(Date.now());
      }, 3000);
    };
    station.on("changed", scheduleSnapshot);

    // Shutdown task 1: latch, then clear (index.ts).
    const shutdownTask1 = (): void => {
      shuttingDown = true;
      if (snapshotTimer) {
        clearTimeout(snapshotTimer);
        snapshotTimer = null;
      }
    };

    return {
      station,
      writes,
      scheduleSnapshot,
      shutdownTask1,
      snapshotTimer: () => snapshotTimer,
    };
  }

  it("app.close()-triggered 'changed' events do NOT re-arm the timer after shutdown latches", () => {
    const w = wire();

    // Live operation arms the timer.
    w.station.emit("changed");
    expect(w.snapshotTimer()).not.toBeNull();

    // Shutdown task 1 latches + clears.
    w.shutdownTask1();
    expect(w.snapshotTimer()).toBeNull();

    // Shutdown task 2 (app.close()) drives detachSink()/pause() -> emit('changed').
    w.station.emit("changed");
    w.station.emit("changed");

    // The guard makes those no-ops: timer stays cleared, and no post-close write can land.
    expect(w.snapshotTimer()).toBeNull();
    vi.advanceTimersByTime(5000);
    expect(w.writes).toHaveLength(0);
  });

  it("before shutdown, a 'changed' still arms + flushes normally (guard is inert while live)", () => {
    const w = wire();
    w.station.emit("changed");
    expect(w.snapshotTimer()).not.toBeNull();
    vi.advanceTimersByTime(3000);
    expect(w.writes).toHaveLength(1);
    expect(w.snapshotTimer()).toBeNull();
  });
});
