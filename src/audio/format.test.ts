import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { chooseDelivery, transcodeToM4a, MIME_BY_EXT, TRANSCODE_CONTENT_TYPE } from "./format.js";
import type { AudioInfo } from "../types/index.js";

const opus: AudioInfo = { codec: "opus", bitrateKbps: 160, sampleRateHz: 48000 };
const aac: AudioInfo = { codec: "mp4a.40.2", bitrateKbps: 128, sampleRateHz: 44100 };
const mp3: AudioInfo = { codec: "mp3", bitrateKbps: 128, sampleRateHz: 44100 };

describe("chooseDelivery", () => {
  it("serves opus/webm as-is with audio/webm", () => {
    expect(chooseDelivery(opus, "webm")).toEqual({
      contentType: "audio/webm",
      needsTranscode: false,
    });
  });

  it("serves opus in an .opus/.ogg container as audio/ogg as-is", () => {
    expect(chooseDelivery(opus, "opus")).toEqual({
      contentType: "audio/ogg",
      needsTranscode: false,
    });
    expect(chooseDelivery(opus, "ogg")).toEqual({
      contentType: "audio/ogg",
      needsTranscode: false,
    });
  });

  it("serves aac/m4a (and aac/mp4) as-is with audio/mp4", () => {
    expect(chooseDelivery(aac, "m4a")).toEqual({
      contentType: "audio/mp4",
      needsTranscode: false,
    });
    expect(chooseDelivery(aac, "mp4")).toEqual({
      contentType: "audio/mp4",
      needsTranscode: false,
    });
  });

  it("transcodes mp3 to audio/mp4 even though mp3 is in an mp3 container", () => {
    expect(chooseDelivery(mp3, "mp3")).toEqual({
      contentType: TRANSCODE_CONTENT_TYPE,
      needsTranscode: true,
    });
  });

  it("transcodes a playable codec stuck in a mismatched/unknown container", () => {
    // opus codec but the file landed as .m4a -> not a clean opus container -> transcode
    expect(chooseDelivery(opus, "m4a")).toEqual({
      contentType: TRANSCODE_CONTENT_TYPE,
      needsTranscode: true,
    });
    // aac codec in a webm container -> transcode
    expect(chooseDelivery(aac, "webm")).toEqual({
      contentType: TRANSCODE_CONTENT_TYPE,
      needsTranscode: true,
    });
  });

  it("transcodes when AudioInfo is null (format unknown — can't prove safe)", () => {
    expect(chooseDelivery(null, "webm")).toEqual({
      contentType: TRANSCODE_CONTENT_TYPE,
      needsTranscode: true,
    });
  });

  it("is case-insensitive on the extension (leading dot tolerated)", () => {
    expect(chooseDelivery(opus, ".WEBM")).toEqual({
      contentType: "audio/webm",
      needsTranscode: false,
    });
  });

  it("exposes the MIME map and transcode constant", () => {
    expect(MIME_BY_EXT.webm).toBe("audio/webm");
    expect(MIME_BY_EXT.m4a).toBe("audio/mp4");
    expect(TRANSCODE_CONTENT_TYPE).toBe("audio/mp4");
  });
});

describe("transcodeToM4a", () => {
  function fakeFf(exitCode: number) {
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const spawnFn = vi.fn((_cmd: string, _args: readonly string[], _opts?: unknown) => {
      // resolve/reject on the next tick so listeners are attached first
      queueMicrotask(() => {
        child.stderr.emit("data", Buffer.from("ffmpeg log line\n"));
        child.emit("close", exitCode);
      });
      return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
    });
    return { child, spawnFn };
  }

  it("invokes ffmpeg with -c:a aac, faststart, mp4 muxer and resolves on exit 0", async () => {
    const { spawnFn } = fakeFf(0);
    await expect(
      transcodeToM4a("/in/a.mp3", "/out/a.m4a", spawnFn as never),
    ).resolves.toBeUndefined();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnFn.mock.calls[0]!;
    expect(cmd).toBe("ffmpeg");
    const a = args as string[];
    expect(a).toEqual(expect.arrayContaining(["-i", "/in/a.mp3", "/out/a.m4a"]));
    expect(a).toEqual(expect.arrayContaining(["-c:a", "aac"]));
    expect(a).toEqual(expect.arrayContaining(["-movflags", "+faststart"]));
    expect(a).toEqual(expect.arrayContaining(["-f", "mp4"]));
    expect(a).toContain("-vn");
  });

  it("rejects with the ffmpeg stderr tail on a non-zero exit", async () => {
    const { spawnFn } = fakeFf(1);
    await expect(transcodeToM4a("/in/a.mp3", "/out/a.m4a", spawnFn as never)).rejects.toThrow(
      /ffmpeg/i,
    );
  });

  it("kills a hung ffmpeg and rejects on timeout (no slot-leaking pending Promise)", async () => {
    // A child that never emits 'close'/'error' models a stalled ffmpeg. Without the timeout
    // the Promise would hang forever and the caller's Semaphore slot would leak. With it, the
    // child is force-killed and the Promise rejects so the slot is released.
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const spawnFn = vi.fn(
      () => child as unknown as ReturnType<typeof import("node:child_process").spawn>,
    );

    await expect(transcodeToM4a("/in/a.mp3", "/out/a.m4a", spawnFn as never, 5)).rejects.toThrow(
      /timed out/i,
    );
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("does not kill or reject when ffmpeg closes before the timeout", async () => {
    // Guards the `settled` flag: a normal close must clear the timer so it never fires kill().
    const { child, spawnFn } = fakeFf(0);
    const killSpy = vi.fn();
    child.kill = killSpy;
    await expect(
      transcodeToM4a("/in/a.mp3", "/out/a.m4a", spawnFn as never, 50),
    ).resolves.toBeUndefined();
    expect(killSpy).not.toHaveBeenCalled();
  });
});
