import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { runYtDlp } from "./ytdlp.js";
import { YtErrorKind } from "./errors.js";

type FakeProc = EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  kill: ReturnType<typeof vi.fn>;
};

function fakeProc(stdout: string, stderr: string, code: number | null): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = Readable.from([stdout]);
  proc.stderr = Readable.from([stderr]);
  proc.kill = vi.fn();
  setImmediate(() => proc.emit("close", code));
  return proc;
}

describe("runYtDlp", () => {
  beforeEach(() => spawnMock.mockReset());

  it("spawns yt-dlp with the args array and no shell", async () => {
    spawnMock.mockReturnValue(fakeProc('{"ok":true}', "", 0));
    const res = await runYtDlp(["-J", "--", "https://x"], 1000);
    expect(spawnMock).toHaveBeenCalledWith(
      "yt-dlp",
      ["-J", "--", "https://x"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(res).toEqual({ stdout: '{"ok":true}', stderr: "", code: 0 });
  });

  it("rejects with a Timeout YtError and kills the process when it overruns", async () => {
    const proc = new EventEmitter() as FakeProc;
    proc.stdout = new Readable({ read() {} }); // never ends
    proc.stderr = new Readable({ read() {} });
    proc.kill = vi.fn(() => {
      // Emit close after kill is called (simulating real process behavior)
      setImmediate(() => proc.emit("close", null));
    });
    spawnMock.mockReturnValue(proc);

    const p = runYtDlp(["-J"], 10);
    await expect(p).rejects.toMatchObject({ kind: YtErrorKind.Timeout });
    // Pin the signal: SIGKILL is unignorable. A regression to SIGTERM (or no argument)
    // would be catchable by the child, defeating the timeout guard.
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("propagates a spawn error (e.g. ENOENT)", async () => {
    const proc = new EventEmitter() as FakeProc;
    proc.stdout = Readable.from([]);
    proc.stderr = Readable.from([]);
    proc.kill = vi.fn();
    spawnMock.mockReturnValue(proc);
    const p = runYtDlp(["-J"], 1000);
    queueMicrotask(() => proc.emit("error", new Error("spawn yt-dlp ENOENT")));
    await expect(p).rejects.toThrow(/ENOENT/);
  });

  it("rejects (does not crash) when child.stdout emits 'error' instead of throwing uncaught", async () => {
    // An 'error' on a stream with no listener throws synchronously and would crash the
    // process via uncaughtException. runYtDlp must attach its own listener and turn it into
    // a promise rejection. We never emit 'close', so only the stream-error path can settle it.
    const proc = new EventEmitter() as FakeProc;
    proc.stdout = new Readable({ read() {} }); // never ends
    proc.stderr = new Readable({ read() {} });
    proc.kill = vi.fn();
    spawnMock.mockReturnValue(proc);

    const p = runYtDlp(["-J"], 1000);
    queueMicrotask(() => proc.stdout.emit("error", new Error("EPIPE")));
    await expect(p).rejects.toThrow(/EPIPE/);
  });

  it("does not crash when child.stderr emits 'error' (stderr error is swallowed)", async () => {
    // A read error on the diagnostic stderr stream must not crash the process. With an
    // 'error' listener attached it is swallowed; the run still resolves when 'close' fires.
    const proc = new EventEmitter() as FakeProc;
    proc.stdout = Readable.from(["{}"]);
    proc.stderr = new Readable({ read() {} });
    proc.kill = vi.fn();
    spawnMock.mockReturnValue(proc);

    const p = runYtDlp(["-J"], 1000);
    queueMicrotask(() => {
      proc.stderr.emit("error", new Error("stderr pipe error"));
      setImmediate(() => proc.emit("close", 0));
    });
    await expect(p).resolves.toMatchObject({ code: 0 });
  });

  it("invokes onLine for each COMPLETE stdout line as data streams in", async () => {
    // Two chunks that split a line across the boundary: the parser must reassemble
    // "line2" and only emit it once the trailing newline arrives.
    const proc = new EventEmitter() as FakeProc;
    proc.stdout = Readable.from(["line1\nlin", "e2\nline3"]);
    proc.stderr = Readable.from([]);
    proc.kill = vi.fn();
    setImmediate(() => proc.emit("close", 0));
    spawnMock.mockReturnValue(proc);

    const lines: string[] = [];
    const res = await runYtDlp(["-J"], 1000, (l) => lines.push(l));
    // Complete lines stream as their newline lands; the final no-newline remainder
    // ("line3") is flushed on close so a trailing progress line is never dropped.
    expect(lines).toEqual(["line1", "line2", "line3"]);
    // The buffered stdout is unchanged — onLine is purely an observer.
    expect(res.stdout).toBe("line1\nline2\nline3");
  });

  it("works without an onLine callback (back-compat)", async () => {
    spawnMock.mockReturnValue(fakeProc("a\nb\n", "", 0));
    const res = await runYtDlp(["-J"], 1000);
    expect(res.stdout).toBe("a\nb\n");
  });
});
