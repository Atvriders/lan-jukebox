import type { PreparingState } from "../types.js";

// Per-phase presentation: the lit lamp glyph + the verb the console shows. Downloading is
// the only phase with a percent + progress bar; resolving/processing are indeterminate
// (we can't meter them), so they lean on the activity pulse to read as "working".
const PHASE_LABEL: Record<PreparingState["phase"], { glyph: string; verb: string }> = {
  resolving: { glyph: "◴", verb: "Resolving" },
  downloading: { glyph: "⬇", verb: "Downloading" },
  processing: { glyph: "⚙", verb: "Processing" },
};

/**
 * Live "this track is actively being fetched" status, surfaced near Now Playing so a long
 * download (a 2.5h mix can take minutes) reads as WORKING, not stuck. Driven entirely by
 * `snapshot.preparing` over the WS: a phase verb, the track title, a mono percent counter +
 * a backlit `.vu` progress bar while downloading (indeterminate when the percent is unknown),
 * and an ember activity pulse so the motion makes the live state obvious. Renders nothing
 * when `preparing` is null (nothing is being prepared).
 */
export function Preparing({ preparing }: { preparing: PreparingState | null }) {
  if (!preparing) return null;
  const { phase, title, percent } = preparing;
  const { glyph, verb } = PHASE_LABEL[phase];
  const isDownloading = phase === "downloading";
  const hasPercent = isDownloading && typeof percent === "number" && Number.isFinite(percent);
  const pct = hasPercent ? Math.max(0, Math.min(100, percent!)) : 0;

  return (
    <section
      role="status"
      aria-live="polite"
      className="card reveal flex items-center gap-4 px-5 py-4"
      style={{
        animationDelay: "40ms",
        // A hot ember left rail signals an active operation, mirroring the status banner.
        borderLeft: "3px solid var(--color-ember-soft)",
      }}
    >
      {/* The lit "working" lamp — a spinning ember ring (reduced-motion safe via .spinner). */}
      <span
        data-testid="preparing-activity"
        aria-hidden
        className="spinner shrink-0"
        style={{ width: "1.1rem", height: "1.1rem" }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="eyebrow shrink-0" style={{ color: "var(--color-ember-soft)" }}>
            <span aria-hidden style={{ marginRight: "0.35rem" }}>
              {glyph}
            </span>
            {verb}
          </p>
          {hasPercent && (
            <span
              className="font-mono text-xs shrink-0"
              style={{
                color: "var(--color-ember-soft)",
                letterSpacing: "0.02em",
                textShadow: "0 0 10px rgba(255,0,0,0.45)",
              }}
            >
              {Math.round(pct)}%
            </span>
          )}
        </div>
        <p className="mt-1 truncate text-sm" style={{ color: "var(--color-ink)" }} title={title}>
          {title}
        </p>
        {/* Progress rail. Determinate while a percent is known; otherwise an indeterminate
            sweeping pulse so the user still sees motion (no false 0%). */}
        <div
          className="vu mt-3"
          role="progressbar"
          aria-label={`${verb} ${title}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={hasPercent ? Math.round(pct) : undefined}
        >
          <span
            data-testid="preparing-fill"
            className={hasPercent ? undefined : "animate-pulse"}
            style={
              hasPercent
                ? { width: `${pct}%` }
                : // Indeterminate: a partial bar that pulses so motion ≠ "stopped".
                  { width: "40%", opacity: 0.7 }
            }
          />
        </div>
      </div>
    </section>
  );
}
