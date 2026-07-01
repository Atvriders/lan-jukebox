import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { parseInput } from "../youtube/url-parser.js";
import { YtError } from "../youtube/errors.js";
import { fetchLyrics, type LyricsResult } from "../youtube/lyrics.js";
import { requireSession, sessionInfo } from "../auth/password.js";
import type { YouTubeService } from "../youtube/index.js";
import type { StationController } from "../orchestrator/index.js";
import type { RadioEngine } from "../radio/index.js";
import type { PlayerRegistry } from "../players/registry.js";
import type { WebConfig } from "../config.js";
import {
  VOLUME_MAX,
  type Requester,
  type TrackMeta,
  type RepeatMode,
  type StationSettings,
  type ControlAction,
  type SpeakerAction,
  type SpeakerResponse,
  type StationStateResponse,
} from "../types/index.js";

export interface RestDeps {
  station: StationController;
  youtube: Pick<YouTubeService, "resolve" | "search">;
  lyrics?: (meta: TrackMeta) => Promise<LyricsResult>;
  registry: PlayerRegistry;
  radio: Pick<RadioEngine, "reset">;
  searchLimit: number;
  cfg: WebConfig;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const REPEAT_MODES: ReadonlySet<string> = new Set<RepeatMode>(["off", "one", "all"]);

export function registerRest(app: FastifyInstance, deps: RestDeps): void {
  const lyricsOf = deps.lyrics ?? fetchLyrics;

  app.get("/api/state", async (req, reply) => {
    if (!(await requireSession(req, reply))) return;
    const info = sessionInfo(req);
    const snap = deps.station.snapshot();
    const body: StationStateResponse = {
      ...snap,
      // The orchestrator hardcodes the player-presence fields to false/null; the server fills them
      // from the registry so the header speaker indicator ("● {label} live") is not dead UI.
      activePlayerPresent: deps.registry.activePlayerDeviceId !== null,
      activePlayerLabel: deps.registry.activePlayerLabel,
      isThisDeviceSpeaker: info ? deps.registry.isSpeaker(info.deviceId) : false,
    };
    return reply.send(body);
  });

  // Resolve + enqueue a single video for a user add (link path or pick). The seed is set
  // inside StationController.enqueue for source:"user" adds; on success we clear the radio's
  // recent-history de-dup window so the fresh seed's related/artist run starts clean.
  async function enqueueVideo(req: FastifyRequest, reply: FastifyReply, videoId: string) {
    const info = sessionInfo(req);
    if (!info) return reply.code(401).send({ error: "unauthenticated" });
    let meta: TrackMeta;
    try {
      meta = await deps.youtube.resolve(videoId);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof YtError ? err.kind : "resolve_failed" });
    }
    const requester: Requester = {
      deviceId: info.deviceId,
      displayName: info.displayName,
      source: "user",
    };
    let item: { id: string };
    try {
      item = await deps.station.enqueue(meta, requester);
    } catch (err) {
      // Surface the stable enum kind, never err.message: YtError.message embeds the raw
      // yt-dlp stderr slice (fs paths, cookie-file paths, proxy URLs) which must never
      // reach the client. This matches the resolve/search error paths above and below.
      if (err instanceof YtError) return reply.code(400).send({ error: err.kind });
      return reply.code(500).send({ error: "enqueue_failed" });
    }
    deps.radio.reset();
    return reply.send({ queued: { id: item.id, title: meta.title } });
  }

  app.post<{ Body: { urlOrQuery?: string } }>("/api/add", async (req, reply) => {
    if (!(await requireSession(req, reply))) return;
    const input = (req.body?.urlOrQuery ?? "").toString();
    if (input.length > 2000) return reply.code(400).send({ error: "input too long" });
    const parsed = parseInput(input);
    if (parsed.kind === "reject") return reply.code(400).send({ error: parsed.reason });
    if (parsed.kind === "query") {
      try {
        return reply.send({
          candidates: await deps.youtube.search(parsed.query, deps.searchLimit),
        });
      } catch (err) {
        if (err instanceof YtError) return reply.code(400).send({ error: err.kind });
        throw err;
      }
    }
    return enqueueVideo(req, reply, parsed.videoId);
  });

  app.post<{ Body: { candidateId?: string } }>("/api/pick", async (req, reply) => {
    if (!(await requireSession(req, reply))) return;
    const candidateId = (req.body?.candidateId ?? "").toString();
    if (!VIDEO_ID.test(candidateId)) return reply.code(400).send({ error: "bad candidateId" });
    return enqueueVideo(req, reply, candidateId);
  });

  app.post<{ Body: { action?: ControlAction; value?: unknown } }>(
    "/api/control",
    async (req, reply) => {
      // Single shared password: any authenticated user may control everything.
      if (!(await requireSession(req, reply))) return;
      const action = req.body?.action;
      const value = req.body?.value;
      const station = deps.station;
      switch (action) {
        case "play":
          station.resume();
          return reply.send({ ok: true });
        case "pause":
          station.pause();
          return reply.send({ ok: true });
        case "skip":
          station.skip();
          return reply.send({ ok: true });
        case "shuffle":
          await station.shuffle();
          return reply.send({ ok: true });
        case "clear":
          await station.clear();
          return reply.send({ ok: true });
        case "seek": {
          const ms = Number(value);
          if (!Number.isFinite(ms) || ms < 0) {
            return reply.code(400).send({ error: "seek value must be a non-negative number" });
          }
          const current = station.snapshot().current;
          if (!current) return reply.code(409).send({ error: "nothing is playing" });
          if (current.durationMs > 0 && ms > current.durationMs) {
            return reply.code(400).send({ error: "seek exceeds track duration" });
          }
          const ok = await station.seek(Math.round(ms));
          return reply.send({ ok });
        }
        case "volume": {
          const pct = Number(value);
          if (!Number.isFinite(pct) || pct < 0 || pct > VOLUME_MAX) {
            return reply.code(400).send({ error: `volume must be 0..${VOLUME_MAX}` });
          }
          station.setVolume(Math.round(pct));
          return reply.send({ ok: true });
        }
        case "repeat": {
          if (typeof value !== "string" || !REPEAT_MODES.has(value)) {
            return reply.code(400).send({ error: "invalid repeat mode" });
          }
          station.updateSettings({ repeat: value as RepeatMode });
          return reply.send({ ok: true });
        }
        case "remove":
        case "jump": {
          const itemId = (value as { itemId?: string } | undefined)?.itemId;
          if (!itemId) return reply.code(400).send({ error: "itemId is required" });
          const ok =
            action === "remove" ? await station.remove(itemId) : await station.jump(itemId);
          return reply.send({ ok });
        }
        case "reorder": {
          const v = value as { itemId?: string; toIndex?: number } | undefined;
          if (!v?.itemId) return reply.code(400).send({ error: "itemId is required" });
          if (!Number.isInteger(v.toIndex) || (v.toIndex as number) < 0) {
            return reply.code(400).send({ error: "toIndex must be a non-negative integer" });
          }
          const ok = await station.reorder(v.itemId, v.toIndex as number);
          return reply.send({ ok });
        }
        case "settings": {
          const patch = (value ?? {}) as Partial<StationSettings>;
          station.updateSettings(patch as Record<string, unknown>);
          return reply.send({ ok: true });
        }
        default:
          return reply.code(400).send({ error: "unknown action" });
      }
    },
  );

  app.post<{ Body: { action?: SpeakerAction } }>("/api/speaker", async (req, reply) => {
    if (!(await requireSession(req, reply))) return;
    const info = sessionInfo(req);
    if (!info) return reply.code(401).send({ error: "unauthenticated" });
    const action = req.body?.action;
    let result: { activePlayerDeviceId: string | null };
    switch (action) {
      // "claim" is intentionally NOT handled here: designating the Player needs the per-socket
      // BrowserPlayerSink, which only the WS becomePlayer handler (Task 3.4) holds. The UI
      // sends { type: "becomePlayer" } over /ws to claim; REST only does the sink-free actions.
      case "release":
        result = deps.registry.release(info.deviceId);
        break;
      case "remember":
        result = deps.registry.remember(info.deviceId);
        break;
      case "forget":
        result = deps.registry.forget(info.deviceId);
        break;
      case "claim":
        return reply
          .code(400)
          .send({ error: "claim is performed over the websocket (becomePlayer)" });
      default:
        return reply.code(400).send({ error: "unknown speaker action" });
    }
    const body: SpeakerResponse = { ok: true, activePlayerDeviceId: result.activePlayerDeviceId };
    return reply.send(body);
  });

  app.get<{ Querystring: { trackId?: string } }>("/api/lyrics", async (req, reply) => {
    if (!(await requireSession(req, reply))) return;
    const snap = deps.station.snapshot();
    const trackId = req.query.trackId;
    // Honor the client-supplied trackId (the client keys lyrics on the CURRENT videoId and mounts
    // Lyrics with key={currentVideoId}). Ignoring it and always using snapshot().current returns
    // WRONG-track lyrics whenever the track advances between the client's decision to fetch and the
    // server handling the request (radio autoplay/skip/track-end). Resolve the requested id from
    // the live snapshot (current/upcoming/history) first, then fall back to a network resolve; only
    // when no trackId is supplied do we default to the live current.
    let meta: TrackMeta | null = null;
    if (trackId && VIDEO_ID.test(trackId)) {
      const fromSnapshot =
        (snap.current?.meta.videoId === trackId ? snap.current.meta : null) ??
        snap.upcoming.find((i) => i.meta.videoId === trackId)?.meta ??
        snap.history.find((i) => i.meta.videoId === trackId)?.meta ??
        null;
      if (fromSnapshot) {
        meta = fromSnapshot;
      } else {
        // Not in the snapshot (e.g. a just-advanced track): resolve its metadata directly.
        // Best-effort — a resolve failure falls through to the null-lyrics response below.
        try {
          meta = await deps.youtube.resolve(trackId);
        } catch {
          meta = null;
        }
      }
    } else if (!trackId) {
      meta = snap.current?.meta ?? null;
    }
    if (!meta) {
      return reply.send({ lyrics: null, source: "lyrics.ovh" } satisfies LyricsResult);
    }
    return reply.send(await lyricsOf(meta));
  });
}
