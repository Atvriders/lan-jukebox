import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A full disk cannot be produced deterministically from a test, so the ENOSPC is injected at the
// exact call that failed in production: the cookies write. mkdir is left REAL, so everything the
// failure path does around the throw (path building, logging, the caller's startup sequence) runs
// unchanged. This mock is why the test lives in its own file — the other materializeCookies tests
// need a working writeFile.
const writeFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: writeFileMock };
});

import { loadMediaConfig, materializeCookies } from "./config.js";
import { setRootLogger, createLogger } from "./util/logger.js";

function enospc(path: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`ENOSPC: no space left on device, open '${path}'`);
  err.code = "ENOSPC";
  err.errno = -28;
  err.syscall = "open";
  err.path = path;
  return err;
}

describe("materializeCookies on a FULL DISK", () => {
  beforeEach(() => {
    writeFileMock.mockReset();
  });
  afterEach(() => {
    setRootLogger(createLogger("silent"));
  });

  it("returns null and does NOT throw when the cookies write fails with ENOSPC", async () => {
    // Regression — this is what took the live station down. materializeCookies() runs in main()
    // BEFORE anything is serving, so an ENOSPC out of writeFile propagated out of startup: the
    // process exited, the container restarted, and it hit the same full disk again — a crash loop
    // with no music, over a file that is merely an OPTIMISATION (yt-dlp works without cookies).
    const error = vi.fn();
    setRootLogger({ error, warn: vi.fn(), info: vi.fn() } as never);
    const dir = mkdtempSync(join(tmpdir(), "lj-enospc-"));
    const cookiePath = join(dir, "yt-cookies.txt");
    writeFileMock.mockRejectedValue(enospc(cookiePath));
    const media = loadMediaConfig({ CACHE_DIR: dir, YT_COOKIES_TEXT: "SID=abc; HSID=def" });

    // The contract: resolves null. `rejects`-free, so a regression fails here rather than
    // unhandled-rejecting somewhere in startup.
    await expect(materializeCookies(media)).resolves.toBeNull();

    // It really did attempt the write (the null isn't from some earlier short-circuit)…
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(writeFileMock.mock.calls[0]![0]).toBe(cookiePath);
    // …no half-written cookies file is left behind for yt-dlp to choke on…
    expect(existsSync(cookiePath)).toBe(false);
    // …and it is LOUD: degrading silently would leave an operator hunting a bot-check wall with
    // no clue that cookies never made it to disk.
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toMatchObject({ err: { code: "ENOSPC" }, path: cookiePath });
  });

  it("still returns the path when the write succeeds (the mock isn't masking the happy path)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lj-enospc-"));
    writeFileMock.mockResolvedValue(undefined);
    const media = loadMediaConfig({ CACHE_DIR: dir, YT_COOKIES_TEXT: "SID=abc" });
    await expect(materializeCookies(media)).resolves.toBe(join(dir, "yt-cookies.txt"));
  });
});
