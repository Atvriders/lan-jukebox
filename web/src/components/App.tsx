import { useCallback, useEffect, useState } from "react";
import type {
  ControlAction,
  ControlRequest,
  StationSettings,
  StationSnapshot,
  StationStateResponse,
} from "../types.js";
import { api, ApiError } from "../lib/api.js";
import { getDeviceId } from "../lib/deviceId.js";
import { useStationState } from "../lib/useStationState.js";
import { usePlayerRole } from "../lib/usePlayerRole.js";
import { LoginGate } from "./LoginGate.js";
import { PlayerPanel } from "./PlayerPanel.js";
import { AddBar } from "./AddBar.js";
import { Controls } from "./Controls.js";
import { NowPlaying } from "./NowPlaying.js";
import { Preparing } from "./Preparing.js";
import { Queue } from "./Queue.js";
import { History } from "./History.js";
import { Lyrics } from "./Lyrics.js";
import { Settings } from "./Settings.js";
import { Listeners } from "./Listeners.js";
import { Grain } from "./Grain.js";

type AuthState = "checking" | "anon" | "authed";

/**
 * App root — the "On-Air Broadcast Console" shell.
 *
 * Responsibilities:
 *  - Session gate: probe GET /api/state on mount; a 401 renders the LoginGate,
 *    any success renders the console.
 *  - deviceId bootstrap: mint the persistent device token BEFORE the WS connects
 *    (the socket's hello frame carries it).
 *  - Snapshot source: the WS 'state' broadcast is the live truth, but the very
 *    first REST /api/state result seeds an immediate snapshot so the console (and
 *    the cold-start banner) render before the first WS frame arrives. The per-viewer
 *    `isThisDeviceSpeaker` flag also lives only on the REST response.
 *  - Cold-start banner: shown exactly when seed === null && current === null (never
 *    while auth === "checking"), otherwise the live station.
 *  - Optimistic pause + server-confirmation guard: a just-issued pause is reflected
 *    immediately and held until the server's snapshot confirms the op's target paused
 *    value (or a safety timeout), so a stale WS snapshot that predates the op — still
 *    carrying the old paused value — can't revert it.
 *  - Auto-speaker: `wantsSpeaker` is initialized true when the server marks this
 *    device the remembered/auto-selected speaker (isThisDeviceSpeaker), so the Player
 *    role auto-engages over the WS via usePlayerRole.
 */
export function App() {
  const [auth, setAuth] = useState<AuthState>("checking");
  // The immediate REST snapshot (a per-viewer StationStateResponse). Used until — and
  // as a fallback alongside — the WS broadcast; carries isThisDeviceSpeaker.
  const [restSnap, setRestSnap] = useState<StationStateResponse | null>(null);
  // Local speaker intent. Initialized from isThisDeviceSpeaker so the remembered
  // speaker auto-engages; toggled by the manual "Play on this device" / relinquish.
  const [wantsSpeaker, setWantsSpeaker] = useState(false);

  // Optimistic-pause guard. Each pause/play op stamps the op's target paused state and the
  // wall-clock; a WS snapshot only overrides the optimistic value once the server confirms
  // the op's target (or a safety timeout elapses) — see effectivePaused.
  const [optimistic, setOptimistic] = useState<{
    paused: boolean;
    at: number;
  } | null>(null);

  // Live-listeners drawer visibility, toggled by the header "Listeners (N)" button.
  const [listenersOpen, setListenersOpen] = useState(false);

  const ws = useStationState();

  // Bootstrap: ensure a deviceId exists, then probe the session.
  useEffect(() => {
    getDeviceId();
    let alive = true;
    api
      .state()
      .then((s) => {
        if (!alive) return;
        setRestSnap(s);
        setWantsSpeaker(s.isThisDeviceSpeaker);
        setAuth("authed");
      })
      .catch((e) => {
        if (!alive) return;
        setAuth(e instanceof ApiError && e.status === 401 ? "anon" : "authed");
      });
    return () => {
      alive = false;
    };
  }, []);

  // The live snapshot (WS broadcast is truth, REST seed is the fallback) — needed here,
  // ABOVE the auth early-returns, because usePlayerRole is a hook and must run every render.
  // It feeds the crossfade engine the next queued track's audio URL + the crossfade length.
  const playerSnap: StationSnapshot | null = ws.snapshot ?? restSnap;
  const nextAudioUrl = playerSnap?.upcoming?.[0]
    ? "/audio/" + playerSnap.upcoming[0].meta.videoId
    : null;
  const crossfadeSec = playerSnap?.crossfadeSec ?? 10;

  // Claiming the Player needs the per-socket audio sink, so it happens over the WS
  // (usePlayerRole sends becomePlayer/relinquishPlayer as `isSpeaker` flips), NOT REST.
  const { audioRef, error: playerError } = usePlayerRole(
    ws.socket,
    wantsSpeaker,
    nextAudioUrl,
    crossfadeSec,
  );

  // A transient error banner fed by wsState.lastError (trackError frames). Keyed on the
  // monotonic seq so a repeat of the same title still re-surfaces, and auto-dismisses.
  const [errorBanner, setErrorBanner] = useState<{ title: string; reason: string } | null>(null);
  useEffect(() => {
    if (!ws.lastError) return;
    setErrorBanner({ title: ws.lastError.title, reason: ws.lastError.reason });
    const t = setTimeout(() => setErrorBanner(null), 6000);
    return () => clearTimeout(t);
    // Fire only on a NEW error (monotonic seq), not on lastError object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.lastError?.seq]);

  // Action errors (add / pick / re-queue REST failures) surfaced as a transient banner.
  // Without this a bad link, a rejected/too-long input, a failed search, or an unavailable
  // pick is a SILENT no-op (input just clears) + an uncaught promise rejection.
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => {
    if (!actionError) return;
    const t = setTimeout(() => setActionError(null), 6000);
    return () => clearTimeout(t);
  }, [actionError]);
  const noteError = useCallback((e: unknown, fallback: string) => {
    const msg =
      e instanceof ApiError
        ? e.status === 401
          ? "Session expired — reload and log in again."
          : e.message || fallback
        : e instanceof Error && e.message
          ? e.message
          : fallback;
    setActionError(msg);
  }, []);

  // Wrap POST /api/control so a pause/play stamps the optimistic paused state.
  const control = useCallback((action: ControlAction, value?: ControlRequest["value"]) => {
    if (action === "pause" || action === "play") {
      setOptimistic({ paused: action === "pause", at: Date.now() });
    }
    return api.control(action, value).catch(() => {
      /* the WS snapshot remains the source of truth on failure */
    });
  }, []);

  const becomeSpeaker = useCallback(() => setWantsSpeaker(true), []);
  const relinquish = useCallback(() => {
    // Stop announcing the role over the WS, and best-effort clear the persisted
    // designation via REST (api.speaker("claim") is never sent — the backend 400s it).
    setWantsSpeaker(false);
    void api.speaker("release").catch(() => {});
  }, []);

  if (auth === "checking") {
    return (
      <main className="min-h-dvh grid place-items-center">
        <span className="spinner" aria-label="Loading" />
      </main>
    );
  }
  // Login-required: either the REST probe returned 401 (auth === "anon"), or the WS was
  // closed 1008/4403 (ws.status === "forbidden") because the session cookie is missing/
  // expired. Both surface the LoginGate rather than looping reconnects.
  if (auth === "anon" || ws.status === "forbidden") {
    return (
      <LoginGate
        onAuthed={() => {
          // Full reload after login. The /ws socket opened before login was rejected
          // (1008, no session) and the hook stops retrying a forbidden socket, so simply
          // flipping auth to "authed" would leave ws.status === "forbidden" latched —
          // which the gate above still treats as "show login", so the app never advances.
          // Reloading re-runs bootstrap with the new session cookie present on BOTH the
          // REST probe and the /ws upgrade, yielding an authenticated live socket + state.
          window.location.reload();
        }}
      />
    );
  }

  // The WS broadcast is the live truth; fall back to the immediate REST snapshot
  // (which is a superset) until the first WS frame lands. Same source as playerSnap above.
  const snap: StationSnapshot | null = playerSnap;
  const receivedAt = ws.snapshot ? ws.receivedAt : 0;

  // Cold-start: exactly seed === null && current === null (never while checking auth).
  const coldStart = snap !== null && snap.seed === null && snap.current === null;

  // Effective paused = optimistic value until the server CONFIRMS the op, then the server
  // wins. Because a StationSnapshot carries no sequence/generation field, wall-clock arrival
  // (ws.receivedAt) cannot distinguish a snapshot generated BEFORE the op (still the old
  // paused value, but arriving late) from one generated AFTER it — using arrival time alone
  // lets a stale pre-op broadcast that was in flight when the user clicked revert the
  // optimistic pause. Instead we hold the optimistic value until the server's paused matches
  // the op's target (confirmation) or a safety timeout elapses; a snapshot still showing the
  // pre-op value is treated as stale and does NOT override.
  const serverPaused = snap?.paused ?? false;
  let effectivePaused = serverPaused;
  if (optimistic) {
    const serverConfirmedOp = serverPaused === optimistic.paused;
    const timedOut = Date.now() - optimistic.at > 4000;
    effectivePaused = serverConfirmedOp || timedOut ? serverPaused : optimistic.paused;
  }

  const currentVideoId = snap?.current?.meta.videoId ?? null;

  return (
    <main className="min-h-full px-4 py-6 sm:px-8 max-w-5xl mx-auto">
      <Grain />
      <header
        className="reveal flex items-center justify-between mb-6"
        style={{ animationDelay: "0ms" }}
      >
        <p className="eyebrow" style={{ color: "var(--color-ember-soft)" }}>
          LAN Jukebox
        </p>
        <div className="flex items-center gap-4">
          <button
            type="button"
            className="pill pill-ghost"
            style={{ padding: "0.35rem 0.8rem", fontSize: "0.75rem" }}
            aria-haspopup="dialog"
            aria-expanded={listenersOpen}
            onClick={() => setListenersOpen((v) => !v)}
          >
            Listeners ({snap?.listeners?.length ?? 0})
          </button>
          {/* Live region so a screen reader is told when the station's speaker comes/goes — a
            critical state for an always-playing radio (no speaker = nothing produces audio). The
            text alone ("… live" / "No speaker") conveys the state; the ●/○ glyph is decorative. */}
          <span
            role="status"
            aria-live="polite"
            className="font-mono text-xs"
            style={{ color: "var(--color-ink-faint)" }}
          >
            {snap?.activePlayerPresent ? (
              <>
                <span aria-hidden>● </span>
                {`${snap.activePlayerLabel ?? "speaker"} live`}
              </>
            ) : (
              <>
                <span aria-hidden>○ </span>
                No speaker
              </>
            )}
          </span>
        </div>
      </header>

      {(ws.status === "connecting" || ws.status === "closed") && (
        <p
          role="status"
          aria-live="polite"
          className="card p-3 mb-4 text-sm font-mono"
          style={{ color: "var(--color-ink-faint)" }}
        >
          {ws.status === "connecting"
            ? "Reconnecting to the station…"
            : "Connection lost — the console is showing the last known state while it reconnects."}
        </p>
      )}
      {playerError && (
        <p
          role="alert"
          className="card p-3 mb-4 text-sm font-mono"
          style={{ color: "var(--color-ember-soft)" }}
        >
          Playback: {playerError}
        </p>
      )}
      {errorBanner && (
        <p
          role="status"
          className="card p-3 mb-4 text-sm font-mono"
          style={{ color: "var(--color-ember-soft)" }}
        >
          Skipped &ldquo;{errorBanner.title}&rdquo; — {errorBanner.reason}
        </p>
      )}
      {actionError && (
        <p
          role="alert"
          className="card p-3 mb-4 text-sm font-mono"
          style={{ color: "var(--color-ember-soft)" }}
        >
          {actionError}
        </p>
      )}

      {coldStart ? (
        <section
          className="card reveal relative overflow-hidden p-10 text-center"
          style={{ animationDelay: "80ms" }}
        >
          <div className="hero-glow" aria-hidden="true" />
          <div className="relative z-10">
            <p className="eyebrow">Station idle</p>
            <h1 className="font-display text-3xl mt-3" style={{ color: "var(--color-fg)" }}>
              Queue a song to start the station.
            </h1>
          </div>
        </section>
      ) : (
        <div className="reveal" style={{ animationDelay: "80ms" }}>
          <NowPlaying
            item={snap?.current ?? null}
            paused={effectivePaused}
            receivedAt={receivedAt}
            // Seeking is a station control like skip/pause/shuffle — every one of those works
            // from any authenticated remote (control() → REST, which only requires a session),
            // and station.seek() routes the seek to the active Player's <audio> regardless of who
            // issued it. Gating the bar on wantsSpeaker made seek the lone speaker-only control,
            // so a remote could skip but not scrub. The bar still self-gates on durationMs > 0
            // (a live feed is not seekable).
            canSeek={true}
            onSeek={(positionMs) => void control("seek", positionMs)}
          />
          {/* Live download/processing progress for the track being fetched. Returns null
              when nothing is preparing, so it's safe to always mount alongside NowPlaying;
              a long download (a 2.5h mix takes minutes) then reads as WORKING, not stuck. */}
          <Preparing preparing={snap?.preparing ?? null} />
        </div>
      )}

      <div className="mt-6 grid gap-6">
        <div className="reveal" style={{ animationDelay: "140ms" }}>
          <PlayerPanel isSpeaker={wantsSpeaker} onRelinquish={relinquish} audioRef={audioRef} />
          {!wantsSpeaker && (
            <button
              className="pill pill-primary mt-4"
              onClick={becomeSpeaker}
              aria-label="Play on this device"
            >
              Play on this device
            </button>
          )}
        </div>

        <div className="reveal" style={{ animationDelay: "200ms" }}>
          <AddBar
            onPlay={async (input) => {
              try {
                const r = await api.add(input);
                return { candidates: r.candidates ?? null };
              } catch (e) {
                noteError(e, "Couldn't add that — check the link or try a different search.");
                return { candidates: null };
              }
            }}
            onQueueAll={async (ids) => {
              let queued = 0;
              try {
                for (const id of ids) {
                  await api.pick(id);
                  queued += 1;
                }
              } catch (e) {
                noteError(
                  e,
                  queued > 0
                    ? `Queued ${queued} of ${ids.length} — the rest failed.`
                    : "Couldn't queue that.",
                );
                return false;
              }
              return queued > 0;
            }}
          />
        </div>

        <div className="reveal card p-5 sm:p-6" style={{ animationDelay: "240ms" }}>
          <Controls
            onAction={(a) => void control(a === "resume" ? "play" : a)}
            paused={effectivePaused}
          />
        </div>

        <div className="reveal" style={{ animationDelay: "280ms" }}>
          <Queue
            items={snap?.upcoming ?? []}
            current={snap?.current ?? null}
            upcomingRadio={snap?.upcomingRadio ?? []}
            onRemove={(id) => void control("remove", { itemId: id })}
            onReorder={(id, toIndex) => void control("reorder", { itemId: id, toIndex })}
            onPlayNext={(id) => void control("reorder", { itemId: id, toIndex: 0 })}
            onJump={(id) => void control("jump", { itemId: id })}
            onShuffle={() => void control("shuffle")}
            onClear={() => void control("clear")}
            autoplay={snap?.autoplay ?? true}
            autoplaySource={snap?.autoplaySource ?? "radio"}
            onToggleAutoplay={(on) => void control("settings", { autoplay: on })}
            onChangeSource={(source) => void control("settings", { autoplaySource: source })}
          />
        </div>

        <div className="reveal" style={{ animationDelay: "320ms" }}>
          {/* Re-queue hits /api/pick (validates the bare 11-char VIDEO_ID and enqueues
              directly). /api/add would classify a bare id as a text SEARCH and enqueue
              nothing, so re-queue must NOT route through api.add. */}
          <History
            history={snap?.history ?? []}
            onRequeue={(videoId) =>
              void api.pick(videoId).catch((e) => noteError(e, "Couldn't re-queue that."))
            }
          />
        </div>

        {currentVideoId && (
          <div className="reveal" style={{ animationDelay: "360ms" }}>
            <Lyrics key={currentVideoId} trackId={currentVideoId} />
          </div>
        )}

        <div className="reveal card p-5 sm:p-6" style={{ animationDelay: "400ms" }}>
          <Settings
            repeat={snap?.repeat ?? "off"}
            volume={snap?.volume ?? 100}
            maxTrackDurationSec={snap?.maxTrackDurationSec ?? 0}
            crossfadeSec={snap?.crossfadeSec ?? 10}
            onChange={(patch: Partial<StationSettings>) => void control("settings", patch)}
          />
        </div>
      </div>

      <Listeners
        listeners={snap?.listeners ?? []}
        myDeviceId={getDeviceId()}
        open={listenersOpen}
        onClose={() => setListenersOpen(false)}
      />
    </main>
  );
}
