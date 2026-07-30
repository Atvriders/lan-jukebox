import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  pid?: number;
};

/**
 * A child that is alive with open pipes and will NEVER emit 'close' on its own — the shape of the
 * 45h production freeze (an ffmpeg grandchild inherited yt-dlp's stdio and held the pipes open, so
 * Node's 'close', which needs process-exit AND all pipes closed, never fired).
 */
function neverClosingProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new Readable({ read() {} }); // never ends
  proc.stderr = new Readable({ read() {} });
  proc.kill = vi.fn(); // deliberately silent: killing yt-dlp does NOT free the grandchild's pipes
  return proc;
}

function fakeProc(stdout: string, stderr: string, code: number | null): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = Readable.from([stdout]);
  proc.stderr = Readable.from([stderr]);
  proc.kill = vi.fn();
  setImmediate(() => proc.emit("close", code));
  return proc;
}

describe("runYtDlp", () => {
  beforeEach(() => {
    // Block body ON PURPOSE: the runner treats a beforeEach's returned function as a teardown, and
    // mockReset() returns the callable mock — so the arrow-return form has the runner invoke
    // spawnMock() with no arguments after every test.
    spawnMock.mockReset();
  });
  // Restore real timers via a HOOK, not just a try/finally: if a fake-timer test ever hangs
  // (exactly the failure mode these tests exist to catch) its finally never runs and every later
  // test in the file would silently inherit the frozen clock and time out too.
  afterEach(() => vi.useRealTimers());

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

  it("SETTLES on timeout even when 'close' NEVER fires (45h station-freeze regression)", async () => {
    // THE incident. runYtDlp used to SIGKILL on timeout and then wait for 'close' to do the
    // rejecting. yt-dlp's post-processing ffmpeg is a GRANDCHILD that inherits our stdout/stderr,
    // so killing yt-dlp alone left those pipes open and 'close' never arrived: this promise never
    // settled, its caller kept holding the station mutex, and the jukebox was frozen for 45 hours
    // with no crash and no recovery. The timeout must now be authoritative and settle on its own,
    // never depending on the child cooperating. This fake NEVER emits 'close' or 'exit'.
    const proc = neverClosingProc();
    spawnMock.mockReturnValue(proc);

    const p = runYtDlp(["-J"], 10);
    await expect(p).rejects.toMatchObject({ kind: YtErrorKind.Timeout });
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("kills the whole process GROUP on timeout, not just yt-dlp (the pipe-holding grandchild)", async () => {
    // Killing only yt-dlp leaves the ffmpeg grandchild alive holding the inherited stdio pipes —
    // both a leaked process and the reason 'close' never fired. The child is spawned detached (its
    // own group leader) so the timeout can signal the ENTIRE group with process.kill(-pid).
    const proc = neverClosingProc();
    proc.pid = 4242;
    spawnMock.mockReturnValue(proc);
    const groupKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      await expect(runYtDlp(["-J"], 10)).rejects.toMatchObject({ kind: YtErrorKind.Timeout });
      expect(groupKill).toHaveBeenCalledWith(-4242, "SIGKILL");
      // Pin the spawn option that makes the group kill possible at all.
      expect(spawnMock).toHaveBeenCalledWith(
        "yt-dlp",
        ["-J"],
        expect.objectContaining({ detached: true, stdio: ["ignore", "pipe", "pipe"] }),
      );
    } finally {
      groupKill.mockRestore();
    }
  });

  it("settles from 'exit' when 'close' never arrives, keeping the output buffered so far", async () => {
    // Second independent settlement path: 'exit' fires the moment the process terminates even
    // while its pipes are still open. After a short grace period for a normal 'close' (which keeps
    // full output), the run settles anyway rather than hanging until the timeout — so a clean but
    // pipe-blocked run is not punished with a bogus Timeout minutes later.
    vi.useFakeTimers(); // afterEach restores real timers even if this test hangs
    const proc = neverClosingProc();
    spawnMock.mockReturnValue(proc);
    const p = runYtDlp(["-J"], 600_000); // timeout far away: only the exit path can settle this
    proc.stdout.push("done\n");
    proc.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toEqual({ stdout: "done\n", stderr: "", code: 0 });
  });

  it("the exit-grace settlement kills the process GROUP first, then goes silent (no late onLine)", async () => {
    // The exit-grace path only runs when 'close' never came after 'exit' — which means something we
    // spawned is STILL alive holding the inherited stdio pipes. Settling and walking away would
    // leak that orphan plus two fds on a station that never restarts, and its continuing output
    // would keep growing our buffers and firing onLine long after the caller moved on (the UI would
    // paint a phantom "downloading 99%" overlay over an already-playing track). So the group kill
    // and the pipe detach must happen BEFORE the promise settles — asserted here by ordering, not
    // just by "was kill called at some point".
    vi.useFakeTimers(); // afterEach restores real timers even if this test hangs
    const proc = neverClosingProc();
    proc.pid = 4242;
    spawnMock.mockReturnValue(proc);
    const order: string[] = [];
    const groupKill = vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: string) => {
      order.push(`kill ${pid} ${String(sig)}`);
      return true;
    }) as typeof process.kill);
    const lines: string[] = [];
    try {
      const p = runYtDlp(["-J"], 600_000, (l) => lines.push(l)).then((v) => {
        order.push("settled");
        return v;
      });
      proc.stdout.push("[download]  10.0%\n");
      await vi.advanceTimersByTimeAsync(0); // let that chunk reach the reader, as a real pipe would
      proc.emit("exit", 0); // process gone, pipes still held open by the grandchild
      await vi.advanceTimersByTimeAsync(5_000); // the grace period lapses with no 'close'

      await expect(p).resolves.toEqual({ stdout: "[download]  10.0%\n", stderr: "", code: 0 });
      expect(order).toEqual(["kill -4242 SIGKILL", "settled"]); // group killed BEFORE settling
      expect(lines).toEqual(["[download]  10.0%"]);
      // Our end of both pipes is dropped, so the surviving orphan holds neither fd.
      expect(proc.stdout.destroyed).toBe(true);
      expect(proc.stderr.destroyed).toBe(true);
      // …and anything the orphan still manages to emit is dropped: no onLine after settlement,
      // and nothing appended to the already-returned buffers.
      proc.stdout.emit("data", Buffer.from("[download]  99.9%\n"));
      proc.stderr.emit("data", Buffer.from("late stderr\n"));
      await vi.advanceTimersByTimeAsync(0);
      expect(lines).toEqual(["[download]  10.0%"]);
      await expect(p).resolves.toEqual({ stdout: "[download]  10.0%\n", stderr: "", code: 0 });
    } finally {
      groupKill.mockRestore();
    }
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

  it("SIGKILLs the child when child.stdout emits 'error' (no orphaned process leak)", async () => {
    // Regression: the stdout 'error' handler clears the timeout timer — the ONLY future
    // SIGKILL for the child. If a read error (EPIPE/ECONNRESET on the pipe) fires while
    // yt-dlp is still alive, without an explicit kill here the process is orphaned forever
    // (leaking a live child per occurrence on a station that runs indefinitely). The handler
    // must force-kill BEFORE rejecting so no error branch leaves a running child with no kill.
    const proc = new EventEmitter() as FakeProc;
    proc.stdout = new Readable({ read() {} }); // never ends, never 'close' — only the error path settles
    proc.stderr = new Readable({ read() {} });
    proc.kill = vi.fn();
    spawnMock.mockReturnValue(proc);

    const p = runYtDlp(["-J"], 1000);
    queueMicrotask(() => proc.stdout.emit("error", new Error("EPIPE")));
    await expect(p).rejects.toThrow(/EPIPE/);
    // SIGKILL is unignorable; a regression to no kill (or SIGTERM) would leave the child alive.
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
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
