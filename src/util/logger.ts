import pino, { type Logger } from "pino";

/**
 * The pino log levels this app accepts. Exported so config.ts can validate LOG_LEVEL
 * against the SAME set the logger uses — the two cannot drift apart.
 */
export const LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LEVELS)[number];

const LEVEL_SET = new Set<string>(LEVELS);

/** True if `level` is a recognized pino level (case-insensitive). */
export function isValidLevel(level: string): boolean {
  return LEVEL_SET.has(level.toLowerCase());
}

export function createLogger(level = "info"): Logger {
  // Normalize case so an env override like LOG_LEVEL=WARN (from docker-compose/CI) maps to
  // the real "warn" level instead of silently falling back to "info".
  const normalised = level.toLowerCase();
  return pino({ level: LEVEL_SET.has(normalised) ? normalised : "info", base: undefined });
}

// Lazily-initialized process-wide root logger. main() calls setRootLogger() once it has
// loaded LOG_LEVEL so module-scope consumers emit at the configured level instead of a
// hardcoded-"info" instance that ignores LOG_LEVEL entirely.
let rootLogger: Logger | null = null;

export function setRootLogger(logger: Logger): void {
  rootLogger = logger;
}

export function getRootLogger(): Logger {
  // Fall back to a default-level logger if main() hasn't wired one yet (e.g. in unit tests).
  return (rootLogger ??= createLogger());
}
