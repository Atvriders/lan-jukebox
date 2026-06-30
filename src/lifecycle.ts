import type { Logger } from "pino";

export interface ShutdownOpts {
  graceMs: number;
  exitFn?: (code: number) => void;
}
type Task = () => Promise<void> | void;

/**
 * Run the registered best-effort shutdown tasks in order, force-exiting if they take
 * longer than `graceMs`. Returns `true` if every task completed within the grace
 * window, `false` if the grace timer fired first (forced shutdown). The caller can use
 * the result to decide whether a clean `exit(0)` is still appropriate.
 */
export async function runShutdown(tasks: Task[], opts: ShutdownOpts): Promise<boolean> {
  const exit = opts.exitFn ?? ((c) => process.exit(c));
  let forced = false;
  const timer = setTimeout(() => {
    forced = true;
    exit(1);
  }, opts.graceMs);
  if (typeof timer.unref === "function") timer.unref();
  for (const task of tasks) {
    if (forced) return false;
    try {
      await task();
    } catch {
      /* shutdown is best-effort */
    }
  }
  clearTimeout(timer);
  // The in-loop `if (forced) return false` guard only fires when there is a *next* task to
  // skip. If the LAST (or only) task resolves after the grace timer already fired, the loop
  // exits normally — so re-check `forced` here. Otherwise a single hung-then-resolved task
  // would return true and trigger a second exit(0) on top of the timer's exit(1).
  return !forced;
}

export function installSignalHandlers(tasks: Task[], opts: ShutdownOpts, log?: Logger): void {
  let started = false;
  const handler = (sig: string) => {
    if (started) return;
    started = true;
    log?.info({ sig }, "shutting down");
    // Only exit(0) when the shutdown completed cleanly; if it was force-exited (exit(1)
    // already fired from the grace timer) we must NOT also invoke exit(0).
    void runShutdown(tasks, opts).then((ok) => {
      if (ok) (opts.exitFn ?? ((c) => process.exit(c)))(0);
    });
  };
  process.on("SIGTERM", () => handler("SIGTERM"));
  process.on("SIGINT", () => handler("SIGINT"));
}

export function installCrashHandlers(
  log: Logger,
  exitFn: (code: number) => void = (c) => process.exit(c),
): void {
  // An unhandled rejection is logged but intentionally NOT treated as fatal here: many
  // rejections originate in best-effort background work (prefetch, snapshot writes) that
  // should not take the whole app down. This deliberately suppresses Node's default
  // process-exit-on-unhandledRejection; revisit if fail-fast is later preferred.
  process.on("unhandledRejection", (reason) => log.error({ reason }, "unhandledRejection"));
  // An uncaught exception leaves the process in a potentially corrupted state. Registering
  // a listener suppresses Node's default crash-and-exit, so we must exit ourselves. Defer
  // by one tick so the (possibly async) log transport can flush first.
  process.on("uncaughtException", (err) => {
    log.error({ err }, "uncaughtException");
    setImmediate(() => exitFn(1));
  });
}
