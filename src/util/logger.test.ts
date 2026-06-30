import { describe, it, expect } from "vitest";
import { createLogger, isValidLevel, LEVELS, getRootLogger, setRootLogger } from "./logger.js";

describe("createLogger", () => {
  it("creates a logger at the requested level", () => {
    const log = createLogger("warn");
    expect(log.level).toBe("warn");
    expect(typeof log.info).toBe("function");
  });
  it("defaults to info for an unknown level", () => {
    expect(createLogger("nonsense").level).toBe("info");
  });
  it("normalizes case so a valid level in any case is honored (not demoted to info)", () => {
    expect(createLogger("WARN").level).toBe("warn");
    expect(createLogger("Info").level).toBe("info");
  });
});

describe("isValidLevel", () => {
  it("accepts every level in LEVELS, case-insensitively", () => {
    for (const lvl of LEVELS) {
      expect(isValidLevel(lvl)).toBe(true);
      expect(isValidLevel(lvl.toUpperCase())).toBe(true);
    }
  });
  it("rejects unknown levels", () => {
    expect(isValidLevel("verbose")).toBe(false);
    expect(isValidLevel("")).toBe(false);
  });
});

describe("root logger", () => {
  it("returns a default logger before one is set, then the one that was set", () => {
    // Default (lazy) instance is usable.
    expect(typeof getRootLogger().info).toBe("function");
    const custom = createLogger("debug");
    setRootLogger(custom);
    expect(getRootLogger()).toBe(custom);
    // Restore a neutral default so test ordering can't leak the "debug" instance.
    setRootLogger(createLogger("info"));
  });
});
