import { useEffect, useRef, useState } from "react";
import type { ServerPlayerMessage, ClientWsMessage } from "../types.js";

/**
 * Owns a hidden <audio> sink. Subscribes to server player frames over `ws` and reports
 * playback telemetry back. The caller mounts `audioRef` on a real <audio> element.
 * Spec §5: a fresh load can't autoplay without a user gesture / granted permission;
 * a rejected play() surfaces as a playbackError (the operator grants autoplay once).
 */
export function usePlayerRole(
  ws: WebSocket | null,
  isSpeaker: boolean,
): { audioRef: React.RefObject<HTMLAudioElement | null>; volume: number; error: string | null } {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [volume, setVolume] = useState(100);
  const [error, setError] = useState<string | null>(null);
  const lastPosSentRef = useRef(0);
  // Telemetry-binding bookkeeping: the element/socket currently wired up and its teardown.
  const boundElRef = useRef<HTMLAudioElement | null>(null);
  const boundWsRef = useRef<WebSocket | null>(null);
  const boundCleanupRef = useRef<(() => void) | null>(null);
  // Flushes the exact current playback position (bypassing the throttle) for the bound
  // element+socket; set by bindTelemetry, cleared on teardown.
  const flushPositionRef = useRef<(() => void) | null>(null);
  // Latest ws/isSpeaker captured for callbacks invoked outside the current render closure.
  const wsRef = useRef<WebSocket | null>(ws);
  wsRef.current = ws;

  const send = (msg: ClientWsMessage) => {
    // Send only over a live socket. A standards-compliant WebSocket exposes readyState;
    // when it does, require OPEN. Fakes/mocks that omit readyState are treated as sendable.
    const socket = wsRef.current;
    if (!socket) return;
    if (socket.readyState === undefined || socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  };

  /**
   * (Re)bind the audio-element telemetry listeners. Idempotent: a no-op when the same
   * element+socket are already wired. Called both from a render effect and lazily from the
   * message handler, because assigning `audioRef.current` never triggers a render — a
   * dep-gated effect alone would never observe a late-mounted element.
   */
  const bindTelemetry = (el: HTMLAudioElement | null, socket: WebSocket | null) => {
    if (el === boundElRef.current && socket === boundWsRef.current) return;
    boundCleanupRef.current?.();
    boundCleanupRef.current = null;
    boundElRef.current = el;
    boundWsRef.current = socket;
    if (!el || !socket) return;
    const onTime = () => {
      const ms = Math.floor(el.currentTime * 1000);
      if (ms - lastPosSentRef.current >= 900 || ms < lastPosSentRef.current) {
        lastPosSentRef.current = ms;
        send({ type: "position", ms });
      }
    };
    // Flush the true current position, bypassing the 900ms throttle, so the server's
    // last-known position is not stale by up to ~900ms at a track boundary / pause.
    const flushPosition = () => {
      const ms = Math.floor(el.currentTime * 1000);
      lastPosSentRef.current = ms;
      send({ type: "position", ms });
    };
    const onEnded = () => {
      flushPosition();
      send({ type: "trackEnded" });
    };
    // Expose the flush so the pause command handler can report the exact pause position.
    flushPositionRef.current = flushPosition;
    const onError = () => {
      const message = el.error ? `media error ${el.error.code}` : "media error";
      setError(message);
      send({ type: "playbackError", message });
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onError);
    boundCleanupRef.current = () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("error", onError);
      flushPositionRef.current = null;
    };
  };

  // Announce / relinquish the player role on the speaker transition.
  useEffect(() => {
    if (!ws) return;
    if (isSpeaker) {
      send({ type: "becomePlayer" });
    } else {
      send({ type: "relinquishPlayer" });
      audioRef.current?.pause();
    }
  }, [ws, isSpeaker]);

  // Server → player command frames.
  useEffect(() => {
    if (!ws) return;
    const onMessage = (e: MessageEvent) => {
      let msg: ServerPlayerMessage;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      const el = audioRef.current;
      if (!el) return;
      // The element is present now — ensure telemetry listeners are wired (idempotent).
      bindTelemetry(el, ws);
      switch (msg.type) {
        case "load": {
          el.src = msg.audioUrl;
          const startMs = msg.startMs;
          const seekToStart = () => {
            try {
              el.currentTime = startMs / 1000;
            } catch {
              /* ignore */
            }
          };
          el.addEventListener("loadedmetadata", seekToStart, { once: true });
          el.load();
          break;
        }
        case "play":
          setError(null);
          el.play().catch((err: unknown) => {
            const message = err instanceof Error ? err.message : "play blocked";
            setError(message);
            send({ type: "playbackError", message });
          });
          break;
        case "pause":
          el.pause();
          // Report the exact pause position (the last timeupdate is almost always
          // <900ms after the previous send, so the throttle would otherwise drop it).
          flushPositionRef.current?.();
          break;
        case "seek":
          try {
            el.currentTime = msg.ms / 1000;
          } catch {
            /* ignore */
          }
          break;
        case "setVolume": {
          const pct = msg.pct;
          el.volume = Math.max(0, Math.min(1, pct / 100));
          setVolume(pct);
          break;
        }
      }
    };
    ws.addEventListener("message", onMessage as EventListener);
    return () => ws.removeEventListener("message", onMessage as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  // Bind telemetry after each render so a late-mounted <audio> (ref assigned post-mount,
  // which doesn't re-render) gets wired as soon as React commits.
  useEffect(() => {
    bindTelemetry(audioRef.current, ws);
  });

  // Detach the telemetry listeners when the hook unmounts.
  useEffect(() => {
    return () => {
      boundCleanupRef.current?.();
      boundCleanupRef.current = null;
      boundElRef.current = null;
      boundWsRef.current = null;
    };
  }, []);

  return { audioRef, volume, error };
}
