import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runMock = vi.hoisted(() => vi.fn());
vi.mock("./ytdlp.js", () => ({ runYtDlp: runMock }));

import {
  YouTubeService,
  parseAudioInfo,
  buildClientLadder,
  parseDownloadProgress,
  scaleDownloadTimeout,
  DOWNLOAD_PROGRESS_TEMPLATE,
} from "./index.js";
import { YtErrorKind } from "./errors.js";
import { loadMediaConfig } from "../config.js";

const cfg = loadMediaConfig({ MAX_TRACK_DURATION_SEC: "3600" });

function ok(stdout: string) {
  return { stdout, stderr: "", code: 0 };
}

describe("YouTubeService.resolve", () => {
  beforeEach(() => runMock.mockReset());

  it("maps yt-dlp -J output to TrackMeta", async () => {
    runMock.mockResolvedValue(
      ok(
        JSON.stringify({
          id: "dQw4w9WgXcQ",
          title: "Song",
          channel: "Chan",
          duration: 200,
          is_live: false,
          thumbnail: "http://t",
        }),
      ),
    );
    const svc = new YouTubeService(cfg);
    const meta = await svc.resolve("dQw4w9WgXcQ");
    expect(meta).toEqual({
      videoId: "dQw4w9WgXcQ",
      title: "Song",
      channel: "Chan",
      durationSec: 200,
      isLive: false,
      thumbnailUrl: "http://t",
    });
    // resolve uses -J --no-playlist on the canonical watch URL
    const args = runMock.mock.calls[0]![0] as string[];
    expect(args).toContain("-J");
    expect(args).toContain("--no-playlist");
    expect(args[args.length - 1]).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("passes the bgutil PO-token base_url extractor-arg when configured", async () => {
    runMock.mockResolvedValue(ok(JSON.stringify({ id: "dQw4w9WgXcQ", title: "S", duration: 10 })));
    const potCfg = loadMediaConfig({
      MAX_TRACK_DURATION_SEC: "3600",
      PO_TOKEN_PROVIDER_URL: "http://bgutil-pot:4416",
    });
    await new YouTubeService(potCfg).resolve("dQw4w9WgXcQ");
    const args = runMock.mock.calls[0]![0] as string[];
    expect(args).toContain("youtubepot-bgutilhttp:base_url=http://bgutil-pot:4416");
  });

  it("omits the bgutil extractor-arg when PO_TOKEN_PROVIDER_URL is unset", async () => {
    runMock.mockResolvedValue(ok(JSON.stringify({ id: "dQw4w9WgXcQ", title: "S", duration: 10 })));
    await new YouTubeService(cfg).resolve("dQw4w9WgXcQ");
    const args = runMock.mock.calls[0]![0] as string[];
    expect(args.some((a) => a.startsWith("youtubepot-bgutilhttp:"))).toBe(false);
  });

  it("falls back to uploader and Unknown channel, null duration", async () => {
    runMock.mockResolvedValue(
      ok(JSON.stringify({ id: "dQw4w9WgXcQ", title: "S", uploader: "Up" })),
    );
    const meta = await new YouTubeService(cfg).resolve("dQw4w9WgXcQ");
    expect(meta.channel).toBe("Up");
    expect(meta.durationSec).toBeNull();
  });

  it("throws Live for a live video", async () => {
    runMock.mockResolvedValue(
      ok(JSON.stringify({ id: "dQw4w9WgXcQ", title: "L", live_status: "is_live" })),
    );
    await expect(new YouTubeService(cfg).resolve("dQw4w9WgXcQ")).rejects.toMatchObject({
      kind: YtErrorKind.Live,
    });
  });

  it("throws Live for an upcoming video", async () => {
    runMock.mockResolvedValue(
      ok(JSON.stringify({ id: "dQw4w9WgXcQ", title: "U", live_status: "is_upcoming" })),
    );
    await expect(new YouTubeService(cfg).resolve("dQw4w9WgXcQ")).rejects.toMatchObject({
      kind: YtErrorKind.Live,
    });
  });

  it("throws TooLong over the global config sanity ceiling", async () => {
    // The configured MAX_TRACK_DURATION_SEC (3600 here) is an ABSOLUTE sanity ceiling
    // enforced in resolve. A 4000s track still exceeds this 3600s ceiling.
    runMock.mockResolvedValue(
      ok(JSON.stringify({ id: "dQw4w9WgXcQ", title: "X", duration: 4000 })),
    );
    await expect(new YouTubeService(cfg).resolve("dQw4w9WgXcQ")).rejects.toMatchObject({
      kind: YtErrorKind.TooLong,
    });
  });

  it("does NOT reject on the global ceiling when it is unset (null) — any length resolves", async () => {
    // With MAX_TRACK_DURATION_SEC unset, resolve imposes no ceiling.
    // A 3h track resolves cleanly here.
    const noCeilCfg = loadMediaConfig({});
    runMock.mockResolvedValue(
      ok(JSON.stringify({ id: "dQw4w9WgXcQ", title: "Concert", duration: 10800 })),
    );
    const meta = await new YouTubeService(noCeilCfg).resolve("dQw4w9WgXcQ");
    expect(meta.durationSec).toBe(10800);
  });

  it("treats MAX_TRACK_DURATION_SEC=0 as no ceiling (does not throw TooLong)", async () => {
    // 0 normalizes to null at the config layer, so a long track must resolve, not be rejected.
    const zeroCfg = loadMediaConfig({ MAX_TRACK_DURATION_SEC: "0" });
    runMock.mockResolvedValue(
      ok(JSON.stringify({ id: "dQw4w9WgXcQ", title: "Long", duration: 7200 })),
    );
    const meta = await new YouTubeService(zeroCfg).resolve("dQw4w9WgXcQ");
    expect(meta.durationSec).toBe(7200);
  });

  it("classifies a non-zero exit", async () => {
    runMock.mockResolvedValue({ stdout: "", stderr: "ERROR: Private video", code: 1 });
    await expect(new YouTubeService(cfg).resolve("dQw4w9WgXcQ")).rejects.toMatchObject({
      kind: YtErrorKind.Private,
    });
  });

  it("rejects a non-video id (playlist/Mix/channel) with a clear reason, never spawning yt-dlp", async () => {
    // A search/picker entry that is a Mix or playlist carries an id like "RDdQw4w9WgXcQ"
    // (not an 11-char video id). resolve must reject it up-front rather than hand a bogus
    // URL to yt-dlp (which would fail with an opaque error).
    await expect(new YouTubeService(cfg).resolve("RDdQw4w9WgXcQ")).rejects.toMatchObject({
      kind: YtErrorKind.Unavailable,
    });
    await expect(new YouTubeService(cfg).resolve("PLsomeplaylist")).rejects.toMatchObject({
      kind: YtErrorKind.Unavailable,
    });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("retries the next player client when the first throws a retryable error, then succeeds", async () => {
    // android_vr (first configured client) hits a PO-token/SABR extraction break; the
    // ladder must fall through to web_embedded and succeed.
    runMock
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "ERROR: Only images are available for download; use --list-formats",
        code: 1,
      })
      .mockResolvedValueOnce(ok(JSON.stringify({ id: "dQw4w9WgXcQ", title: "Back in Black" })));
    const meta = await new YouTubeService(cfg).resolve("dQw4w9WgXcQ");
    expect(meta.title).toBe("Back in Black");
    expect(runMock).toHaveBeenCalledTimes(2);
    const firstArgs = runMock.mock.calls[0]![0] as string[];
    const secondArgs = runMock.mock.calls[1]![0] as string[];
    const clientOf = (args: string[]) => {
      const i = args.indexOf("--extractor-args");
      return args[i + 1];
    };
    // first client is the head of the configured ladder; second is a distinct fallback.
    expect(clientOf(firstArgs)).toBe("youtube:player_client=android_vr");
    expect(clientOf(secondArgs)).not.toBe(clientOf(firstArgs));
  });

  it("stops the ladder immediately on a terminal error (no client swap can help)", async () => {
    runMock.mockResolvedValue({ stdout: "", stderr: "ERROR: Private video", code: 1 });
    await expect(new YouTubeService(cfg).resolve("dQw4w9WgXcQ")).rejects.toMatchObject({
      kind: YtErrorKind.Private,
    });
    // Private is terminal — must NOT burn through every fallback client.
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces the LAST client's error when every client fails", async () => {
    runMock.mockResolvedValue({
      stdout: "",
      stderr: "ERROR: Sign in to confirm you're not a bot. Your IP is likely being blocked",
      code: 1,
    });
    await expect(new YouTubeService(cfg).resolve("dQw4w9WgXcQ")).rejects.toMatchObject({
      kind: YtErrorKind.IpBlocked,
    });
    // Tried the WHOLE de-duplicated ladder — pin the exact count so an early-abort
    // regression in withClientFallback / isRetryableAcrossClients fails the test.
    expect(runMock).toHaveBeenCalledTimes(buildClientLadder(cfg.playerClients).length);
  });

  it("classifies non-JSON stdout on a zero-exit as a YtError(Unknown), not a raw SyntaxError", async () => {
    // yt-dlp exits 0 but emits truncated/empty stdout — JSON.parse would throw a
    // SyntaxError. resolve must surface a typed YtError(Unknown) instead.
    runMock.mockResolvedValue(ok("not json at all"));
    await expect(new YouTubeService(cfg).resolve("dQw4w9WgXcQ")).rejects.toMatchObject({
      kind: YtErrorKind.Unknown,
    });
    // INTENTIONAL: a non-JSON zero-exit is classified as Unknown, which is retryable, so the
    // WHOLE client ladder is exhausted before surfacing the failure. The rationale is that a
    // truncated/empty stdout is often a transient per-client extraction hiccup that a
    // different player_client recovers from (the same reason resolve()/download() retry).
    // Pin the count so this behavior can't silently change to either 1 (short-circuit) or
    // some partial run.
    expect(runMock).toHaveBeenCalledTimes(buildClientLadder(cfg.playerClients).length);
  });
});

describe("YouTubeService.search", () => {
  beforeEach(() => runMock.mockReset());

  it("maps flat entries, tolerating missing channel/duration", async () => {
    runMock.mockResolvedValue(
      ok(
        JSON.stringify({
          entries: [
            { id: "aaaaaaaaaaa", title: "A", channel: "C", duration: 100 },
            { id: "bbbbbbbbbbb", title: "B" }, // missing channel + duration
          ],
        }),
      ),
    );
    const res = await new YouTubeService(cfg).search("q", 2);
    expect(res).toHaveLength(2);
    expect(res[1]).toEqual({
      videoId: "bbbbbbbbbbb",
      title: "B",
      channel: "Unknown",
      durationSec: null,
      isLive: false,
      thumbnailUrl: null,
    });
    const args = runMock.mock.calls[0]![0] as string[];
    expect(args[args.length - 1]).toBe("ytsearch2:q");
    expect(args).toContain("--flat-playlist");
  });

  it("populates thumbnailUrl from the flat-playlist `thumbnails` array (no single `thumbnail`)", async () => {
    // --flat-playlist search entries expose a `thumbnails` array, NOT a single `thumbnail`.
    runMock.mockResolvedValue(
      ok(
        JSON.stringify({
          entries: [
            {
              id: "aaaaaaaaaaa",
              title: "A",
              thumbnails: [
                { url: "http://small", height: 90, width: 120 },
                { url: "http://large", height: 404, width: 720 },
              ],
            },
          ],
        }),
      ),
    );
    const res = await new YouTubeService(cfg).search("q", 1);
    // Prefers the highest-resolution thumbnail in the array.
    expect(res[0]!.thumbnailUrl).toBe("http://large");
  });

  it("prefers a single `thumbnail` field when present", async () => {
    runMock.mockResolvedValue(
      ok(
        JSON.stringify({
          entries: [
            {
              id: "aaaaaaaaaaa",
              title: "A",
              thumbnail: "http://single",
              thumbnails: [{ url: "http://arr" }],
            },
          ],
        }),
      ),
    );
    const res = await new YouTubeService(cfg).search("q", 1);
    expect(res[0]!.thumbnailUrl).toBe("http://single");
  });

  it("throws a YtError(Unknown) on non-JSON stdout instead of a raw SyntaxError", async () => {
    // A non-JSON zero-exit stdout must become a typed domain error so callers can
    // message it, rather than letting a SyntaxError escape to the framework.
    runMock.mockResolvedValue(ok("<<<not json>>>"));
    await expect(new YouTubeService(cfg).search("q", 1)).rejects.toMatchObject({
      kind: YtErrorKind.Unknown,
    });
  });
});

describe("YouTubeService.related", () => {
  beforeEach(() => runMock.mockReset());

  it("fetches the RD<id> mix as a flat-playlist and maps entries, skipping the seed id", async () => {
    runMock.mockResolvedValue(
      ok(
        JSON.stringify({
          entries: [
            { id: "seedaaaaaaa", title: "Seed" }, // the seed itself — must be skipped
            { id: "bbbbbbbbbbb", title: "B", channel: "C", duration: 120 },
            { id: "ccccccccccc", title: "C" }, // missing channel/duration tolerated
          ],
        }),
      ),
    );
    const res = await new YouTubeService(cfg).related("seedaaaaaaa");
    expect(res.map((r) => r.videoId)).toEqual(["bbbbbbbbbbb", "ccccccccccc"]);
    expect(res[1]).toEqual({
      videoId: "ccccccccccc",
      title: "C",
      channel: "Unknown",
      durationSec: null,
      isLive: false,
      thumbnailUrl: null,
    });

    const args = runMock.mock.calls[0]![0] as string[];
    expect(args).toContain("--flat-playlist");
    // Targets YouTube's Mix/radio list for the seed video.
    expect(args[args.length - 1]).toBe(
      "https://www.youtube.com/watch?v=seedaaaaaaa&list=RDseedaaaaaaa",
    );
  });

  it("de-duplicates repeated entries", async () => {
    runMock.mockResolvedValue(
      ok(
        JSON.stringify({
          entries: [
            { id: "bbbbbbbbbbb", title: "B" },
            { id: "bbbbbbbbbbb", title: "B again" },
            { id: "ccccccccccc", title: "C" },
          ],
        }),
      ),
    );
    const res = await new YouTubeService(cfg).related("seedaaaaaaa");
    expect(res.map((r) => r.videoId)).toEqual(["bbbbbbbbbbb", "ccccccccccc"]);
  });

  it("returns [] on a non-zero exit instead of throwing (autoplay is best-effort)", async () => {
    // EVERY client fails (retryable extraction error), so the whole ladder is exhausted and
    // the best-effort contract resolves to []. Pin the count to prove the ladder was tried.
    runMock.mockResolvedValue({
      stdout: "",
      stderr: "ERROR: nsig extraction failed: Some formats may be missing",
      code: 1,
    });
    await expect(new YouTubeService(cfg).related("seedaaaaaaa")).resolves.toEqual([]);
    expect(runMock).toHaveBeenCalledTimes(buildClientLadder(cfg.playerClients).length);
  });

  it("retries across the client ladder when the first client yields a retryable error", async () => {
    // First-client breakage (the exact scenario the ladder exists for) must NOT permanently
    // disable autoplay radio: related() advances to the next client and succeeds.
    runMock
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "ERROR: nsig extraction failed: Some formats may be missing",
        code: 1,
      })
      .mockResolvedValueOnce(ok(JSON.stringify({ entries: [{ id: "bbbbbbbbbbb", title: "B" }] })));
    const res = await new YouTubeService(cfg).related("seedaaaaaaa");
    expect(res.map((r) => r.videoId)).toEqual(["bbbbbbbbbbb"]);
    expect(runMock).toHaveBeenCalledTimes(2);
    const clientOf = (args: string[]) => args[args.indexOf("--extractor-args") + 1];
    const c1 = clientOf(runMock.mock.calls[0]![0] as string[]);
    const c2 = clientOf(runMock.mock.calls[1]![0] as string[]);
    expect(c2).not.toBe(c1);
  });

  it("returns [] when the mix has no entries", async () => {
    runMock.mockResolvedValue(ok(JSON.stringify({})));
    await expect(new YouTubeService(cfg).related("seedaaaaaaa")).resolves.toEqual([]);
  });

  it("returns [] (never throws) when the runner itself rejects", async () => {
    // A runner-level rejection (spawn ENOENT, timeout YtError) must honor the documented
    // best-effort contract and resolve to [], mirroring artistTracks().
    runMock.mockImplementationOnce(() => Promise.reject(new Error("spawn failed")));
    await expect(new YouTubeService(cfg).related("seedaaaaaaa")).resolves.toEqual([]);
  });
});

describe("YouTubeService.artistTracks", () => {
  beforeEach(() => runMock.mockReset());

  const seed = {
    videoId: "seedaaaaaaa",
    title: "Seed Song",
    channel: "Some Artist",
    durationSec: 200,
    isLive: false,
    thumbnailUrl: null,
  } as const;

  it("searches YouTube for more songs by the seed's channel and maps entries, skipping the seed id", async () => {
    runMock.mockResolvedValue(
      ok(
        JSON.stringify({
          entries: [
            { id: "seedaaaaaaa", title: "Seed Song" }, // the seed itself — must be skipped
            { id: "bbbbbbbbbbb", title: "B", channel: "Some Artist", duration: 120 },
            { id: "ccccccccccc", title: "C" },
          ],
        }),
      ),
    );
    const res = await new YouTubeService(cfg).artistTracks(seed);
    expect(res.map((r) => r.videoId)).toEqual(["bbbbbbbbbbb", "ccccccccccc"]);

    const args = runMock.mock.calls[0]![0] as string[];
    expect(args).toContain("--flat-playlist");
    // The query is a ytsearchN: targeting the seed's channel/artist name.
    const query = args[args.length - 1] as string;
    expect(query).toMatch(/^ytsearch\d+:/);
    expect(query).toContain("Some Artist");
  });

  it("de-duplicates repeated entries", async () => {
    runMock.mockResolvedValue(
      ok(
        JSON.stringify({
          entries: [
            { id: "bbbbbbbbbbb", title: "B" },
            { id: "bbbbbbbbbbb", title: "B again" },
            { id: "ccccccccccc", title: "C" },
          ],
        }),
      ),
    );
    const res = await new YouTubeService(cfg).artistTracks(seed);
    expect(res.map((r) => r.videoId)).toEqual(["bbbbbbbbbbb", "ccccccccccc"]);
  });

  it("returns [] (never throws) on a non-zero exit", async () => {
    runMock.mockResolvedValue({ stdout: "", stderr: "ERROR: nope", code: 1 });
    await expect(new YouTubeService(cfg).artistTracks(seed)).resolves.toEqual([]);
  });

  it("returns [] (never throws) when the runner itself rejects", async () => {
    runMock.mockImplementationOnce(() => Promise.reject(new Error("spawn failed")));
    await expect(new YouTubeService(cfg).artistTracks(seed)).resolves.toEqual([]);
  });

  it("returns [] when the search has no entries", async () => {
    runMock.mockResolvedValue(ok(JSON.stringify({})));
    await expect(new YouTubeService(cfg).artistTracks(seed)).resolves.toEqual([]);
  });

  it("returns [] without calling yt-dlp when the channel is missing/unknown", async () => {
    const res = await new YouTubeService(cfg).artistTracks({ ...seed, channel: "Unknown" });
    expect(res).toEqual([]);
    expect(runMock).not.toHaveBeenCalled();
  });
});

describe("YouTubeService.download", () => {
  beforeEach(() => runMock.mockReset());

  it("returns the produced file path and parsed audio format", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yt-"));
    await writeFile(join(dir, "dQw4w9WgXcQ.webm"), "fakeaudio");
    runMock.mockResolvedValue(ok("AUDIOFMT::opus|160|165|48000\n"));
    const res = await new YouTubeService(cfg).download("dQw4w9WgXcQ", dir);
    expect(res.path).toBe(join(dir, "dQw4w9WgXcQ.webm"));
    expect(res.audio).toEqual({ codec: "opus", bitrateKbps: 160, sampleRateHz: 48000 });
    const args = runMock.mock.calls[0]![0] as string[];
    expect(args).toContain("-f");
    expect(args).toContain("bestaudio[acodec=opus]/bestaudio/best");
    expect(args).toContain("--no-playlist");
    expect(args).toContain("--");
    // requests the real format via a post-download --print
    expect(args).toContain("--print");
    const printIdx = args.indexOf("--print");
    expect(args[printIdx + 1]).toContain("after_move:");
    expect(args[printIdx + 1]).toContain("%(acodec)s");
    expect(args[args.length - 1]).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(args).not.toContain("--sponsorblock-remove");
  });

  it("returns null audio when yt-dlp prints no usable format", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yt-"));
    await writeFile(join(dir, "dQw4w9WgXcQ.webm"), "fakeaudio");
    runMock.mockResolvedValue(ok(""));
    const res = await new YouTubeService(cfg).download("dQw4w9WgXcQ", dir);
    expect(res.path).toBe(join(dir, "dQw4w9WgXcQ.webm"));
    expect(res.audio).toBeNull();
  });

  it("throws a classified YtError(Unknown) when yt-dlp succeeds but no file is produced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yt-"));
    runMock.mockResolvedValue(ok(""));
    // Pin the classified domain-error contract (not just "something threw"): the production
    // path throws YtError(YtErrorKind.Unknown, "download completed but no file…").
    await expect(new YouTubeService(cfg).download("dQw4w9WgXcQ", dir)).rejects.toMatchObject({
      kind: YtErrorKind.Unknown,
    });
  });

  it("never selects a partial `.part` artifact, even when it sorts first in readdir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yt-"));
    // Seed a stale partial from a previously-killed attempt FIRST (so it sorts ahead on most
    // filesystems), then the real finalized file. download() must return the finalized one.
    await writeFile(join(dir, "dQw4w9WgXcQ.webm.part"), "partialgarbage");
    await writeFile(join(dir, "dQw4w9WgXcQ.opus"), "fakeaudio");
    runMock.mockResolvedValue(ok("AUDIOFMT::opus|160|165|48000\n"));
    const res = await new YouTubeService(cfg).download("dQw4w9WgXcQ", dir);
    expect(res.path).toBe(join(dir, "dQw4w9WgXcQ.opus"));
    // And it passes --no-part so future attempts don't even create a .part artifact.
    const args = runMock.mock.calls[0]![0] as string[];
    expect(args).toContain("--no-part");
  });

  it("never selects the stale `.transcoded.m4a` sibling as the produced source file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yt-"));
    // A stale transcode from a prior play (the audio route writes it into this same cacheDir)
    // that persisted after the source was evicted, then the freshly-downloaded source. It also
    // matches `${id}.` and none of the .part/.ytdl/.temp suffixes, so the bare predicate could
    // return it; download() must pick the fresh source instead.
    await writeFile(join(dir, "dQw4w9WgXcQ.transcoded.m4a"), "STALE-TRANSCODE");
    await writeFile(join(dir, "dQw4w9WgXcQ.opus"), "fresh-source");
    runMock.mockResolvedValue(ok("AUDIOFMT::opus|160|165|48000\n"));
    const res = await new YouTubeService(cfg).download("dQw4w9WgXcQ", dir);
    expect(res.path).toBe(join(dir, "dQw4w9WgXcQ.opus"));
  });

  it("falls back to the next player client when the first download fails, then succeeds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yt-"));
    await writeFile(join(dir, "dQw4w9WgXcQ.webm"), "fakeaudio");
    runMock
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "ERROR: nsig extraction failed: Some formats may be missing",
        code: 1,
      })
      .mockResolvedValueOnce(ok("AUDIOFMT::opus|160|165|48000\n"));
    const res = await new YouTubeService(cfg).download("dQw4w9WgXcQ", dir);
    expect(res.path).toBe(join(dir, "dQw4w9WgXcQ.webm"));
    expect(res.audio).toEqual({ codec: "opus", bitrateKbps: 160, sampleRateHz: 48000 });
    expect(runMock).toHaveBeenCalledTimes(2);
    const clientOf = (args: string[]) => args[args.indexOf("--extractor-args") + 1];
    const c1 = clientOf(runMock.mock.calls[0]![0] as string[]);
    const c2 = clientOf(runMock.mock.calls[1]![0] as string[]);
    expect(c1).toBe("youtube:player_client=android_vr");
    expect(c2).not.toBe(c1);
  });
});

describe("parseAudioInfo", () => {
  it("parses codec, abr (preferred bitrate), and asr", () => {
    expect(parseAudioInfo("AUDIOFMT::opus|160|200|48000")).toEqual({
      codec: "opus",
      bitrateKbps: 160,
      sampleRateHz: 48000,
    });
  });

  it("falls back to tbr when abr is NA", () => {
    expect(parseAudioInfo("AUDIOFMT::aac|NA|129.5|44100")).toEqual({
      codec: "aac",
      bitrateKbps: 130, // rounded tbr
      sampleRateHz: 44100,
    });
  });

  it("locates the marker line amid other stdout", () => {
    const out = "[download] 100%\nsome noise\nAUDIOFMT::mp4a.40.2|128|130|44100\n";
    expect(parseAudioInfo(out)).toEqual({
      codec: "mp4a.40.2",
      bitrateKbps: 128,
      sampleRateHz: 44100,
    });
  });

  it("returns null when codec is missing/NA", () => {
    expect(parseAudioInfo("AUDIOFMT::NA|NA|NA|NA")).toBeNull();
    expect(parseAudioInfo("AUDIOFMT::none|1|1|1")).toBeNull();
  });

  it("returns null when the marker is absent", () => {
    expect(parseAudioInfo("nothing here\n[download] done")).toBeNull();
  });

  it("zeroes numeric fields that are unparseable but keeps the codec", () => {
    expect(parseAudioInfo("AUDIOFMT::opus|NA|NA|NA")).toEqual({
      codec: "opus",
      bitrateKbps: 0,
      sampleRateHz: 0,
    });
  });
});

describe("parseDownloadProgress", () => {
  it("parses the templated 'download:PCT|DL|TOTAL' line", () => {
    expect(parseDownloadProgress("download: 45.2%|110100480|210000000")).toEqual({
      percent: 45.2,
      downloadedBytes: 110100480,
      totalBytes: 210000000,
    });
  });

  it("trims whitespace and a trailing % yt-dlp pads into the field", () => {
    expect(parseDownloadProgress("download:  5.0%|512|10240")).toMatchObject({ percent: 5 });
  });

  it("returns percent even when byte counts are 'NA' (unknown total)", () => {
    const p = parseDownloadProgress("download: 12.5%|NA|NA");
    expect(p?.percent).toBe(12.5);
    expect(p?.downloadedBytes).toBeUndefined();
    expect(p?.totalBytes).toBeUndefined();
  });

  it("clamps percent into [0,100]", () => {
    expect(parseDownloadProgress("download: 120.0%|1|1")?.percent).toBe(100);
    expect(parseDownloadProgress("download: -3.0%|1|1")?.percent).toBe(0);
  });

  it("returns null for a line without the download: marker", () => {
    expect(parseDownloadProgress("[info] Writing thumbnail")).toBeNull();
    expect(parseDownloadProgress("AUDIOFMT::opus|160|165|48000")).toBeNull();
  });

  it("returns null for a malformed download line (no percent)", () => {
    expect(parseDownloadProgress("download: foo|bar|baz")).toBeNull();
  });
});

describe("scaleDownloadTimeout", () => {
  const BASE = 60_000;
  it("returns the configured base for a short track", () => {
    // 200s of audio * 2000ms ≈ 400_000 > base, so it actually scales up even here…
    // a TRULY short track (≤30s) stays at base.
    expect(scaleDownloadTimeout(BASE, 10)).toBe(BASE);
  });

  it("scales up for a long track (≈2s budget per audio second)", () => {
    // A 2.5h mix = 9000s → 9000*2000 = 18_000_000ms, but capped at the 30-min ceiling.
    const t = scaleDownloadTimeout(BASE, 9000);
    expect(t).toBe(30 * 60_000); // hard cap
    expect(t).toBeGreaterThan(BASE);
  });

  it("scales proportionally below the cap", () => {
    // 120s * 2000 = 240_000ms, under both the cap and obviously above base.
    expect(scaleDownloadTimeout(BASE, 120)).toBe(240_000);
  });

  it("never drops below the configured base (honors a larger configured value)", () => {
    // A generously-configured base wins over a small computed budget.
    expect(scaleDownloadTimeout(600_000, 30)).toBe(600_000);
  });

  it("treats null/unknown duration as the base (no scaling)", () => {
    expect(scaleDownloadTimeout(BASE, null)).toBe(BASE);
    expect(scaleDownloadTimeout(BASE, undefined)).toBe(BASE);
  });

  it("caps at 30 minutes even if the configured base is somehow higher", () => {
    // The cap is the max of (base, ceiling) so a base above the ceiling still wins —
    // we never SHRINK an operator's explicit base, only refuse to scale ABOVE the cap.
    expect(scaleDownloadTimeout(40 * 60_000, 9000)).toBe(40 * 60_000);
  });
});

describe("YouTubeService.download progress + timeout", () => {
  beforeEach(() => runMock.mockReset());

  it("passes --newline + --progress-template and reports parsed percents via onProgress", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yt-"));
    await writeFile(join(dir, "dQw4w9WgXcQ.webm"), "fakeaudio");
    // The mock plays back yt-dlp's streamed progress lines through onLine (3rd arg),
    // then resolves with the post-download AUDIOFMT print.
    runMock.mockImplementation(
      async (_args: string[], _timeout: number, onLine?: (l: string) => void) => {
        onLine?.("download:  0.0%|0|210000000");
        onLine?.("download: 45.2%|94920000|210000000");
        onLine?.("download: 100.0%|210000000|210000000");
        return ok("AUDIOFMT::opus|160|165|48000\n");
      },
    );
    const seen: number[] = [];
    const res = await new YouTubeService(cfg).download("dQw4w9WgXcQ", dir, {
      durationSec: 200,
      onProgress: (p) => seen.push(p.percent),
    });
    expect(res.path).toBe(join(dir, "dQw4w9WgXcQ.webm"));
    expect(seen).toEqual([0, 45.2, 100]);
    const args = runMock.mock.calls[0]![0] as string[];
    expect(args).toContain("--newline");
    expect(args).toContain("--progress-template");
    const tIdx = args.indexOf("--progress-template");
    expect(args[tIdx + 1]).toBe(DOWNLOAD_PROGRESS_TEMPLATE);
    // It must NOT suppress progress (the old path passed --no-progress).
    expect(args).not.toContain("--no-progress");
  });

  it("ignores malformed progress lines without breaking the download", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yt-"));
    await writeFile(join(dir, "dQw4w9WgXcQ.webm"), "fakeaudio");
    runMock.mockImplementation(
      async (_args: string[], _timeout: number, onLine?: (l: string) => void) => {
        onLine?.("[info] some noise");
        onLine?.("download: garbage line");
        onLine?.("download: 50.0%|1|2");
        return ok("");
      },
    );
    const seen: number[] = [];
    const res = await new YouTubeService(cfg).download("dQw4w9WgXcQ", dir, {
      onProgress: (p) => seen.push(p.percent),
    });
    expect(res.path).toBe(join(dir, "dQw4w9WgXcQ.webm"));
    expect(seen).toEqual([50]); // only the one well-formed line fired
  });

  it("auto-scales the timeout by track duration (long → larger, capped)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yt-"));
    await writeFile(join(dir, "dQw4w9WgXcQ.webm"), "fakeaudio");
    runMock.mockResolvedValue(ok(""));
    // base 60s → for a 9000s (2.5h) mix the effective timeout is the 30-min cap.
    await new YouTubeService(cfg).download("dQw4w9WgXcQ", dir, { durationSec: 9000 });
    const timeoutArg = runMock.mock.calls[0]![1] as number;
    expect(timeoutArg).toBe(30 * 60_000);
  });

  it("uses the base timeout for a short track", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yt-"));
    await writeFile(join(dir, "dQw4w9WgXcQ.webm"), "fakeaudio");
    runMock.mockResolvedValue(ok(""));
    await new YouTubeService(cfg).download("dQw4w9WgXcQ", dir, { durationSec: 10 });
    expect(runMock.mock.calls[0]![1] as number).toBe(cfg.ytdlpTimeoutMs);
  });

  it("still works with no options (back-compat: base timeout, no onProgress)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yt-"));
    await writeFile(join(dir, "dQw4w9WgXcQ.webm"), "fakeaudio");
    runMock.mockResolvedValue(ok(""));
    const res = await new YouTubeService(cfg).download("dQw4w9WgXcQ", dir);
    expect(res.path).toBe(join(dir, "dQw4w9WgXcQ.webm"));
    expect(runMock.mock.calls[0]![1] as number).toBe(cfg.ytdlpTimeoutMs);
  });
});

describe("client ladder", () => {
  it("defaults to android_vr,web_embedded,tv first — never web/mweb-first (spec §8)", () => {
    const ladder = buildClientLadder("android_vr,web_embedded,tv");
    expect(ladder.slice(0, 3)).toEqual(["android_vr", "web_embedded", "tv"]);
    expect(ladder[0]).not.toBe("web");
    expect(ladder[0]).not.toBe("mweb");
  });
  it("de-dups configured clients against the fallback tail", () => {
    const ladder = buildClientLadder("tv,tv,android_vr");
    expect(ladder.filter((c) => c === "tv")).toHaveLength(1);
  });
});
