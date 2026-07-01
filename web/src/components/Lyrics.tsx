import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; lyrics: string }
  | { kind: "empty" }
  | { kind: "error" };

/**
 * A collapsible "Lyrics" panel for the now-playing track. Lyrics are best-effort and
 * fetched lazily (only after the panel is first opened), from the lyrics.ovh-backed
 * `api.lyrics(trackId)` endpoint. They are a plain TEXT match keyed on the derived
 * artist/title — NOT time-synced — so we surface that honestly and handle the common
 * "no match" case gracefully.
 *
 * `trackId` identifies the current track: when it changes while the panel is open we
 * refetch so the lyrics follow the music.
 */
export function Lyrics({ trackId }: { trackId: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  // Guards against a stale in-flight response overwriting a newer track's lyrics.
  const reqIdRef = useRef(0);

  const load = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    setState({ kind: "loading" });
    try {
      const { lyrics } = await api.lyrics(trackId);
      if (reqId !== reqIdRef.current) return; // superseded by a newer request
      setState(lyrics && lyrics.trim() ? { kind: "loaded", lyrics } : { kind: "empty" });
    } catch {
      if (reqId !== reqIdRef.current) return;
      setState({ kind: "error" });
    }
  }, [trackId]);

  // Fetch when opened, and refetch whenever the track changes while open.
  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, trackId, load]);

  return (
    <div className="mt-4">
      <button className="pill pill-ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden>🎤</span> {open ? "Hide lyrics" : "Lyrics"}
      </button>

      {open && (
        <div className="card reveal mt-3 p-5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="eyebrow">Lyrics</span>
            <span className="eyebrow" style={{ color: "var(--color-ink-faint)" }}>
              lyrics.ovh
            </span>
          </div>

          <div className="mt-4">
            {state.kind === "loading" && (
              <p
                className="flex items-center gap-2 font-mono text-sm"
                style={{ color: "var(--color-ink-faint)" }}
              >
                <span className="spinner" aria-hidden /> Looking up lyrics…
              </p>
            )}

            {state.kind === "loaded" && (
              <>
                <h3 className="font-display text-lg mb-3" style={{ color: "var(--color-fg)" }}>
                  Now reading
                </h3>
                <pre
                  className="font-sans text-sm whitespace-pre-wrap leading-relaxed pl-4"
                  style={{
                    color: "var(--color-ink-dim)",
                    maxHeight: 320,
                    overflowY: "auto",
                    margin: 0,
                    borderLeft: "2px solid var(--color-ember)",
                  }}
                >
                  {state.lyrics}
                </pre>
                <p className="mt-4 font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>
                  Best-effort lyrics from lyrics.ovh — a text match, not time-synced.
                </p>
              </>
            )}

            {state.kind === "empty" && (
              <p className="font-display text-base" style={{ color: "var(--color-ink-dim)" }}>
                No lyrics found.
              </p>
            )}

            {state.kind === "error" && (
              <div className="text-sm" style={{ color: "var(--color-ink-dim)" }}>
                <p className="font-display text-base">Couldn’t load lyrics right now.</p>
                <button className="pill pill-ghost mt-3" onClick={() => void load()}>
                  Retry
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
