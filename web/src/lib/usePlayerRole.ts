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
  // Web Audio graph used to honor the 0..200 boost contract: HTMLMediaElement.volume is
  // spec-capped at 1.0, so anything above 100% would be a silent no-op. Routing the element
  // through a GainNode (gain = pct/100) lets 101..200% actually amplify. Created lazily on
  // the first setVolume that needs it (a user gesture will have unlocked the AudioContext),
  // and reused thereafter. The latest requested pct is remembered so the graph, once wired,
  // can adopt it immediately.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const gainSourceElRef = useRef<HTMLAudioElement | null>(null);
  const desiredPctRef = useRef(100);
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
   * Apply a 0..200(pct) volume to `el`. For pct <= 100 the native element.volume is enough
   * (no Web Audio needed, so autoplay/permission behavior is unchanged). For pct > 100 we
   * must amplify via a GainNode, since element.volume is spec-capped at 1.0. The graph is
   * built lazily and only when boost is actually requested; if the AudioContext can't be
   * created (unsupported / no user gesture yet) we fall back to element.volume = 1.0 so the
   * setting is at least at max rather than silent.
   */
  const applyVolume = (el: HTMLAudioElement, pct: number) => {
    desiredPctRef.current = pct;
    const clampedPct = Math.max(0, pct);
    if (clampedPct <= 100) {
      // Below unity: native volume is exact. Keep any existing gain node at unity so a
      // previously-boosted graph doesn't keep amplifying.
      el.volume = clampedPct / 100;
      if (gainNodeRef.current) gainNodeRef.current.gain.value = 1;
      return;
    }
    // Boost path: element at max, GainNode carries the >1.0 factor.
    el.volume = 1;
    const AudioCtx =
      (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return; // No Web Audio: element is already at max (1.0).
    try {
      let ctx = audioCtxRef.current;
      if (!ctx) {
        ctx = new AudioCtx();
        audioCtxRef.current = ctx;
      }
      void ctx.resume?.();
      // Wire (or re-wire) the element into the graph. createMediaElementSource can only be
      // called once per element, so re-create the source only when the element changes.
      if (gainSourceElRef.current !== el || !gainNodeRef.current) {
        const source = ctx.createMediaElementSource(el);
        const gain = ctx.createGain();
        source.connect(gain);
        gain.connect(ctx.destination);
        gainNodeRef.current = gain;
        gainSourceElRef.current = el;
      }
      gainNodeRef.current.gain.value = clampedPct / 100;
    } catch {
      // Graph construction failed (e.g. element already sourced by a stale ctx): leave the
      // element at max volume so the setting is not silent.
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
  //
  // The socket is exposed to us the instant it is created — often still CONNECTING (before
  // its 'open' event), and the reference does NOT change when it transitions to OPEN. send()
  // only transmits over an OPEN socket, so announcing immediately here would silently drop
  // the frame on every reconnect (network blip, tab backgrounding, backoff), and the effect
  // would never re-run to retry — the remembered speaker would lose the Player role. So:
  // announce now if already OPEN, otherwise attach a one-shot 'open' listener that announces
  // once the socket actually opens. The listener is removed on cleanup.
  useEffect(() => {
    if (!ws) return;
    const announce = () => {
      if (isSpeaker) {
        send({ type: "becomePlayer" });
      } else {
        send({ type: "relinquishPlayer" });
        audioRef.current?.pause();
      }
    };
    // readyState === undefined covers test fakes that omit it (treated as sendable/open).
    if (ws.readyState === undefined || ws.readyState === WebSocket.OPEN) {
      announce();
      return;
    }
    ws.addEventListener("open", announce);
    return () => ws.removeEventListener("open", announce);
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
          applyVolume(el, pct);
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
      gainNodeRef.current = null;
      gainSourceElRef.current = null;
      const ctx = audioCtxRef.current;
      audioCtxRef.current = null;
      void ctx?.close?.();
    };
  }, []);

  return { audioRef, volume, error };
}
