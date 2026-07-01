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

/**
 * Live player-presence source (the PlayerRegistry). The orchestrator's snapshot() hardcodes the
 * player-presence fields to false/null ("server fills the player-presence fields"); the server
 * producer sites overlay the registry's real values so the UI speaker indicator
 * ("● {label} live" vs "○ no speaker") reflects reality instead of being permanently dead.
 */
export interface PlayerPresence {
  readonly activePlayerDeviceId: string | null;
  readonly activePlayerLabel: string | null;
}

/** Enrich a raw orchestrator snapshot with the registry's live player-presence fields. */
export function withPresence(
  state: StationSnapshot,
  presence: PlayerPresence | undefined,
): StationSnapshot {
  if (!presence) return state;
  return {
    ...state,
    activePlayerPresent: presence.activePlayerDeviceId !== null,
    activePlayerLabel: presence.activePlayerLabel,
  };
}

export class StationBroadcaster {
  private readonly subs = new Set<Send>();
  private attached = false;
  private presence: PlayerPresence | undefined;

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
  attach(station: StationLike, presence?: PlayerPresence): void {
    if (presence) this.presence = presence;
    if (this.attached) return;
    this.attached = true;
    station.on("changed", () => {
      // Overlay the live player-presence so every broadcast 'state' carries a real speaker
      // indicator (the orchestrator can't know who the active Player is — the registry owns that).
      this.broadcast({ type: "state", state: withPresence(station.snapshot(), this.presence) });
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

  // Attach with a live presence view backed by the registry (getters read fresh each broadcast).
  deps.broadcaster.attach(deps.station, {
    get activePlayerDeviceId() {
      return deps.registry.activePlayerDeviceId;
    },
    get activePlayerLabel() {
      return deps.registry.activePlayerLabel;
    },
  });

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
          // Every subscriber gets an immediate {type:'state'} after a successful hello — enriched
          // with the live player-presence fields (same overlay as the broadcast path).
          send({
            type: "state",
            state: withPresence(deps.station.snapshot(), {
              activePlayerDeviceId: deps.registry.activePlayerDeviceId,
              activePlayerLabel: deps.registry.activePlayerLabel,
            }),
          });
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
          // Route through the sink's guarded API (destroyed short-circuit) rather than a raw
          // emit, keeping all sink-event policy in one place.
          sink.onTrackEnded();
          break;
        case "playbackError":
          // MUST go through onPlaybackError (not a raw emit("error")): a listener-less
          // EventEmitter throws synchronously on an "error" emit, and only the active-Player
          // sink has an "error" listener. onPlaybackError no-ops when there is none, so a
          // playbackError frame from a non-Player socket can never crash the station.
          sink.onPlaybackError(msg.message);
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
