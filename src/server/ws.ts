import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket as WsWebSocket } from "@fastify/websocket";
import type {
  ClientWsMessage,
  ServerBroadcastMessage,
  ServerWsMessage,
  StationSnapshot,
} from "../types/index.js";
import type { PlayerRegistry } from "../players/registry.js";
import type { BrowserPlayerSink } from "../orchestrator/browser-player-sink.js";

export type Send = (m: ServerWsMessage) => void;

export function isAllowedOrigin(origin: string | undefined, allowed: readonly string[]): boolean {
  return !!origin && allowed.includes(origin);
}

export interface StationLike {
  snapshot(): StationSnapshot;
  on(event: "changed", listener: () => void): unknown;
}

export class StationBroadcaster {
  private readonly subs = new Set<Send>();
  private attached = false;

  subscribe(send: Send): void {
    this.subs.add(send);
  }
  unsubscribe(send: Send): void {
    this.subs.delete(send);
  }
  broadcast(msg: ServerBroadcastMessage): void {
    // Isolate each send: a throw from one dead socket (e.g. ws.send() on a
    // CLOSING/CLOSED socket) must not abort fan-out to the remaining healthy
    // subscribers. Prune the offender so it can't keep throwing.
    for (const send of this.subs) {
      try {
        send(msg);
      } catch {
        this.subs.delete(send);
      }
    }
  }
  attach(station: StationLike): void {
    if (this.attached) return;
    this.attached = true;
    station.on("changed", () => {
      this.broadcast({ type: "state", state: station.snapshot() });
    });
  }
}

export interface WsDeps {
  broadcaster: StationBroadcaster;
  registry: PlayerRegistry;
  allowedOrigins: readonly string[];
  makeSink: (send: Send) => BrowserPlayerSink; // factory injected from the composition root
  station: StationLike & { reportPosition(ms: number): void };
}

export function registerWebsocket(app: FastifyInstance, deps: WsDeps): void {
  app.addHook("onRequest", async (req, reply) => {
    // Match the exact /ws path (optionally with a query string), NOT any URL that
    // merely starts with "/ws" — a prefix match would wrongly subject future
    // sibling HTTP routes like /wsstatus or /ws-health to the WS origin check.
    const path = req.url.split("?", 1)[0];
    if (path === "/ws") {
      if (!isAllowedOrigin(req.headers.origin, deps.allowedOrigins)) {
        await reply.code(403).send({ error: "bad_origin" });
      }
    }
  });

  deps.broadcaster.attach(deps.station);

  app.get("/ws", { websocket: true }, (socket: WsWebSocket, req: FastifyRequest) => {
    const session = (
      req as FastifyRequest & {
        session?: { authed?: boolean; deviceId?: string; displayName?: string };
      }
    ).session;
    if (!session?.authed) {
      socket.close(1008, "unauthenticated");
      return;
    }
    const deviceId = session.deviceId ?? "unknown";
    const label = session.displayName ?? deviceId;
    const send: Send = (m) => socket.send(JSON.stringify(m));
    const sink = deps.makeSink(send);

    deps.broadcaster.subscribe(send);

    socket.on("message", (raw: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof parsed !== "object" || parsed === null) return;
      const msg = parsed as ClientWsMessage;
      switch (msg.type) {
        case "hello":
          deps.registry.touch(deviceId, label);
          deps.registry.onConnect(deviceId, sink);
          // Every subscriber gets an immediate {type:'state'} after a successful hello.
          send({ type: "state", state: deps.station.snapshot() });
          break;
        case "becomePlayer":
          deps.registry.claim(deviceId, sink);
          break;
        case "relinquishPlayer":
          deps.registry.release(deviceId);
          break;
        case "position":
          deps.station.reportPosition(msg.ms);
          break;
        case "trackEnded":
          sink.emit("trackEnd");
          break;
        case "playbackError":
          sink.emit("error", new Error(msg.message));
          break;
      }
    });

    socket.on("close", () => {
      // Sink-scoped so a reload (same deviceId, fresh sink already swapped in via
      // becomePlayer) does not let the OLD socket's stale close tear down the new,
      // legitimately-active session.
      deps.registry.onDisconnect(deviceId, sink);
      deps.broadcaster.unsubscribe(send);
    });
  });
}
