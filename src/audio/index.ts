import { createReadStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AudioCache } from "../cache/index.js";
import type { YouTubeService } from "../youtube/index.js";
import type { Semaphore } from "../util/semaphore.js";
import { chooseDelivery, transcodeToM4a } from "./format.js";
import { requireSession } from "../auth/password.js";

export interface AudioRouteDeps {
  cache: AudioCache;
  youtube: Pick<YouTubeService, "download" | "resolve">;
  cacheDir: string;
  downloads: Semaphore;
}

/**
 * Per-videoId single-flight guard. The Semaphore bounds concurrency but is NOT key-aware,
 * so two concurrent GET /audio/:id for the same uncached id would both pass the cache miss,
 * both call youtube.download(), and both register() the same key — duplicate yt-dlp work plus
 * a destructive register() race (the second register rm's the first download's file out from
 * under an in-flight stream). Coalescing on videoId so the second caller awaits the first's
 * Promise eliminates both. Cleared in a finally so a failed resolve doesn't poison the key.
 */
const inFlight = new Map<string, Promise<{ path: string; contentType: string } | null>>();

/**
 * Per-videoId single-flight guard for the TRANSCODE leg specifically. The download inFlight
 * map only guards the uncached path — but the fast path in ensureFile returns before taking
 * that lock whenever the ORIGINAL source is already cached. For a cached-but-needs-transcode
 * id, two concurrent requests would both reach the transcode block, both see cache.get(m4aKey)
 * null, and both spawn ffmpeg writing the SAME `${videoId}.transcoded.m4a` (ffmpeg runs with
 * `-y` + `-movflags +faststart`), interleaving their writes into a corrupt file that then gets
 * register()+pin()'d and served. Coalescing on the m4a key so the second caller awaits the
 * first transcode eliminates the duplicate ffmpeg + the destructive concurrent write. Cleared
 * in a finally so a failed transcode doesn't poison the key.
 */
const transcodeInFlight = new Map<string, Promise<{ path: string; contentType: string } | null>>();

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | { unsatisfiable: true } | null {
  if (!header) return null;
  const trimmed = header.trim();
  // Only the single-range "bytes=" form is supported. Anything this server cannot
  // understand or apply — an unknown range-unit, a case-variant unit, stray internal
  // whitespace, or a multi-range list — is per RFC 9110 §15.5.17 IGNORED (return null
  // so the caller serves the full 200 representation), NOT answered with 416. 416 is
  // reserved for a syntactically valid bytes-range that does not overlap the resource.
  const m = /^bytes=(\d*)-(\d*)$/.exec(trimmed);
  if (!m) return null;
  // Both capture groups always match (the regex requires them); the non-null
  // assertions satisfy noUncheckedIndexedAccess for the destructured RegExp result.
  const startRaw = m[1]!;
  const endRaw = m[2]!;
  if (startRaw === "" && endRaw === "") return { unsatisfiable: true };

  let start: number;
  let end: number;
  if (startRaw === "") {
    // suffix range: last N bytes
    const n = Number.parseInt(endRaw, 10);
    if (n <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number.parseInt(startRaw, 10);
    end = endRaw === "" ? size - 1 : Number.parseInt(endRaw, 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { unsatisfiable: true };
  if (start >= size) return { unsatisfiable: true };
  if (start > end) return { unsatisfiable: true };
  if (end >= size) end = size - 1;
  return { start, end };
}

/**
 * Resolve a videoId to a ready-to-serve file path + Content-Type.
 * Downloads if missing (through the semaphore), registers+pins in the cache,
 * and transcodes once to a clean .m4a when the source isn't browser-playable.
 * Returns null when the track can't be produced (caller -> 404).
 */
async function ensureFile(
  deps: AudioRouteDeps,
  videoId: string,
): Promise<{ path: string; contentType: string } | null> {
  // Fast path: already cached. Resolve directly (no need to take the single-flight lock).
  if (deps.cache.get(videoId)) {
    return resolveFile(deps, videoId);
  }
  // Single-flight: if a resolve for this id is already running, await it instead of starting
  // a second download. The first caller owns the entry and removes it on settle.
  const existing = inFlight.get(videoId);
  if (existing) return existing;

  const work = resolveFile(deps, videoId).finally(() => {
    inFlight.delete(videoId);
  });
  inFlight.set(videoId, work);
  return work;
}

async function resolveFile(
  deps: AudioRouteDeps,
  videoId: string,
): Promise<{ path: string; contentType: string } | null> {
  // Re-check the cache: a coalesced caller may have raced in, and the fast path above
  // already populated the cache for an already-cached id.
  let path = deps.cache.get(videoId);
  let audio = deps.cache.getAudio(videoId);

  if (!path) {
    try {
      // Resolve the track first so we can thread its duration into download(): that scales the
      // yt-dlp timeout for long mixes/concerts instead of killing them at the short default.
      // Best-effort — a resolve failure falls back to an unscaled download rather than 404ing.
      let durationSec: number | null | undefined;
      try {
        durationSec = (await deps.youtube.resolve(videoId)).durationSec;
      } catch {
        durationSec = undefined;
      }
      const result = await deps.downloads.run(() =>
        deps.youtube.download(videoId, deps.cacheDir, { durationSec }),
      );
      deps.cache.register(videoId, result.path, result.audio);
      deps.cache.pin(videoId);
      path = result.path;
      audio = result.audio;
    } catch {
      return null;
    }
  }

  const ext = extname(path).replace(/^\./, "").toLowerCase();
  const delivery = chooseDelivery(audio, ext);
  if (!delivery.needsTranscode) {
    return { path, contentType: delivery.contentType };
  }

  // Transcode once to a sibling .m4a, then cache + pin THAT under a derived key so
  // the original key still maps to the (now superseded) source until evicted. Single-flighted
  // on the m4a key so two concurrent requests (both past the cached-source fast path) can't
  // both spawn ffmpeg writing the same destPath and corrupt it — the second awaits the first.
  const m4aKey = `${videoId}.m4a`;
  const cachedTranscode = deps.cache.get(m4aKey);
  if (cachedTranscode) {
    return { path: cachedTranscode, contentType: "audio/mp4" };
  }
  const existingTranscode = transcodeInFlight.get(m4aKey);
  if (existingTranscode) return existingTranscode;
  const transcodeWork = runTranscode(deps, path, m4aKey).finally(() => {
    transcodeInFlight.delete(m4aKey);
  });
  transcodeInFlight.set(m4aKey, transcodeWork);
  return transcodeWork;
}

/** Spawn ffmpeg once for a cache-miss transcode, register+pin the result. Coalesced by caller. */
async function runTranscode(
  deps: AudioRouteDeps,
  sourcePath: string,
  m4aKey: string,
): Promise<{ path: string; contentType: string } | null> {
  // Re-check under the single-flight entry: a coalesced predecessor may have just produced it.
  const cached = deps.cache.get(m4aKey);
  if (cached) return { path: cached, contentType: "audio/mp4" };
  const videoId = m4aKey.replace(/\.m4a$/, "");
  const destPath = join(deps.cacheDir, `${videoId}.transcoded.m4a`);
  try {
    await deps.downloads.run(() => transcodeToM4a(sourcePath, destPath));
    deps.cache.register(m4aKey, destPath, { codec: "aac", bitrateKbps: 192, sampleRateHz: 48000 });
    deps.cache.pin(m4aKey);
    return { path: destPath, contentType: "audio/mp4" };
  } catch {
    // ffmpeg runs with `-y` and opens destPath before it dies, so a partial/0-byte file is
    // already on disk. The cache never registered it, so nothing would ever evict it —
    // remove it here so repeated failures don't leak orphan <id>.transcoded.m4a files.
    await rm(destPath, { force: true }).catch(() => {});
    return null;
  }
}

async function serveFile(
  reply: FastifyReply,
  path: string,
  contentType: string,
  range: string | undefined,
): Promise<FastifyReply> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    // File evicted/raced away between resolve and stat. No Content-Type override yet,
    // so a default-serialized JSON body is safe here.
    return reply.code(404).send({ error: "not_found" });
  }

  reply.header("Accept-Ranges", "bytes");
  reply.header("Content-Type", contentType);

  const parsed = parseRange(range, size);
  if (parsed && "unsatisfiable" in parsed) {
    reply.header("Content-Range", `bytes */${size}`);
    // Content-Type is already set to the (audio/*) media type above, so Fastify would not
    // JSON-serialize an object body (FST_ERR_REP_INVALID_PAYLOAD_TYPE). Send a plain string.
    return reply.code(416).send("range_not_satisfiable");
  }

  if (!parsed) {
    // Full body.
    reply.header("Content-Length", String(size));
    reply.code(200);
    return reply.send(createReadStream(path));
  }

  // Partial body.
  const { start, end } = parsed;
  reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
  reply.header("Content-Length", String(end - start + 1));
  reply.code(206);
  return reply.send(createReadStream(path, { start, end }));
}

/** Registers GET /audio/:trackId on `app`. Standalone plugin; server/app.ts wires it. */
export function registerAudioRoute(app: FastifyInstance, deps: AudioRouteDeps): void {
  app.get<{ Params: { trackId: string } }>("/audio/:trackId", async (req, reply) => {
    // Gate on the shared-password session exactly like every /api route. This route is
    // reachable at the public PUBLIC_BASE_URL behind a bring-your-own tunnel, and the single
    // shared password is the ONLY thing protecting the station. Without this check the route
    // was unauthenticated: (1) anyone could stream any cached track's full audio password-free,
    // and (2) an anonymous caller could enumerate valid 11-char video ids and force unbounded
    // yt-dlp downloads + transcodes through the download semaphore (no rate-limiting by
    // invariant), exhausting download slots, CPU, disk, and the host's YouTube egress. The
    // Player's same-origin <audio src="/audio/<id>"> sends the sid cookie automatically, so
    // legitimate playback still passes. Check BEFORE the id-format check so unauthenticated
    // callers get 401 and never reach ensureFile()/youtube.download().
    if (!(await requireSession(req, reply))) return;
    const { trackId } = req.params;
    if (!VIDEO_ID_RE.test(trackId)) {
      return reply.code(404).send({ error: "not_found" });
    }
    const file = await ensureFile(deps, trackId);
    if (!file) {
      return reply.code(404).send({ error: "not_found" });
    }
    return serveFile(reply, file.path, file.contentType, req.headers.range);
  });
}
