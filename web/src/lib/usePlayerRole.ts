import { useEffect, useRef, useState } from "react";
import type { ServerPlayerMessage, ClientWsMessage } from "../types.js";

/**
 * Owns the audio sink(s) for the active Player. Subscribes to server player frames over
 * `ws`, reports playback telemetry back, and — when `crossfadeSec` > 0 — performs an
 * equal-power crossfade into the next queued track.
 *
 * Crossfade engine (spec):
 *  - TWO <audio> elements: the caller mounts one via `audioRef` (element A); the hook lazily
 *    creates a second, DOM-detached element B. At any moment one is "active" (authoritative,
 *    telemetry-bound) and the other is "idle" (preloading / fading out).
 *  - `nextAudioUrl` is preloaded into the idle element.
 *  - On the ACTIVE element's timeupdate, once currentTime >= duration - crossfadeSec (and a
 *    distinct next is set), the hook starts the idle element, ramps active gain 1→0 and next
 *    gain 0→1 over crossfadeSec via Web Audio GainNodes (equal-power cos/sin), sends
 *    {type:"crossfadeAdvance"} so the server advances current→next WITHOUT re-loading us, and
 *    swaps active↔idle. The faded-out element's 'ended' is IGNORED (its listeners are removed
 *    on swap). Only the ACTIVE element's 'ended' (crossfade off / no next) sends trackEnded —
 *    so the Player emits EITHER crossfadeAdvance OR trackEnded per track, never both.
 *  - A server 'load'/'play' HARD-CUTS: any in-flight fade is cancelled, gains reset, and the
 *    track is loaded into the active element (covers skip / seek / pause / new track).
 *  - pause/seek during a fade cancel the fade (and pause both elements).
 *
 * Volume (spec §5 boost): HTMLMediaElement.volume is spec-capped at 1.0, so >100% is carried
 * by a Web Audio master GainNode; <=100% with no boost/crossfade yet uses native element
 * volume to keep the autoplay/permission behavior unchanged.
 */
export function usePlayerRole(
  ws: WebSocket | null,
  isSpeaker: boolean,
  nextAudioUrl: string | null = null,
  crossfadeSec: number = 0,
): { audioRef: React.RefObject<HTMLAudioElement | null>; volume: number; error: string | null } {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [volume, setVolume] = useState(100);
  const [error, setError] = useState<string | null>(null);
  const lastPosSentRef = useRef(0);

  // Two-element crossfade sinks. audioRef (element A) is mounted by the caller; element B is
  // created lazily and lives detached from the DOM (an <audio> can play without being in the
  // tree). activeElRef is the authoritative/telemetry-bound element; idleElRef preloads the
  // next track and receives the fade-out during a crossfade. They swap on each crossfade.
  const activeElRef = useRef<HTMLAudioElement | null>(null);
  const idleElRef = useRef<HTMLAudioElement | null>(null);

  // Crossfade in-flight bookkeeping.
  const fadingRef = useRef(false);
  const fadeDoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeStepTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Web Audio graph. Each element is wired source → per-element fade GainNode → master
  // GainNode → destination. The master carries volume (incl. >100% boost); the per-element
  // fade gains carry the equal-power crossfade (0..1). Built lazily on first boost/crossfade
  // so the plain <=100% path stays free of Web Audio (autoplay-safe).
  const audioCtxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const fadeGainsRef = useRef<Map<HTMLAudioElement, GainNode>>(new Map());
  const desiredPctRef = useRef(100);

  // Telemetry-binding bookkeeping: the element/socket currently wired up and its teardown.
  const boundElRef = useRef<HTMLAudioElement | null>(null);
  const boundWsRef = useRef<WebSocket | null>(null);
  const boundCleanupRef = useRef<(() => void) | null>(null);
  // Flushes the exact current playback position (bypassing the throttle) for the bound
  // element+socket; set by bindTelemetry, cleared on teardown.
  const flushPositionRef = useRef<(() => void) | null>(null);

  // Latest ws / props captured for callbacks invoked outside the current render closure.
  const wsRef = useRef<WebSocket | null>(ws);
  wsRef.current = ws;
  const nextAudioUrlRef = useRef<string | null>(nextAudioUrl);
  nextAudioUrlRef.current = nextAudioUrl;
  const crossfadeSecRef = useRef<number>(crossfadeSec);
  crossfadeSecRef.current = crossfadeSec;

  const send = (msg: ClientWsMessage) => {
    // Send only over a live socket. A standards-compliant WebSocket exposes readyState;
    // when it does, require OPEN. Fakes/mocks that omit readyState are treated as sendable.
    const socket = wsRef.current;
    if (!socket) return;
    if (socket.readyState === undefined || socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  };

  // --- element lifecycle -----------------------------------------------------------------

  // Adopt the caller-mounted element as the active one the first time it appears.
  const ensureActive = (): HTMLAudioElement | null => {
    if (!activeElRef.current && audioRef.current) activeElRef.current = audioRef.current;
    return activeElRef.current;
  };
  // Lazily create the second (idle) element used for preloading + crossfade.
  const ensureIdle = (): HTMLAudioElement => {
    if (!idleElRef.current) {
      const el = document.createElement("audio");
      el.preload = "auto";
      idleElRef.current = el;
    }
    return idleElRef.current;
  };

  // --- Web Audio graph -------------------------------------------------------------------

  const getCtx = (): AudioContext | null => {
    if (audioCtxRef.current) return audioCtxRef.current;
    const AudioCtx =
      (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    try {
      audioCtxRef.current = new AudioCtx();
      return audioCtxRef.current;
    } catch {
      return null;
    }
  };
  const getMaster = (ctx: AudioContext): GainNode => {
    if (!masterGainRef.current) {
      const g = ctx.createGain();
      g.gain.value = Math.max(0, desiredPctRef.current) / 100;
      g.connect(ctx.destination);
      masterGainRef.current = g;
    }
    return masterGainRef.current;
  };
  // Wire `el` into the graph (once) and return its fade GainNode, or null if Web Audio is
  // unavailable. createMediaElementSource may only be called once per element, so the node is
  // memoized per element.
  const ensureFadeGain = (el: HTMLAudioElement): GainNode | null => {
    const existing = fadeGainsRef.current.get(el);
    if (existing) {
      void audioCtxRef.current?.resume?.();
      return existing;
    }
    const ctx = getCtx();
    if (!ctx) return null;
    try {
      const source = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      gain.gain.value = 1;
      source.connect(gain);
      gain.connect(getMaster(ctx));
      fadeGainsRef.current.set(el, gain);
      void ctx.resume?.();
      return gain;
    } catch {
      return null;
    }
  };

  /**
   * Apply a 0..200(pct) volume. Once the Web Audio graph exists (a prior boost or crossfade
   * built it), volume rides the master GainNode — which can exceed 1.0 — and the elements sit
   * at unity. Before the graph exists, <=100% uses native element.volume (no Web Audio, so
   * autoplay is unaffected) and only a >100% boost lazily builds the graph.
   */
  const applyVolume = (pct: number) => {
    desiredPctRef.current = pct;
    const factor = Math.max(0, pct) / 100;
    const active = activeElRef.current;
    // Graph already built → master carries everything (incl. boost), elements at unity.
    // Read into a local so the truthy-branch narrowing doesn't leak onto masterGainRef.current
    // (ensureFadeGain below builds the master as a side effect TS can't see).
    const builtMaster = masterGainRef.current;
    if (builtMaster) {
      builtMaster.gain.value = factor;
      if (activeElRef.current) activeElRef.current.volume = 1;
      if (idleElRef.current) idleElRef.current.volume = 1;
      return;
    }
    if (factor <= 1) {
      // Native path (autoplay-safe): no Web Audio needed below unity.
      if (active) active.volume = factor;
      return;
    }
    // Boost requested but no graph yet: build it, then master carries the >1.0 factor.
    const gain = active ? ensureFadeGain(active) : null;
    const master = masterGainRef.current;
    if (!gain || !master) {
      // No Web Audio: pin to max so the setting is loud, not silent.
      if (active) active.volume = 1;
      return;
    }
    if (active) active.volume = 1;
    master.gain.value = factor;
  };

  // --- crossfade -------------------------------------------------------------------------

  // Preload the current nextAudioUrl into the idle element (unless a fade is mid-flight, in
  // which case the idle element is still fading out — preload runs when the fade completes).
  const preloadNext = () => {
    if (fadingRef.current) return;
    const idle = ensureIdle();
    const next = nextAudioUrlRef.current;
    if (!next) {
      idle.removeAttribute("src");
      return;
    }
    if (idle.getAttribute("src") !== next) {
      idle.src = next;
      try {
        idle.load();
      } catch {
        /* ignore */
      }
    }
  };

  // Equal-power ramp of a fade GainNode from `from` to `to` over `dur` seconds. Prefers a
  // cos/sin value-curve; degrades to a linear ramp, then an instantaneous set.
  const rampGain = (
    gain: GainNode,
    ctx: AudioContext,
    from: number,
    to: number,
    dur: number,
    shape: "out" | "in",
  ) => {
    const now = ctx.currentTime ?? 0;
    const param = gain.gain;
    try {
      param.cancelScheduledValues?.(now);
    } catch {
      /* ignore */
    }
    try {
      param.setValueAtTime?.(from, now);
    } catch {
      /* ignore */
    }
    if (typeof param.setValueCurveAtTime === "function") {
      const N = 32;
      const curve = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        curve[i] = shape === "out" ? Math.cos((t * Math.PI) / 2) : Math.sin((t * Math.PI) / 2);
      }
      try {
        param.setValueCurveAtTime(curve, now, dur);
        return;
      } catch {
        /* fall through */
      }
    }
    if (typeof param.linearRampToValueAtTime === "function") {
      try {
        param.linearRampToValueAtTime(to, now + dur);
        return;
      } catch {
        /* fall through */
      }
    }
    param.value = to;
  };

  // Fallback fade when Web Audio is unavailable: step element.volume on a timer.
  const startVolumeFade = (outgoing: HTMLAudioElement, incoming: HTMLAudioElement, dur: number) => {
    const factor = Math.min(Math.max(0, desiredPctRef.current), 100) / 100;
    incoming.volume = 0;
    const totalSteps = Math.max(1, Math.round(dur * 20));
    let step = 0;
    if (fadeStepTimerRef.current) clearInterval(fadeStepTimerRef.current);
    fadeStepTimerRef.current = setInterval(() => {
      step++;
      const t = Math.min(1, step / totalSteps);
      outgoing.volume = Math.cos((t * Math.PI) / 2) * factor;
      incoming.volume = Math.sin((t * Math.PI) / 2) * factor;
      if (t >= 1 && fadeStepTimerRef.current) {
        clearInterval(fadeStepTimerRef.current);
        fadeStepTimerRef.current = null;
      }
    }, 50);
  };

  const startFade = (outgoing: HTMLAudioElement, incoming: HTMLAudioElement, dur: number) => {
    const ctx = getCtx();
    const gOut = ctx ? ensureFadeGain(outgoing) : null;
    const gIn = ctx ? ensureFadeGain(incoming) : null;
    if (ctx && gOut && gIn) {
      // Master carries volume; both elements at unity while the fade gains do the crossfade.
      const master = getMaster(ctx);
      master.gain.value = Math.max(0, desiredPctRef.current) / 100;
      outgoing.volume = 1;
      incoming.volume = 1;
      rampGain(gOut, ctx, 1, 0, dur, "out");
      rampGain(gIn, ctx, 0, 1, dur, "in");
      return;
    }
    startVolumeFade(outgoing, incoming, dur);
  };

  // Called on the active element's timeupdate. Kicks off a crossfade once we're within
  // crossfadeSec of the end and a distinct next track is queued.
  const maybeStartCrossfade = (el: HTMLAudioElement) => {
    if (el !== activeElRef.current) return;
    if (fadingRef.current) return;
    const xf = crossfadeSecRef.current;
    const next = nextAudioUrlRef.current;
    if (!(xf > 0) || !next) return;
    const dur = el.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    if (next === el.getAttribute("src")) return; // never crossfade a track into itself
    if (el.currentTime >= dur - xf) startCrossfade();
  };

  const startCrossfade = () => {
    const outgoing = activeElRef.current;
    const next = nextAudioUrlRef.current;
    if (!outgoing || !next) return;
    fadingRef.current = true;
    const incoming = ensureIdle();
    // The next is normally already preloaded into the idle element; ensure it regardless.
    if (incoming.getAttribute("src") !== next) incoming.src = next;
    try {
      incoming.currentTime = 0;
    } catch {
      /* ignore */
    }
    const dur = crossfadeSecRef.current;
    startFade(outgoing, incoming, dur);
    setError(null);
    void incoming.play().catch(() => {
      /* an aborted/blocked next play is non-fatal; the active track keeps going */
    });
    // Tell the server the Player has begun the next track itself: advance current→next
    // WITHOUT a load. Exactly one of crossfadeAdvance / trackEnded is emitted per track.
    send({ type: "crossfadeAdvance" });
    // Swap: the incoming track becomes active (telemetry moves to it); the outgoing track's
    // 'ended' is now ignored because bindTelemetry removes its listeners.
    activeElRef.current = incoming;
    idleElRef.current = outgoing;
    lastPosSentRef.current = 0;
    bindTelemetry(incoming, wsRef.current);
    if (fadeDoneTimerRef.current) clearTimeout(fadeDoneTimerRef.current);
    fadeDoneTimerRef.current = setTimeout(() => finishFade(), dur * 1000 + 250);
  };

  // Natural end of a fade: stop the faded-out (now idle) element and preload the next-next.
  const finishFade = () => {
    if (fadeDoneTimerRef.current) {
      clearTimeout(fadeDoneTimerRef.current);
      fadeDoneTimerRef.current = null;
    }
    if (fadeStepTimerRef.current) {
      clearInterval(fadeStepTimerRef.current);
      fadeStepTimerRef.current = null;
    }
    fadingRef.current = false;
    const idle = idleElRef.current;
    if (idle) {
      try {
        idle.pause();
      } catch {
        /* ignore */
      }
      const g = fadeGainsRef.current.get(idle);
      if (g) g.gain.value = 0;
      else idle.volume = 0;
    }
    preloadNext();
  };

  // Abandon an in-flight fade (hard-cut): stop the abandoned element, restore the active
  // element to full gain. No-op when not fading, so a normal load/play never disturbs gains.
  const cancelFade = () => {
    if (!fadingRef.current) return;
    fadingRef.current = false;
    if (fadeDoneTimerRef.current) {
      clearTimeout(fadeDoneTimerRef.current);
      fadeDoneTimerRef.current = null;
    }
    if (fadeStepTimerRef.current) {
      clearInterval(fadeStepTimerRef.current);
      fadeStepTimerRef.current = null;
    }
    const ctx = audioCtxRef.current;
    const now = ctx?.currentTime ?? 0;
    const active = activeElRef.current;
    const idle = idleElRef.current;
    if (idle) {
      try {
        idle.pause();
      } catch {
        /* ignore */
      }
      const g = fadeGainsRef.current.get(idle);
      if (g) {
        try {
          g.gain.cancelScheduledValues?.(now);
        } catch {
          /* ignore */
        }
        g.gain.value = 0;
      } else {
        idle.volume = 0;
      }
    }
    if (active) {
      const g = fadeGainsRef.current.get(active);
      if (g) {
        try {
          g.gain.cancelScheduledValues?.(now);
        } catch {
          /* ignore */
        }
        g.gain.value = 1;
      } else {
        active.volume = Math.min(Math.max(0, desiredPctRef.current), 100) / 100;
      }
    }
  };

  // --- telemetry -------------------------------------------------------------------------

  /**
   * (Re)bind the audio-element telemetry listeners to the ACTIVE element. Idempotent: a no-op
   * when the same element+socket are already wired. On a crossfade swap this rebinds to the
   * new active element, which removes the outgoing element's listeners — so the faded-out
   * track's 'ended' is ignored and only the active element reports trackEnded.
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
      maybeStartCrossfade(el);
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
        activeElRef.current?.pause();
        idleElRef.current?.pause();
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
      const el = ensureActive();
      if (!el) return;
      // The element is present now — ensure telemetry listeners are wired (idempotent).
      bindTelemetry(el, ws);
      switch (msg.type) {
        case "load": {
          // Hard-cut: abandon any in-flight fade, then (re)load the active element.
          cancelFade();
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
          // Hard-cut guard: cancelFade is a no-op unless a fade is genuinely in flight.
          cancelFade();
          setError(null);
          el.play().catch((err: unknown) => {
            // A play() rejected because a newer load()/pause() superseded it is BENIGN: the
            // browser throws a DOMException named "AbortError" ("interrupted by a new load
            // request" / "by a call to pause()"). Reporting it as a playbackError makes the
            // server treat it as a real failure and DISCARD/skip the track — an error-skip
            // cascade that preempts the user's just-queued song with a radio track. Swallow
            // AbortError; still surface everything else (NotAllowedError autoplay-block,
            // decode/network errors) so genuine failures reach the "Skipped …" banner.
            const name =
              typeof err === "object" && err !== null && "name" in err
                ? String((err as { name: unknown }).name)
                : "";
            if (name === "AbortError") return;
            const message = err instanceof Error ? err.message : "play blocked";
            setError(message);
            send({ type: "playbackError", message });
          });
          break;
        case "pause":
          // A pause during a fade cancels the fade and pauses both elements.
          cancelFade();
          el.pause();
          idleElRef.current?.pause();
          // Report the exact pause position (the last timeupdate is almost always
          // <900ms after the previous send, so the throttle would otherwise drop it).
          flushPositionRef.current?.();
          break;
        case "seek":
          // A seek during a fade cancels it, then seeks the active element.
          cancelFade();
          try {
            el.currentTime = msg.ms / 1000;
          } catch {
            /* ignore */
          }
          break;
        case "setVolume": {
          const pct = msg.pct;
          applyVolume(pct);
          setVolume(pct);
          break;
        }
      }
    };
    ws.addEventListener("message", onMessage as EventListener);
    return () => ws.removeEventListener("message", onMessage as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  // Preload the next track into the idle element whenever it changes.
  useEffect(() => {
    preloadNext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextAudioUrl]);

  // Bind telemetry after each render so a late-mounted <audio> (ref assigned post-mount,
  // which doesn't re-render) gets wired as soon as React commits. Binds the ACTIVE element,
  // never blindly audioRef — after a crossfade swap the active element may be element B.
  useEffect(() => {
    bindTelemetry(ensureActive(), wsRef.current);
  });

  // Tear everything down on unmount.
  useEffect(() => {
    return () => {
      boundCleanupRef.current?.();
      boundCleanupRef.current = null;
      boundElRef.current = null;
      boundWsRef.current = null;
      if (fadeDoneTimerRef.current) clearTimeout(fadeDoneTimerRef.current);
      fadeDoneTimerRef.current = null;
      if (fadeStepTimerRef.current) clearInterval(fadeStepTimerRef.current);
      fadeStepTimerRef.current = null;
      fadingRef.current = false;
      try {
        activeElRef.current?.pause();
      } catch {
        /* ignore */
      }
      try {
        idleElRef.current?.pause();
      } catch {
        /* ignore */
      }
      activeElRef.current = null;
      idleElRef.current = null;
      fadeGainsRef.current.clear();
      masterGainRef.current = null;
      const ctx = audioCtxRef.current;
      audioCtxRef.current = null;
      void ctx?.close?.();
    };
  }, []);

  return { audioRef, volume, error };
}
