import type { QueueItem } from "../types.js";
import { fmtTime } from "../lib/format.js";
import { Thumb } from "./Thumb.js";

/**
 * Recently-played tracks with a 1-click re-queue. `history` arrives oldest-first (the
 * order tracks finished), so we reverse it to show the most-recent first and cap the
 * list at 10. Re-queue reuses the pick-by-videoId flow (onRequeue(meta.videoId)) — the
 * station never stops, so re-queuing just appends to the explicit queue.
 */
export function History({
  history,
  onRequeue,
}: {
  history: QueueItem[];
  onRequeue: (videoId: string) => void;
}) {
  const recent = [...history].reverse().slice(0, 10);
  return (
    <section className="card p-5 sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow">History</p>
        <span
          className="font-mono text-xs uppercase tracking-wider"
          style={{ color: "var(--color-ink-faint)" }}
        >
          {recent.length} recent
        </span>
      </div>
      {recent.length === 0 ? (
        <p
          className="mt-5 text-sm"
          style={{ color: "var(--color-ink-faint)", fontFamily: "var(--font-mono)" }}
        >
          Nothing has played yet.
        </p>
      ) : (
        <ol className="mt-4 flex flex-col gap-1.5">
          {recent.map((it, i) => (
            <li
              key={`${it.id}-${i}`}
              className="group flex items-center gap-3 px-3 py-2.5"
              style={{
                borderRadius: "var(--radius-sm)",
                border: "1px solid transparent",
                transition:
                  "background var(--dur-fast) var(--ease-mech), border-color var(--dur-fast) var(--ease-mech)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(255,255,255,0.025)";
                e.currentTarget.style.borderColor = "var(--color-line)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.borderColor = "transparent";
              }}
            >
              <span
                className="font-mono text-xs w-6 text-right tabular-nums"
                style={{ color: "var(--color-ink-faint)" }}
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <Thumb url={it.meta.thumbnailUrl} size={40} />
              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-sm font-display"
                  style={{ color: "var(--color-fg)", fontWeight: 600 }}
                  title={it.meta.title}
                >
                  {it.meta.title}
                </p>
                <p className="truncate text-xs mt-0.5" style={{ color: "var(--color-ink-dim)" }}>
                  {it.meta.channel} <span style={{ color: "var(--color-ink-faint)" }}>·</span>{" "}
                  <span className="font-mono" style={{ color: "var(--color-ink-faint)" }}>
                    {fmtTime(it.meta.durationSec)}
                  </span>{" "}
                  <span style={{ color: "var(--color-ink-faint)" }}>·</span>{" "}
                  {it.requester.displayName}
                </p>
              </div>
              <button
                type="button"
                aria-label={`Re-queue ${it.meta.title}`}
                onClick={() => onRequeue(it.meta.videoId)}
                className="pill pill-ghost opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                style={{ padding: "0.3rem 0.7rem", fontSize: "0.75rem" }}
              >
                <span aria-hidden className="font-mono leading-none">
                  ↻
                </span>{" "}
                Re-queue
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
