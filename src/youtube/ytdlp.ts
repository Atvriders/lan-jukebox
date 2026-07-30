import { spawn } from "node:child_process";
import { YtError, YtErrorKind } from "./errors.js";

export interface YtDlpRun {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * How long to wait after the child's 'exit' for a normal 'close' (all stdio pipes ended)
 * before settling with whatever we buffered. See the 'exit' handler for why 'close' alone
 * is not a safe settlement trigger.
 */
const EXIT_CLOSE_GRACE_MS = 2000;

/**
 * Run yt-dlp, buffering stdout/stderr and resolving on close. The optional `onLine`
 * callback fires once per COMPLETE stdout line as it streams in (used to surface live
 * `[download] …` progress without waiting for the process to finish). Lines split across
 * read-chunk boundaries are reassembled; the trailing remainder (no terminating newline)
 * is flushed once on close so a final progress line is never lost. `onLine` is a pure
 * observer — it never affects the buffered `stdout` returned to the caller, and a throw
 * inside it is swallowed so a faulty observer can't break the download.
 *
 * This promise is GUARANTEED to settle within ~timeoutMs. That guarantee is load-bearing:
 * every caller runs inside the station mutex, so one non-settling run wedges the queue and
 * the radio stops forever. That is exactly what happened in production — yt-dlp's ffmpeg
 * grandchild inherited our stdio pipes and kept them open after yt-dlp itself was killed,
 * so 'close' (which needs process-exit AND all pipes closed) never fired and the station
 * sat frozen for 45 hours. Hence: the timeout settles on its own, kills reach the whole
 * process GROUP, and 'exit' is a settlement path in its own right. Any settlement that may
 * leave that group alive also kills it and tears down our end of the pipes, so a surviving
 * orphan can neither grow our buffers nor call back into an already-finished caller.
 */
export function runYtDlp(
  args: string[],
  timeoutMs: number,
  onLine?: (line: string) => void,
): Promise<YtDlpRun> {
  return new Promise<YtDlpRun>((resolve, reject) => {
    // detached: true makes the child its own process-group leader so we can signal the
    // ENTIRE group below (yt-dlp's post-processing ffmpeg is a grandchild that inherits
    // our stdout/stderr; killing only yt-dlp leaves it alive holding those pipes open).
    // It changes process-group membership only — stdio stays explicitly wired as
    // ["ignore","pipe","pipe"], so output capture is unaffected. We deliberately do NOT
    // child.unref(): unref'ing would let the parent's loop drain while a run is still in
    // flight, changing shutdown semantics for no benefit — the timeout below already
    // bounds how long the child can hold the loop.
    const child = spawn("yt-dlp", args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // Guards against double-settlement across the five settle paths (timeout, exit-grace,
    // close, stream error, spawn error) and against emitting a trailing line twice.
    let settled = false;
    let exitTimer: ReturnType<typeof setTimeout> | null = null;

    // Holds the partial trailing line between stdout chunks until its newline arrives.
    let lineBuf = "";
    const emitLine = (line: string): void => {
      if (!onLine) return;
      try {
        onLine(line);
      } catch {
        // A faulty observer must never break the download (best-effort progress).
      }
    };

    // Every settle path funnels through these two so the promise settles exactly once and
    // BOTH timers are always cleared — a timer left armed on a long-lived station keeps the
    // event loop needlessly busy (and would fire against an already-settled promise).
    const clearTimers = (): void => {
      clearTimeout(timer);
      if (exitTimer !== null) {
        clearTimeout(exitTimer);
        exitTimer = null;
      }
    };
    const settleResolve = (value: YtDlpRun): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(value);
    };
    const settleReject = (err: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(err);
    };

    // Kill the whole process GROUP, not just yt-dlp: a surviving ffmpeg grandchild holds the
    // inherited stdio pipes open, which is what stopped 'close' from ever firing in the
    // 45h freeze. Falls back to the single-process kill when the group kill isn't possible
    // (no pid yet, ESRCH after reaping, unsupported platform). Both kills are guarded — a
    // failed kill must never throw out of this promise or crash the always-on process.
    const killTree = (): void => {
      try {
        if (typeof child.pid === "number") {
          process.kill(-child.pid, "SIGKILL");
          return;
        }
      } catch {
        // Group gone / not permitted / not supported — fall through to the direct kill.
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // Already dead / unkillable — nothing more we can do.
      }
    };

    // Stop consuming the child's pipes. Called before every settlement that can leave the
    // process group alive (timeout, stream error, 'exit' grace): an orphaned grandchild goes
    // on writing into the inherited fds, and a still-attached 'data' handler would keep
    // appending to `stdout`/`stderr` forever (unbounded memory on a station that never
    // restarts) and could fire `onLine` AFTER the promise settled — painting a phantom
    // "downloading" overlay over an already-loaded track. Destroying the streams also drops
    // our end of the two fds instead of holding them for the orphan's lifetime. Every step is
    // guarded: teardown must never throw out of this promise. One no-op 'error' listener is
    // re-attached because an 'error' with no listener at all crashes the process, and a late
    // pipe error can still surface while the stream tears down.
    const stopReading = (): void => {
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        try {
          stream.removeAllListeners("data");
          stream.removeAllListeners("error");
          stream.on("error", () => {});
          stream.destroy();
        } catch {
          // Already torn down — nothing more to release.
        }
      }
    };

    // Terminal path shared by 'close' and the 'exit' grace fallback.
    const finish = (code: number | null): void => {
      if (settled) return;
      // Flush any final line that arrived without a trailing newline.
      if (lineBuf.length > 0) {
        emitLine(lineBuf.replace(/\r$/, ""));
        lineBuf = "";
      }
      if (timedOut) {
        // Defensive: the timeout path already rejected, but a timed-out run must never
        // resolve as if it had completed normally.
        settleReject(new YtError(YtErrorKind.Timeout, `yt-dlp timed out after ${timeoutMs}ms`));
        return;
      }
      settleResolve({ stdout, stderr, code });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the group AND settle right here. The old code SIGKILLed and waited for
      // 'close' to reject — but Node emits 'close' only after the process exits AND every
      // stdio pipe is closed, so an orphaned grandchild could withhold it indefinitely and
      // this promise (holding the station mutex) never settled. The timeout is now
      // authoritative and never depends on the child cooperating.
      killTree();
      stopReading();
      settleReject(new YtError(YtErrorKind.Timeout, `yt-dlp timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // FIRST listener on the child, before we touch child.stdout / child.stderr at all. When
    // the spawn itself fails on fd exhaustion (EMFILE/ENFILE) Node hands back a ChildProcess
    // with NO stdio — `child.stdout.on(...)` would throw synchronously right here, so the
    // 'error' Node is about to emit would land on an emitter with no listener: an
    // uncaughtException that installCrashHandlers turns into exit(1), skipping the SIGTERM
    // snapshot flush and losing the queue/history. With the listener attached first, that
    // path rejects cleanly and clears both timers instead.
    child.on("error", (err) => {
      // Re-entrancy guard: Node also emits 'error' when a kill FAILS, so an unguarded
      // killTree() here could ping-pong error -> kill -> error forever.
      if (settled) return;
      // A spawn failure has no process to kill (pid undefined, both kills are no-ops), but
      // this same event fires for a failed kill on a LIVE child — and settling clears the
      // timer, i.e. the only future SIGKILL. No error branch may leave a running child with
      // no kill path or with our end of its pipes still attached.
      killTree();
      stopReading();
      settleReject(err);
    });

    // child.stdout / child.stderr are independent EventEmitters: the 'error' listener on
    // `child` does NOT catch errors emitted on its streams. In Node, an 'error' event on a
    // stream with no listener throws synchronously and crashes the process via
    // uncaughtException (e.g. an OOM-killed yt-dlp tearing down the stdio pipe, or a
    // platform-level ECONNRESET on the fd). Convert any stream error into a promise
    // rejection instead. If 'close' has already settled the promise, this reject is a no-op.
    // Every stdio wiring below is `?.`-guarded for the no-stdio EMFILE child described above.
    child.stdout?.on("error", (err) => {
      // Settling clears the timer, which removes the ONLY future SIGKILL for this child. A
      // stdout read error (EPIPE / ECONNRESET on the pipe) can fire while yt-dlp is still
      // alive and downloading; without an explicit kill here the process is orphaned forever
      // (leaking a live child per occurrence on a station that runs indefinitely). Force-kill
      // the group before we reject so no error branch can leave a running child with no kill
      // path.
      killTree();
      stopReading();
      settleReject(err);
    });
    child.stderr?.on("error", () => {
      // stderr is purely diagnostic; a read error on it must not crash the process. The
      // stdout 'error' / 'close' paths already settle the promise.
    });

    child.stdout?.on("data", (d: Buffer) => {
      // Post-settle output belongs to an orphan we have already given up on: dropping it
      // keeps `stdout` from growing without bound and keeps a stale `[download] …` line from
      // reaching onLine, which the UI would render as a phantom overlay on a loaded track.
      if (settled) return;
      const chunk = d.toString();
      stdout += chunk;
      if (!onLine) return;
      lineBuf += chunk;
      let nl = lineBuf.indexOf("\n");
      while (nl !== -1) {
        // Strip a trailing \r so CRLF / yt-dlp \r-progress lines parse cleanly.
        emitLine(lineBuf.slice(0, nl).replace(/\r$/, ""));
        lineBuf = lineBuf.slice(nl + 1);
        nl = lineBuf.indexOf("\n");
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (settled) return; // see the stdout guard: never buffer an orphan's output
      stderr += d.toString();
    });

    // 'exit' fires the moment the process terminates, even while its stdio pipes are still
    // open — and a grandchild holding those pipes can withhold 'close' forever, so 'exit' is
    // our independent settlement path. Give the pipes a short grace period to drain and emit
    // a normal 'close' (the common case, which keeps full output); if it never arrives,
    // settle anyway with whatever was buffered plus the exit code.
    child.on("exit", (code) => {
      if (settled || exitTimer !== null) return;
      exitTimer = setTimeout(() => {
        exitTimer = null;
        // No 'close' after the grace period means something we spawned is STILL alive holding
        // the inherited pipes — the exact orphan this function exists to defeat. Settling
        // without killing it would leak a live process plus two fds per run and let its output
        // keep landing in our buffers/onLine long after the caller moved on. Kill the group and
        // detach FIRST, then settle (whatever hadn't been read by now was already lost to the
        // caller the moment we settled, so nothing extra is truncated here).
        killTree();
        stopReading();
        finish(code);
      }, EXIT_CLOSE_GRACE_MS);
    });

    child.on("close", (code) => {
      finish(code);
    });
  });
}
