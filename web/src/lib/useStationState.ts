import { useEffect, useReducer, useState } from "react";
import type { StationSnapshot } from "../types.js";
import { getDeviceId } from "./deviceId.js";

export interface WsState {
  snapshot: StationSnapshot | null;
  status: "connecting" | "live" | "forbidden" | "closed";
  /** Local epoch-ms the latest snapshot arrived — extrapolates the moving progress bar. */
  receivedAt: number;
  lastError?: { title: string; reason: string; seq: number } | null;
}
export const initialWsState: WsState = {
  snapshot: null,
  status: "connecting",
  receivedAt: 0,
  lastError: null,
};

const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 15000;
export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
}

export function applyWsMessage(prev: WsState, raw: string): WsState {
  let msg: { type?: string; state?: StationSnapshot; title?: string; reason?: string };
  try {
    msg = JSON.parse(raw);
  } catch {
    return prev;
  }
  if (msg.type === "state" && msg.state)
    return { ...prev, snapshot: msg.state, status: "live", receivedAt: Date.now() };
  if (msg.type === "trackError") {
    return {
      ...prev,
      lastError: {
        title: msg.title ?? "track",
        reason: msg.reason ?? "failed",
        seq: (prev.lastError?.seq ?? 0) + 1,
      },
    };
  }
  return prev;
}

type WsAction = { raw: string } | { reset: true } | { closed: true } | { connecting: true };

function reduce(s: WsState, a: WsAction): WsState {
  if ("reset" in a) return initialWsState;
  if ("connecting" in a) return s.status === "forbidden" ? s : { ...s, status: "connecting" };
  if ("closed" in a) return { ...s, status: s.status === "forbidden" ? s.status : "closed" };
  return applyWsMessage(s, a.raw);
}

export function useStationState(): WsState & { socket: WebSocket | null } {
  const [state, dispatch] = useReducer(reduce, initialWsState);
  // Exposed so usePlayerRole can send/attach; updates on every (re)connect.
  const [liveSocket, setLiveSocket] = useState<WebSocket | null>(null);

  useEffect(() => {
    if (typeof WebSocket === "undefined") return;
    dispatch({ reset: true });

    const deviceId = getDeviceId();
    let unmounted = false;
    let socket: WebSocket | null = null;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const forbidden = false;

    const clearRetry = () => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };
    const scheduleReconnect = () => {
      if (unmounted || forbidden || retryTimer !== null) return;
      const delay = reconnectDelayMs(attempt);
      attempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, delay);
    };

    type Tracked = WebSocket & { _dead?: boolean };
    function teardownSocket() {
      if (socket) {
        (socket as Tracked)._dead = true;
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        socket = null;
        setLiveSocket(null);
      }
    }

    function connect() {
      if (unmounted) return;
      clearRetry();
      teardownSocket();
      dispatch({ connecting: true });
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`) as Tracked;
      socket = ws;
      setLiveSocket(ws);
      ws.addEventListener("open", () => {
        if (ws._dead) return;
        attempt = 0;
        ws.send(JSON.stringify({ type: "hello", deviceId, role: "remote" }));
      });
      ws.addEventListener("message", (e) => {
        if (ws._dead) return;
        dispatch({ raw: String((e as MessageEvent).data) });
      });
      const onDown = () => {
        if (ws._dead || ws !== socket) return;
        ws._dead = true;
        dispatch({ closed: true });
        // Invariant: the exposed live socket clears on disconnect. Null it now rather
        // than waiting for the reconnect timer's teardownSocket() to run — otherwise
        // usePlayerRole would hold a CLOSED socket as "live" for the whole backoff window
        // (up to the 15s cap, or indefinitely while still offline).
        setLiveSocket(null);
        scheduleReconnect();
      };
      ws.addEventListener("close", onDown);
      ws.addEventListener("error", onDown);
    }

    const reconnectNow = () => {
      if (unmounted || forbidden) return;
      const ready = socket?.readyState;
      if (ready === WebSocket.OPEN || ready === WebSocket.CONNECTING) return;
      clearRetry();
      attempt = 0;
      connect();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconnectNow();
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconnectNow);
    connect();

    return () => {
      unmounted = true;
      clearRetry();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconnectNow);
      teardownSocket();
    };
  }, []);

  return { ...state, socket: liveSocket };
}
