import { useState } from "react";
import type { TrackMeta } from "../types.js";
import { fmtTime } from "../lib/format.js";
import { Thumb } from "./Thumb.js";

// The exact-track picker, shared by AddBar and Discover. It is multi-select:
// each candidate row is toggle-selectable (highlight + checkmark, aria-pressed),
// and a primary "Queue selected (N)" button queues ALL selected candidates IN
// candidate display order via onQueueSelected, then clears the selection and
// calls onQueued (so the parent can close/reset the picker). Errors are surfaced
// by the parent's queue flow (the same status banner as a single pick).
export function Picker({
  candidates,
  onQueueSelected,
  onQueued,
  busy,
}: {
  candidates: TrackMeta[];
  /**
   * Queues every selected candidate, in candidate display order, and resolves to
   * whether at least one track was queued. Teardown (clearing the selection and
   * calling onQueued) is gated on that success so a failed batch keeps the candidates
   * mounted for retry.
   */
  onQueueSelected: (videoIds: string[]) => Promise<boolean> | void;
  /** Called after a successful queue so the parent can clear/close the picker. */
  onQueued?: () => void;
  /** When true the queue/selection controls are disabled. */
  busy?: boolean;
}) {
  // Selection is a Set of videoIds; order is always derived from `candidates`.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // Re-entrancy guard: disable the controls while a queue is in flight.
  const [queuing, setQueuing] = useState(false);

  function toggle(videoId: string) {
    if (busy || queuing) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(videoId)) next.delete(videoId);
      else next.add(videoId);
      return next;
    });
  }

  async function queueSelected() {
    if (selected.size === 0 || busy || queuing) return;
    // Deliver in candidate display order, not click order.
    const ids = candidates.map((c) => c.videoId).filter((id) => selected.has(id));
    if (ids.length === 0) return;
    setQueuing(true);
    try {
      const result = await onQueueSelected(ids);
      // `void` (legacy single-pick) is treated as success; only an explicit `false`
      // (no track queued) keeps the picker open with the selection intact for retry.
      if (result !== false) {
        setSelected(new Set());
        onQueued?.();
      }
    } finally {
      setQueuing(false);
    }
  }

  const count = selected.size;
  const controlsDisabled = !!busy || queuing;

  return (
    <ul className="flex flex-col gap-1.5">
      {/* Engraved silkscreen header strip — section label + the lit transport key. */}
      <li className="flex items-center justify-between gap-2 px-1 pb-1.5">
        <span className="eyebrow">Pick the exact track</span>
        {count > 0 && (
          <button
            type="button"
            onClick={queueSelected}
            disabled={controlsDisabled}
            aria-label={`Queue ${count} selected track${count === 1 ? "" : "s"}`}
            className="pill pill-primary"
            style={{ padding: "0.34rem 0.8rem", fontSize: "0.8rem" }}
          >
            {queuing ? (
              <>
                <span className="spinner" />
                Queuing…
              </>
            ) : (
              <>
                {/* mono counter chip on the transport key — reads as a take count */}
                <span
                  className="font-mono"
                  aria-hidden
                  style={{
                    fontSize: "0.7rem",
                    lineHeight: 1,
                    padding: "0.12rem 0.36rem",
                    borderRadius: "999px",
                    background: "rgba(0,0,0,0.28)",
                    boxShadow: "inset 0 1px 2px rgba(0,0,0,0.45)",
                  }}
                >
                  {count}
                </span>
                {`Queue selected (${count})`}
              </>
            )}
          </button>
        )}
      </li>
      {candidates.map((c) => {
        const isSelected = selected.has(c.videoId);
        return (
          <li key={c.videoId}>
            {/* Each candidate is a carved console row-key: dark well that lifts on
                hover, and depresses + lights a red signal ring when selected. */}
            <button
              type="button"
              aria-pressed={isSelected}
              disabled={controlsDisabled}
              onClick={() => toggle(c.videoId)}
              className="w-full flex items-center gap-3 text-left"
              style={{
                position: "relative",
                padding: "0.5rem 0.7rem",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--color-line)",
                transition:
                  "background var(--dur-fast) var(--ease-mech), box-shadow var(--dur-fast) var(--ease-mech), border-color var(--dur-fast) var(--ease-mech), transform var(--dur-press) var(--ease-mech)",
                transform: isSelected ? "translateY(1px)" : "none",
                background: isSelected
                  ? "linear-gradient(180deg, rgba(255,0,0,0.10), rgba(255,0,0,0.04))"
                  : "linear-gradient(180deg, rgba(246,239,231,0.025), transparent 70%), var(--color-sunken)",
                borderColor: isSelected ? "rgba(255,0,0,0.55)" : "var(--color-line)",
                boxShadow: isSelected
                  ? "inset 0 2px 5px -1px rgba(0,0,0,0.7), inset 0 0 0 1px var(--color-accent, rgba(255,0,0,0.6)), 0 0 18px -6px rgba(255,0,0,0.6)"
                  : "var(--shadow-rim)",
              }}
              onMouseEnter={(e) => {
                if (!isSelected) {
                  e.currentTarget.style.background =
                    "linear-gradient(180deg, rgba(246,239,231,0.05), transparent 70%), var(--color-sunken)";
                  e.currentTarget.style.borderColor = "rgba(246,239,231,0.2)";
                }
              }}
              onMouseLeave={(e) => {
                if (!isSelected) {
                  e.currentTarget.style.background =
                    "linear-gradient(180deg, rgba(246,239,231,0.025), transparent 70%), var(--color-sunken)";
                  e.currentTarget.style.borderColor = "var(--color-line)";
                }
              }}
            >
              <Thumb url={c.thumbnailUrl} size={44} />
              <span className="min-w-0 flex-1">
                {/* Track title in the display serif — the studio typeface. */}
                <span
                  className="block truncate font-display text-sm"
                  style={{
                    color: isSelected ? "var(--color-ink)" : "var(--color-ink)",
                  }}
                >
                  {c.title}
                </span>
                <span
                  className="block truncate text-xs"
                  style={{ color: "var(--color-ink-faint)" }}
                >
                  {c.channel}{" "}
                  <span aria-hidden style={{ opacity: 0.5 }}>
                    ·
                  </span>{" "}
                  <span className="font-mono" style={{ color: "var(--color-ink-dim)" }}>
                    {fmtTime(c.durationSec)}
                  </span>
                </span>
              </span>
              {/* Selected-state lamp: a lit red toggle lamp with a glow + white check. */}
              <span
                aria-hidden
                className="shrink-0 grid place-items-center rounded-full"
                style={{
                  width: 22,
                  height: 22,
                  border: isSelected
                    ? "1px solid var(--color-ember, var(--color-accent))"
                    : "1px solid var(--color-line)",
                  background: isSelected
                    ? "radial-gradient(circle at 35% 30%, var(--color-ember-soft) 0%, var(--color-accent, #ff0000) 70%, var(--color-ember-deep) 100%)"
                    : "var(--color-sunken)",
                  boxShadow: isSelected
                    ? "var(--glow-red), inset 0 1px 0 0 rgba(255,255,255,0.35)"
                    : "var(--shadow-inset)",
                  color: isSelected ? "#fff" : "transparent",
                  transition:
                    "background var(--dur-fast) var(--ease-mech), box-shadow var(--dur-fast) var(--ease-mech), border-color var(--dur-fast) var(--ease-mech)",
                }}
              >
                {isSelected && (
                  <svg
                    data-testid="picker-check"
                    width={13}
                    height={13}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
