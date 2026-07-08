import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket as WsWebSocket } from "@fastify/websocket";
import type {
  ClientWsMessage,
  PresenceUser,
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
  /** Live roster of currently-connected clients (deduped per device). */
  listConnected(): PresenceUser[];
}

/**
 * Enrich a raw orchestrator snapshot with the registry's live player-presence fields:
 * the speaker indicator (activePlayerPresent/Label) AND the live listeners roster.
 */
export function withPresence(
  state: StationSnapshot,
  presence: PlayerPresence | undefined,
): StationSnapshot {
  if (!presence) return state;
  return {
    ...state,
    activePlayerPresent: presence.activePlayerDeviceId !== null,
    activePlayerLabel: presence.activePlayerLabel,
    listeners: presence.listConnected(),
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
  station: StationLike & { reportPosition(ms: number): void; crossfadeAdvance(): void };
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

  // Live presence view backed by the registry (getters/listConnected read fresh each use).
  // Shared by the broadcaster attach AND the per-socket connect/disconnect broadcasts below.
  const presence: PlayerPresence = {
    get activePlayerDeviceId() {
      return deps.registry.activePlayerDeviceId;
    },
    get activePlayerLabel() {
      return deps.registry.activePlayerLabel;
    },
    listConnected: () => deps.registry.listConnected(),
  };
  deps.broadcaster.attach(deps.station, presence);

  // Broadcast the CURRENT enriched snapshot to every subscriber. Used on connect/disconnect
  // so the live listeners roster updates for everyone — a bare remote connect/disconnect does
  // NOT fire station 'changed' (the only other path that emits {type:'state'}).
  const broadcastState = (): void => {
    deps.broadcaster.broadcast({
      type: "state",
      state: withPresence(deps.station.snapshot(), presence),
    });
  };

  // WS heartbeat: ping/pong keepalive to reap ghost listeners + a stuck dead speaker.
  // A client that dies uncleanly (laptop lid, Wi-Fi drop, NAT timeout) never fires 'close',
  // so without this it lingers forever in the live listeners roster — and if it was the
  // speaker, the station stays attached to a dead sink. Each sweep terminates any socket
  // that missed the previous ping; terminate() fires 'close', which runs the existing
  // trackDisconnect/onDisconnect cleanup (so both ghosts AND dead speakers are reaped).
  type HeartbeatSocket = WsWebSocket & { _isAlive?: boolean };
  const openSockets = new Set<HeartbeatSocket>();
  const heartbeat = setInterval(() => {
    for (const socket of openSockets) {
      // Crash-safe per socket: a throw from one dead socket's ping/terminate must not
      // abort the sweep for the rest.
      try {
        if (socket._isAlive === false) {
          socket.terminate(); // missed the last ping -> 'close' fires -> normal cleanup reaps it
        } else {
          socket._isAlive = false;
          socket.ping();
        }
      } catch {
        // ignore this socket; keep sweeping the others
      }
    }
  }, 30000);
  // Stop the sweep when Fastify closes so tests/shutdown don't leak a timer. Callback form (no
  // await needed) rather than an async handler with no await expression.
  app.addHook("onClose", (_instance, done) => {
    clearInterval(heartbeat);
    done();
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

    // Heartbeat liveness for this socket (see the sweep above): alive on open, on every
    // pong, and on every inbound message (activity implies alive).
    const hbSocket = socket as HeartbeatSocket;
    hbSocket._isAlive = true;
    openSockets.add(hbSocket);
    socket.on("pong", () => {
      hbSocket._isAlive = true;
    });

    socket.on("message", (raw: Buffer) => {
      hbSocket._isAlive = true;
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
          // This socket gets an immediate {type:'state'} after a successful hello — enriched with
          // the live player-presence fields (same overlay as the broadcast path).
          send({
            type: "state",
            state: withPresence(deps.station.snapshot(), presence),
          });
          // …and every OTHER connected client's roster updates live: this new listener just
          // joined, but a bare connect fires no station 'changed', so broadcast it explicitly.
          broadcastState();
          break;
        case "becomePlayer":
          deps.registry.claim(deviceId, sink);
          break;
        case "relinquishPlayer":
          deps.registry.release(deviceId);
          break;
        case "position":
          // Player-scoped: only the ACTIVE speaker's clock drives the station.
          // A non-speaker's position must NOT move the shared timeline.
          if (deps.registry.isSpeaker(deviceId)) deps.station.reportPosition(msg.ms);
          break;
        case "trackEnded":
          // Route through the sink's guarded API (destroyed short-circuit) rather than a raw
          // emit, keeping all sink-event policy in one place.
          sink.onTrackEnded();
          break;
        case "crossfadeAdvance":
          // The Player already started the next track (crossfading in); advance the queue
          // WITHOUT re-loading it. For a given track the Player sends EITHER crossfadeAdvance
          // OR trackEnded, never both, so this never double-advances vs onSinkTrackEnd.
          // Player-scoped: a non-speaker sending this would desync the station (advance the
          // queue while the real Player keeps playing), so ignore it unless we're the speaker.
          if (deps.registry.isSpeaker(deviceId)) deps.station.crossfadeAdvance();
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
      // Drop this socket from the live listeners roster (deviceId-scoped: one decrement per
      // socket, so multi-tab / reload overlap nets out — the device stays until its last socket).
      deps.registry.trackDisconnect(deviceId);
      // Stop heartbeating a closed socket.
      openSockets.delete(hbSocket);
      deps.broadcaster.unsubscribe(send);
      // The roster shrank — tell everyone still connected. Unsubscribe FIRST so this dead
      // socket is not in the fan-out.
      broadcastState();
    });
  });
}
