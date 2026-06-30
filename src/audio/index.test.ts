import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioCache } from "../cache/index.js";
import { Semaphore } from "../util/semaphore.js";

vi.mock("./format.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./format.js")>();
  return {
    ...actual,
    // Simulate a successful transcode by copying the source bytes to destPath,
    // so the route can stat + stream a real file without spawning ffmpeg.
    transcodeToM4a: vi.fn(async (src: string, dest: string) => {
      const { copyFile } = await import("node:fs/promises");
      await copyFile(src, dest);
    }),
  };
});

import { registerAudioRoute, parseRange } from "./index.js";

describe("parseRange", () => {
  it("returns null when there is no Range header", () => {
    expect(parseRange(undefined, 1000)).toBeNull();
    expect(parseRange("", 1000)).toBeNull();
  });

  it("parses a bounded range", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=100-199", 1000)).toEqual({ start: 100, end: 199 });
  });

  it("clamps an open-ended range to the last byte", () => {
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
  });

  it("parses a suffix range (last N bytes)", () => {
    expect(parseRange("bytes=-200", 1000)).toEqual({ start: 800, end: 999 });
  });

  it("clamps an end past EOF to size-1", () => {
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("flags an unsatisfiable range (start >= size)", () => {
    expect(parseRange("bytes=1000-1100", 1000)).toEqual({ unsatisfiable: true });
  });

  it("flags an out-of-bounds bytes-range (start > end) as unsatisfiable", () => {
    expect(parseRange("bytes=50-10", 1000)).toEqual({ unsatisfiable: true }); // start > end
  });

  // RFC 9110 §15.5.17: a Range the server cannot understand or apply MUST be IGNORED
  // (=> serve the full 200 representation), not answered with 416. parseRange returns
  // null for these so serveFile falls through to the full-body branch.
  it("ignores an unparseable/unapplicable Range (returns null -> 200 full body)", () => {
    expect(parseRange("bytes=abc-def", 1000)).toBeNull(); // not a valid bytes-range
    expect(parseRange("items=0-1", 1000)).toBeNull(); // unknown range-unit
    expect(parseRange("BYTES=0-9", 1000)).toBeNull(); // case-variant unit (not literal "bytes")
    expect(parseRange("bytes= 0-9", 1000)).toBeNull(); // stray internal whitespace
  });

  it("ignores a multi-range request (unsupported) -> null -> 200 full body", () => {
    expect(parseRange("bytes=0-10,20-30", 1000)).toBeNull();
  });
});

describe("GET /audio/:trackId", () => {
  let dir: string;
  let app: FastifyInstance;
  let cache: AudioCache;

  // 11-char valid YouTube id used across tests
  const ID = "dQw4w9WgXcQ";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "audio-"));
    cache = new AudioCache(dir, 10_000_000);
    await cache.init();
  });

  afterEach(async () => {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  });

  function build(youtube: { download: ReturnType<typeof vi.fn> }) {
    app = Fastify();
    registerAudioRoute(app, {
      cache,
      youtube: youtube as never,
      cacheDir: dir,
      downloads: new Semaphore(2),
    });
    return app;
  }

  async function seedCached(id: string, ext: string, body: Buffer, codec = "opus") {
    const p = join(dir, `${id}.${ext}`);
    await writeFile(p, body);
    cache.register(id, p, { codec, bitrateKbps: 160, sampleRateHz: 48000 });
  }

  it("404s when trackId is not a valid YouTube id (download never attempted)", async () => {
    const download = vi.fn();
    build({ download });
    const res = await app.inject({ method: "GET", url: "/audio/not-an-id" });
    expect(res.statusCode).toBe(404);
    expect(download).not.toHaveBeenCalled();
  });

  it("404s when the track cannot be downloaded (download throws)", async () => {
    const download = vi.fn().mockRejectedValue(new Error("unavailable"));
    build({ download });
    const res = await app.inject({ method: "GET", url: `/audio/${ID}` });
    expect(res.statusCode).toBe(404);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("serves the full body (200) with Accept-Ranges + Content-Length + Content-Type", async () => {
    const body = Buffer.from("0123456789abcdef"); // 16 bytes
    await seedCached(ID, "webm", body);
    const download = vi.fn(); // must NOT be called — already cached
    build({ download });

    const res = await app.inject({ method: "GET", url: `/audio/${ID}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-type"]).toBe("audio/webm");
    expect(res.headers["content-length"]).toBe("16");
    expect(res.rawPayload.equals(body)).toBe(true);
    expect(download).not.toHaveBeenCalled();
  });

  it("serves a partial body (206) with Content-Range for a Range request", async () => {
    const body = Buffer.from("0123456789abcdef"); // 16 bytes
    await seedCached(ID, "webm", body);
    build({ download: vi.fn() });

    const res = await app.inject({
      method: "GET",
      url: `/audio/${ID}`,
      headers: { range: "bytes=4-9" },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 4-9/16");
    expect(res.headers["content-length"]).toBe("6");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.rawPayload.equals(Buffer.from("456789"))).toBe(true);
  });

  it("ignores an ungrokkable Range header and serves the full body (200), not 416", async () => {
    // RFC 9110 §15.5.17: a Range the server cannot apply (here a case-variant unit) is
    // ignored and the full representation is returned with 200 — never a hard 416 failure.
    const body = Buffer.from("0123456789abcdef"); // 16 bytes
    await seedCached(ID, "webm", body);
    build({ download: vi.fn() });

    const res = await app.inject({
      method: "GET",
      url: `/audio/${ID}`,
      headers: { range: "BYTES=0-3" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-length"]).toBe("16");
    expect(res.headers["content-range"]).toBeUndefined();
    expect(res.rawPayload.equals(body)).toBe(true);
  });

  it("ignores a multi-range request and serves the full body (200), not 416", async () => {
    const body = Buffer.from("0123456789abcdef"); // 16 bytes
    await seedCached(ID, "webm", body);
    build({ download: vi.fn() });

    const res = await app.inject({
      method: "GET",
      url: `/audio/${ID}`,
      headers: { range: "bytes=0-3,8-11" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-length"]).toBe("16");
    expect(res.headers["content-range"]).toBeUndefined();
    expect(res.rawPayload.equals(body)).toBe(true);
  });

  it("416s with Content-Range bytes */size on an unsatisfiable range", async () => {
    const body = Buffer.from("0123456789abcdef"); // 16 bytes
    await seedCached(ID, "webm", body);
    build({ download: vi.fn() });

    const res = await app.inject({
      method: "GET",
      url: `/audio/${ID}`,
      headers: { range: "bytes=100-200" },
    });
    expect(res.statusCode).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */16");
  });

  it("downloads, registers + pins, then serves when the track is not cached", async () => {
    const body = Buffer.from("transcode-me-not-opus"); // arbitrary bytes
    // download() writes the file into cacheDir and returns its real path + AudioInfo
    const download = vi.fn(async (videoId: string, outDir: string) => {
      const p = join(outDir, `${videoId}.webm`);
      await writeFile(p, body);
      return { path: p, audio: { codec: "opus", bitrateKbps: 160, sampleRateHz: 48000 } };
    });
    build({ download });

    expect(cache.has(ID)).toBe(false);
    const res = await app.inject({ method: "GET", url: `/audio/${ID}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/webm");
    expect(res.rawPayload.equals(body)).toBe(true);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith(ID, dir);
    // registered + pinned: a second request must NOT re-download.
    expect(cache.has(ID)).toBe(true);
    const res2 = await app.inject({ method: "GET", url: `/audio/${ID}` });
    expect(res2.statusCode).toBe(200);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("transcodes a non-playable source and serves it as audio/mp4", async () => {
    const body = Buffer.from("fake-mp3-bytes");
    // mp3 codec in an mp3 container -> chooseDelivery returns needsTranscode:true
    await seedCached(ID, "mp3", body, "mp3");
    build({ download: vi.fn() });

    const res = await app.inject({ method: "GET", url: `/audio/${ID}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/mp4");
    // body is the copied-through transcode output (our mock copies bytes 1:1)
    expect(res.rawPayload.equals(body)).toBe(true);

    const { transcodeToM4a } = await import("./format.js");
    expect(transcodeToM4a).toHaveBeenCalledTimes(1);

    // second request reuses the cached transcode (no second ffmpeg call)
    const res2 = await app.inject({
      method: "GET",
      url: `/audio/${ID}`,
      headers: { range: "bytes=0-3" },
    });
    expect(res2.statusCode).toBe(206);
    expect(res2.headers["content-type"]).toBe("audio/mp4");
    expect((transcodeToM4a as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("removes the partial .transcoded.m4a and 404s when the transcode fails", async () => {
    const body = Buffer.from("fake-mp3-bytes");
    await seedCached(ID, "mp3", body, "mp3");
    build({ download: vi.fn() });

    const destPath = join(dir, `${ID}.transcoded.m4a`);
    const { transcodeToM4a } = await import("./format.js");
    // Simulate ffmpeg writing a partial file (it opens destPath with -y) then dying.
    (transcodeToM4a as ReturnType<typeof vi.fn>).mockImplementationOnce(async (_src, dest) => {
      await writeFile(dest as string, "PARTIAL-MP4-MOOV-HEADER-ONLY");
      throw new Error("ffmpeg transcode failed (exit 1)");
    });

    const res = await app.inject({ method: "GET", url: `/audio/${ID}` });
    expect(res.statusCode).toBe(404);
    // The partial transcode output must be cleaned up, not leaked on disk.
    expect(existsSync(destPath)).toBe(false);
    // And the failed transcode key must not have been registered as a ghost entry.
    expect(cache.has(`${ID}.m4a`)).toBe(false);
  });

  it("coalesces concurrent requests for the same uncached id into ONE download (no herd)", async () => {
    const body = Buffer.from("transcode-me-not-opus");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // download() blocks on the gate so both requests are in-flight simultaneously.
    const download = vi.fn(async (videoId: string, outDir: string) => {
      await gate;
      const p = join(outDir, `${videoId}.webm`);
      await writeFile(p, body);
      return { path: p, audio: { codec: "opus", bitrateKbps: 160, sampleRateHz: 48000 } };
    });
    build({ download });

    const r1 = app.inject({ method: "GET", url: `/audio/${ID}` });
    const r2 = app.inject({ method: "GET", url: `/audio/${ID}` });
    // Let both handlers reach the cache miss + single-flight gate before releasing.
    await new Promise((r) => setImmediate(r));
    release();
    const [res1, res2] = await Promise.all([r1, r2]);

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(res1.rawPayload.equals(body)).toBe(true);
    expect(res2.rawPayload.equals(body)).toBe(true);
    // The single-flight guard collapsed the duplicate download.
    expect(download).toHaveBeenCalledTimes(1);
  });
});
