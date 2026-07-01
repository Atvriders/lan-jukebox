import { useCallback, useEffect, useRef, useState } from "react";
import type { CurrentItem } from "../types.js";
import { fmtAudio, fmtTime } from "../lib/format.js";

// Display progress indicator. We extrapolate the elapsed position between WS state
// updates so the bar MOVES smoothly. When `canSeek` is set the same bar becomes an
// interactive scrubber (click/drag to seek); otherwise it stays read-only.
function useDisplayedMs(
  positionMs: number,
  durationMs: number,
  paused: boolean,
  receivedAt: number,
): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (paused) return;
    const iv = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(iv);
  }, [paused, receivedAt]);
  // receivedAt<=0 means "no real timestamp yet" (the REST-seeded first render before any
  // WS 'state' frame). Extrapolating against it would be Date.now() - 0 ≈ epoch-scale ms,
  // pinning a playing bar to 100%. Treat it as no extrapolation until a real frame arrives.
  const base = receivedAt > 0 ? Date.now() - receivedAt : 0;
  const raw = paused ? positionMs : positionMs + base;
  const upper = durationMs > 0 ? durationMs : Infinity;
  return Math.max(0, Math.min(raw, upper));
}

// The signature "ON AIR" tally lamp: banked/idle while waiting for a seed (dim bulb),
// ignited amber the moment the station is broadcasting. Driven by the design system's
// `.tally` rule via the [data-live] attribute — no bespoke styling here.
function OnAirTally({ live }: { live: boolean }) {
  return (
    <span
      className="tally"
      data-testid="on-air-tally"
      data-live={live ? "true" : "false"}
      role="status"
      aria-label={live ? "On air" : "Off air — standby"}
    >
      {live ? "On Air" : "Standby"}
    </span>
  );
}

// The now-playing VU-meter motif: five amber level bars breathing (the `.vu-bars`
// modifier). Purely decorative — a warm ambient level readout, NOT a real spectrum.
function VuMeter() {
  return (
    <span className="vu-bars" aria-hidden data-testid="vu-meter">
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

export function NowPlaying({
  item,
  paused = false,
  receivedAt = 0,
  canSeek = false,
  onSeek,
}: {
  item: CurrentItem | null;
  paused?: boolean;
  receivedAt?: number;
  /** Whether the viewer may scrub. When false the bar is read-only. */
  canSeek?: boolean;
  /** Seek handler; receives the target position in ms. May return a promise that rejects on failure. */
  onSeek?: (positionMs: number) => void | Promise<void>;
}) {
  const displayedMs = useDisplayedMs(
    item?.positionMs ?? 0,
    item?.durationMs ?? 0,
    paused,
    receivedAt,
  );

  if (!item) {
    return (
      <section className="card reveal p-8" aria-label="Now playing" style={{ overflow: "hidden" }}>
        {/* Soft amber bloom behind the standby deck — banked, since nothing is on the line. */}
        <div className="hero-glow" style={{ opacity: 0.35 }} />
        <div className="relative z-10 flex items-start gap-5">
          {/* Machined empty meter slot — the deck idling, no signal on the line. */}
          <div
            data-testid="now-playing-thumb-placeholder"
            aria-hidden
            className="shrink-0 grid place-items-center"
            style={{
              width: 56,
              height: 56,
              borderRadius: "var(--radius-sm)",
              background: "var(--color-sunken)",
              border: "1px solid var(--color-line)",
              boxShadow: "var(--shadow-inset)",
              color: "var(--color-ink-faint)",
            }}
          >
            <span className="font-mono text-xs tracking-widest">––</span>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <p className="eyebrow">Now playing</p>
              <OnAirTally live={false} />
            </div>
            <p className="font-display text-3xl mt-3" style={{ color: "var(--color-ink-dim)" }}>
              Nothing is playing.
            </p>
            <p className="mt-2 text-sm" style={{ color: "var(--color-ink-faint)" }}>
              Queue a YouTube link or search below to start the set.
            </p>
            <p
              className="mt-4 font-mono text-xs tracking-widest"
              style={{ color: "var(--color-ink-faint)" }}
            >
              ── STANDBY ──
            </p>
          </div>
        </div>
      </section>
    );
  }
  const { meta, requester, durationMs } = item;
  const audioLabel = fmtAudio(item.audio);
  // The station is "on air" whenever a track is loaded and not paused.
  const live = !paused;
  return (
    <section
      className="card reveal p-7 sm:p-8"
      aria-label="Now playing"
      style={{ overflow: "hidden" }}
    >
      {/* The signature amber hero-glow bloom behind the on-air area. */}
      <div className="hero-glow" />
      <div className="relative z-10 flex gap-6">
        {/* Album art seated in a machined faceplate slot — inset rim, contact shadow.
            yt-dlp doesn't always return a thumbnail (older uploads / some search entries);
            render a styled placeholder rather than an <img src=""> (which the browser
            resolves as a spurious same-origin GET + broken-image icon in the hero slot). */}
        <div className="shrink-0 relative">
          {meta.thumbnailUrl ? (
            <img
              src={meta.thumbnailUrl}
              alt=""
              width={132}
              height={132}
              className="object-cover"
              style={{
                width: 132,
                height: 132,
                borderRadius: "var(--radius-md)",
                boxShadow: "0 10px 28px -12px rgba(0,0,0,0.7)",
              }}
            />
          ) : (
            <span
              aria-hidden
              data-testid="now-playing-thumb-placeholder"
              className="grid place-items-center"
              style={{
                width: 132,
                height: 132,
                borderRadius: "var(--radius-md)",
                boxShadow: "0 10px 28px -12px rgba(0,0,0,0.7)",
                background:
                  "radial-gradient(120% 90% at 50% 0%, rgba(255,255,255,0.10), transparent 60%)," +
                  "linear-gradient(180deg, var(--color-raised) 0%, var(--color-sunken) 100%)",
                color: "var(--color-ink-faint)",
              }}
            >
              <svg
                width={48}
                height={48}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ filter: "drop-shadow(0 1px 0 rgba(0,0,0,0.5))" }}
              >
                <path d="M9 18V5l12-2v13" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="16" r="3" />
              </svg>
            </span>
          )}
          {/* carved seam + faint amber rim-light, like a lit jewel set into the deck */}
          <span
            className="absolute inset-0"
            aria-hidden
            style={{
              borderRadius: "var(--radius-md)",
              boxShadow:
                "inset 0 0 0 1px var(--color-line), inset 0 0 22px -10px rgba(255,255,255,0.35)",
            }}
          />
        </div>
        <div className="min-w-0 flex-1">
          {/* On-air brand-plate: the amber "Now playing" silkscreen + the ON-AIR tally lamp. */}
          <div className="flex items-center gap-3">
            <p className="eyebrow" style={{ color: "var(--color-ember-soft)" }}>
              Now playing
            </p>
            <OnAirTally live={live} />
          </div>
          <h1
            className="font-display text-3xl sm:text-4xl leading-tight mt-2 truncate"
            title={meta.title}
          >
            {meta.title}
          </h1>
          <p className="mt-1 text-sm" style={{ color: "var(--color-ink-dim)" }}>
            {meta.channel}
          </p>
          <div className="mt-3 flex items-center gap-3 flex-wrap">
            {audioLabel && (
              <span
                className="font-mono text-xs tracking-wide inline-flex items-center"
                style={{
                  color: "var(--color-ink-faint)",
                  padding: "0.2rem 0.6rem",
                  borderRadius: "var(--radius-pill)",
                  background: "var(--color-sunken)",
                  boxShadow: "var(--shadow-inset)",
                }}
              >
                {audioLabel}
              </span>
            )}
            {/* The hero's lit VU level array — the now-playing motif. */}
            <VuMeter />
          </div>
          <ProgressBar
            durationMs={durationMs}
            displayedMs={displayedMs}
            receivedAt={receivedAt}
            canSeek={canSeek}
            onSeek={onSeek}
          />
          {/* Requester strip — a small engraved credit line on the deck. displayName only
              (no avatar); the mono source tag ("· user" / "· autoplay") is kept. */}
          <div
            className="flex items-center gap-2 mt-4 pt-4"
            style={{ borderTop: "1px solid var(--color-line)" }}
          >
            <span className="text-xs" style={{ color: "var(--color-ink-dim)" }}>
              requested by{" "}
              <strong style={{ color: "var(--color-fg)" }}>{requester.displayName}</strong>
              <span className="font-mono" style={{ color: "var(--color-ink-faint)" }}>
                {" "}
                · {requester.source}
              </span>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

interface ProgressBarProps {
  /** Track duration in ms (0/undefined for a live stream — not seekable). */
  durationMs: number;
  /** Server-extrapolated elapsed position in ms (what the bar renders when not dragging). */
  displayedMs: number;
  /**
   * Snapshot identity — bumps on every WS state broadcast. We treat a change here (after a
   * seek was issued) as the server CONFIRMING the seek, which is when we release the
   * optimistic hold (see below).
   */
  receivedAt: number;
  canSeek: boolean;
  /** May return a promise; a rejection releases the optimistic hold (failed seek). */
  onSeek?: (positionMs: number) => void | Promise<void>;
}

/**
 * Progress / scrub bar. Read-only by default (role="progressbar"); when `canSeek` and the
 * track has a known duration, the same bar becomes an interactive slider — click anywhere to
 * seek, or drag the handle to scrub.
 *
 * Responsiveness model (why the scrub no longer "lags"):
 *  - While dragging we show the drag target locally (`dragMs`) — the bar moves with the pointer.
 *  - We seek the server ONLY on release (one call), never per pointer-move, so we don't spam the
 *    API / restart ffmpeg repeatedly mid-drag.
 *  - On release we keep an OPTIMISTIC hold (`pendingMs`) at the target instead of snapping back to
 *    the stale `displayedMs`. The hold persists until the next WS snapshot lands (`receivedAt`
 *    changes) — i.e. the server has confirmed the seek — at which point the bar follows the server
 *    again. Without this hold the bar would visibly jump back to the old position for the
 *    network + ffmpeg-respawn round-trip, which is the lag the user reported.
 *
 * Seeking still triggers a brief audible gap server-side while ffmpeg re-opens the cached file at
 * the new offset; we surface a small "seeking" affordance during the hold.
 */
function ProgressBar({ durationMs, displayedMs, receivedAt, canSeek, onSeek }: ProgressBarProps) {
  const interactive = canSeek && durationMs > 0;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [dragMs, setDragMs] = useState<number | null>(null);
  // Optimistic position held after release until the server confirms the seek.
  const [pendingMs, setPendingMs] = useState<number | null>(null);
  // The snapshot id in effect when the seek was issued; a later id means "confirmed".
  const seekSnapshotRef = useRef<number | null>(null);
  // Monotonic generation for in-flight seeks. Each new gesture/commit bumps it so a stale
  // rejection from a SUPERSEDED seek is a no-op (it must not clear the live gesture's hold).
  const seekGenRef = useRef(0);

  // Release the optimistic hold once a fresh snapshot lands (the server has applied the seek).
  useEffect(() => {
    if (pendingMs === null) return;
    if (seekSnapshotRef.current !== null && receivedAt !== seekSnapshotRef.current) {
      setPendingMs(null);
      seekSnapshotRef.current = null;
    }
  }, [receivedAt, pendingMs]);

  const posFromClientX = useCallback(
    (clientX: number): number => {
      const el = trackRef.current;
      if (!el || durationMs <= 0) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
      return Math.max(0, Math.min(1, ratio)) * durationMs;
    },
    [durationMs],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!interactive) return;
      e.preventDefault();
      draggingRef.current = true;
      // Drop any prior optimistic hold — this new gesture supersedes it. Bump the seek
      // generation so a prior in-flight seek's late rejection can't clear this gesture.
      seekGenRef.current++;
      setPendingMs(null);
      seekSnapshotRef.current = null;
      setDragMs(posFromClientX(e.clientX));
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    },
    [interactive, posFromClientX],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      setDragMs(posFromClientX(e.clientX));
    },
    [posFromClientX],
  );

  // The position the bar currently shows: the live drag target, else the optimistic hold,
  // else the server-extrapolated position. Computed here (above the keyboard handler) so the
  // keyboard scrub can step relative to what the user actually sees.
  const shownMs = dragMs ?? pendingMs ?? displayedMs;

  // Commit a seek to `target` (ms) through the optimistic-hold path: hold the target until
  // the server confirms (next snapshot), and release the hold if the seek fails (a failed
  // seek emits no confirming snapshot, so without this the bar would stay pinned with the
  // "seeking…" indicator pulsing forever). Shared by pointer-release AND keyboard.
  const commitSeek = useCallback(
    (target: number) => {
      const clamped = Math.round(Math.max(0, Math.min(durationMs, target)));
      const gen = ++seekGenRef.current; // this commit supersedes any prior in-flight seek
      setDragMs(null);
      setPendingMs(clamped);
      seekSnapshotRef.current = receivedAt;
      Promise.resolve(onSeek?.(clamped)).catch(() => {
        // A superseded seek's late rejection must NOT clear the newer gesture's hold.
        if (gen !== seekGenRef.current) return;
        setPendingMs(null);
        seekSnapshotRef.current = null;
      });
    },
    [durationMs, onSeek, receivedAt],
  );

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      commitSeek(posFromClientX(e.clientX));
    },
    [posFromClientX, commitSeek],
  );

  // Keyboard scrubbing: the slider is focusable (tabIndex when interactive) and responds
  // to Arrow/Page/Home/End, computing a clamped target from the currently-shown position
  // and committing through the same optimistic-hold path as a pointer release. Without
  // this the role="slider" would be a lie for keyboard/screen-reader users.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!interactive) return;
      const STEP = 5000;
      const PAGE = 30000;
      let target: number | null = null;
      switch (e.key) {
        case "ArrowLeft":
        case "ArrowDown":
          target = shownMs - STEP;
          break;
        case "ArrowRight":
        case "ArrowUp":
          target = shownMs + STEP;
          break;
        case "PageDown":
          target = shownMs - PAGE;
          break;
        case "PageUp":
          target = shownMs + PAGE;
          break;
        case "Home":
          target = 0;
          break;
        case "End":
          target = durationMs;
          break;
        default:
          return; // not a scrub key — let the event through
      }
      e.preventDefault();
      commitSeek(target);
    },
    [interactive, durationMs, commitSeek, shownMs],
  );

  // A cancelled pointer gesture (touch taken over by scroll, device disconnected) carries
  // no meaningful release coordinate — DISCARD it rather than committing a spurious seek
  // (often to position 0). Distinct from endDrag, which commits a genuine release.
  const cancelDrag = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragMs(null);
    // No setPendingMs and no onSeek — the gesture is abandoned.
  }, []);

  // If the bar stops being interactive while an optimistic hold is active (the socket
  // dropped to forbidden/closed and canSeek flipped false), the confirming snapshot can
  // never arrive — clear the hold so the "seeking…" indicator doesn't freeze and the bar
  // falls back to the server-extrapolated position.
  useEffect(() => {
    if (!interactive) {
      setPendingMs(null);
      setDragMs(null);
      seekSnapshotRef.current = null;
    }
  }, [interactive]);

  const seeking = pendingMs !== null;
  const pct = durationMs > 0 ? Math.max(0, Math.min(100, (shownMs / durationMs) * 100)) : 0;
  const elapsedLabel = fmtTime(shownMs / 1000);
  const durationLabel = durationMs > 0 ? fmtTime(durationMs / 1000) : "live feed";

  return (
    <div className="mt-5">
      <div
        ref={trackRef}
        className="vu"
        role={interactive ? "slider" : "progressbar"}
        aria-label={interactive ? "Seek" : "Playback progress"}
        aria-orientation={interactive ? "horizontal" : undefined}
        aria-valuemin={0}
        aria-valuemax={durationMs > 0 ? Math.round(durationMs / 1000) : undefined}
        aria-valuenow={Math.round(shownMs / 1000)}
        // Only a real, operable slider is focusable + key-driven; the read-only
        // progressbar stays inert (no tabIndex/keydown).
        tabIndex={interactive ? 0 : -1}
        onKeyDown={interactive ? onKeyDown : undefined}
        style={{
          position: "relative",
          cursor: interactive ? "pointer" : undefined,
          touchAction: interactive ? "none" : undefined,
          overflow: interactive ? "visible" : undefined,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={cancelDrag}
      >
        {/* The backlit amber signal level the .vu rule widens + blooms. */}
        <span data-testid="progress-fill" style={{ width: `${pct}%` }} />
        {interactive && (
          /* Machined glowing seek knob — escapes the well (overflow:visible inline). */
          <span
            data-testid="seek-handle"
            aria-hidden
            style={{
              position: "absolute",
              top: "50%",
              left: `${pct}%`,
              transform: "translate(-50%, -50%)",
              width: 14,
              height: 14,
              borderRadius: "50%",
              border: "1px solid var(--color-ember-deep)",
              background:
                "radial-gradient(circle at 35% 30%, var(--color-accent-hi) 0%, var(--color-accent) 55%, var(--color-ember-deep) 100%)",
              boxShadow: seeking
                ? "0 1px 3px 0 rgba(0,0,0,0.6), 0 0 16px 0 rgba(255,255,255,0.9)"
                : "0 1px 3px 0 rgba(0,0,0,0.6), 0 0 12px -2px rgba(255,255,255,0.8)",
              pointerEvents: "none",
            }}
          />
        )}
      </div>
      {/* Console counter readout: elapsed on the left, duration/"live feed" on the right. */}
      <div
        className="flex items-center justify-between mt-2 font-mono text-xs"
        style={{ color: "var(--color-ink-faint)" }}
      >
        <span className="flex items-center gap-2">
          <span style={{ color: "var(--color-ink-dim)" }}>{elapsedLabel}</span>
          {seeking && (
            <span
              data-testid="seeking-indicator"
              className="animate-pulse"
              style={{ color: "var(--color-ember-soft)" }}
            >
              seeking…
            </span>
          )}
        </span>
        <span>{durationLabel}</span>
      </div>
    </div>
  );
}
