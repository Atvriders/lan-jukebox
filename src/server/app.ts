import Fastify, {
  type FastifyInstance,
  type FastifyError,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemorySessionStore } from "../auth/session-store.js";
import { registerAuthRoutes } from "../auth/password.js";
import { registerRest, type RestDeps } from "./rest.js";
import { registerAudioRoute } from "../audio/index.js";
import { registerWebsocket, StationBroadcaster } from "./ws.js";
import { BrowserPlayerSink } from "../orchestrator/browser-player-sink.js";
import type { WebConfig } from "../config.js";
import type { StationController } from "../orchestrator/index.js";
import type { YouTubeService } from "../youtube/index.js";
import type { PlayerRegistry } from "../players/registry.js";
import type { AudioCache } from "../cache/index.js";
import type { Semaphore } from "../util/semaphore.js";

export interface AppDeps {
  cfg: WebConfig;
  station: StationController;
  youtube: YouTubeService;
  registry: PlayerRegistry;
  broadcaster: StationBroadcaster;
  cache: AudioCache;
  cacheDir: string; // = media.cacheDir; the audio route downloads/transcodes into it
  downloads: Semaphore;
  lyrics?: RestDeps["lyrics"];
  radio: RestDeps["radio"];
  searchLimit: number;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // trustProxy is always true: the app is always behind the user's HTTPS proxy/tunnel,
  // which sets X-Forwarded-Proto. Trusting it is required for correct scheme detection,
  // secure cookies, and the real client IP. This is a fixed behavior, not a config knob.
  const app = Fastify({
    trustProxy: true,
    logger: false,
    // Low-level framework errors (a malformed percent-encoded URL is rejected by Fastify's
    // URL parser as FST_ERR_BAD_URL BEFORE routing) never reach setErrorHandler/onError, so
    // their raw serialized body would leak the offending URL, internal code, and message.
    // Intercept them here and return the same sanitized generic body the error handler uses.
    frameworkErrors: (err: FastifyError, _req: FastifyRequest, reply: FastifyReply): void => {
      const status = err.statusCode ?? 500;
      if (
        err.code === "FST_ERR_BAD_URL" ||
        err instanceof URIError ||
        (status >= 400 && status < 500)
      ) {
        void reply.code(400).send({ error: "bad_request" });
        return;
      }
      void reply.code(500).send({ error: "internal_error" });
    },
  });

  // Never let an unexpected throw leak raw internals (yt-dlp stderr, fs paths, stacks).
  // URIError (e.g. a bad percent-encoding) -> 400; genuine 5xx -> a stable generic body.
  // Explicit 4xx also gets a stable body rather than err.message, so a future handler/plugin
  // that throws a 4xx Error carrying a sensitive message cannot leak it.
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err instanceof URIError) return reply.code(400).send({ error: "bad_request" });
    const status = err.statusCode ?? 500;
    if (status >= 500) return reply.code(500).send({ error: "internal_error" });
    return reply.code(status).send({ error: "bad_request" });
  });

  await app.register(cookie);
  await app.register(session, {
    secret: deps.cfg.sessionSecret,
    cookieName: "sid",
    store: new MemorySessionStore() as never,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      path: "/",
      httpOnly: true,
      // "auto": Secure over HTTPS (detected via the tunnel's X-Forwarded-Proto, honored
      // because trustProxy is on) and non-Secure over plain-HTTP LAN access — so login
      // works both through the tunnel and directly at http://<host-ip>:PORT.
      secure: "auto",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });
  await app.register(websocket);

  app.get("/healthz", () => ({ ok: true, uptimeSec: Math.floor(process.uptime()) }));

  registerAuthRoutes(app, deps.cfg);
  registerRest(app, {
    station: deps.station,
    youtube: deps.youtube,
    lyrics: deps.lyrics,
    registry: deps.registry,
    radio: deps.radio,
    searchLimit: deps.searchLimit,
    cfg: deps.cfg,
  });
  registerAudioRoute(app, {
    cache: deps.cache,
    youtube: deps.youtube,
    cacheDir: deps.cacheDir,
    downloads: deps.downloads,
  });
  registerWebsocket(app, {
    broadcaster: deps.broadcaster ?? new StationBroadcaster(),
    station: deps.station,
    registry: deps.registry,
    allowedOrigins: deps.cfg.allowedWsOrigins,
    // Per-socket sink factory: a fresh BrowserPlayerSink whose ServerPlayerMessages target
    // THIS socket's send. ws.ts caches it per connection and feeds it to registry.claim/onConnect.
    makeSink: (send) => {
      const sink = new BrowserPlayerSink();
      sink.setSend(send);
      return sink;
    },
  });

  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
  await app.register(fastifyStatic, { root: publicDir, prefix: "/", wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (
      req.method === "GET" &&
      !req.url.startsWith("/api") &&
      !req.url.startsWith("/ws") &&
      !req.url.startsWith("/audio")
    ) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "not_found" });
  });

  return app;
}
