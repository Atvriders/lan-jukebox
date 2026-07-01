import type { AutoplaySource, CurrentItem, QueueItem } from "../types.js";
import { fmtTime } from "../lib/format.js";
import { Thumb } from "./Thumb.js";

const AUTOPLAY_SOURCE_LABELS: Record<AutoplaySource, string> = {
  radio: "Radio / Mix",
  artist: "Artist",
};

/**
 * The autoplay console toggle for the queue header: a real accessible switch
 * (role="switch" + aria-checked) wired to the station's `autoplay` setting, with the
 * source picker (Radio vs Artist) lit up only while it is engaged. Styled to the
 * "On-Air Broadcast Console" deck — an amber tally track + a sliding warm-ink handle.
 * Flipping it emits the new boolean through `onToggleAutoplay`; the source select emits
 * a source change through `onChangeSource`, both of which the App threads to /settings.
 */
function AutoplaySwitch({
  autoplay,
  autoplaySource,
  onToggleAutoplay,
  onChangeSource,
}: {
  autoplay: boolean;
  autoplaySource: AutoplaySource;
  onToggleAutoplay: (on: boolean) => void;
  onChangeSource: (source: AutoplaySource) => void;
}) {
  return (
    <div
      className="flex items-center gap-2.5"
      title="Autoplay: when the queue runs low, keep the station live by pulling more tracks from YouTube — its related/Mix feed (Radio) or a search by the last track's artist. Keyed on the last song, not a precise genre match."
    >
      <span className="eyebrow" style={{ color: autoplay ? "var(--color-accent-hi)" : undefined }}>
        Autoplay
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={autoplay}
        aria-label="Autoplay"
        onClick={() => onToggleAutoplay(!autoplay)}
        // A machined deck switch: a recessed track whose tally warms to amber when engaged,
        // with a sliding warm-ink handle. Uses the global amber tokens so it reads as part
        // of the console face. Amber focus ring comes from the global :focus-visible.
        style={{
          position: "relative",
          width: "2.6rem",
          height: "1.4rem",
          flexShrink: 0,
          borderRadius: "var(--radius-pill)",
          border: "1px solid var(--color-line)",
          background: autoplay
            ? "linear-gradient(180deg, var(--color-accent-hi), var(--color-ember))"
            : "var(--color-sunken)",
          boxShadow: autoplay
            ? "var(--glow-amber), inset 0 1px 2px rgba(0,0,0,0.35)"
            : "var(--shadow-inset)",
          cursor: "pointer",
          transition:
            "background var(--dur-fast) var(--ease-mech), box-shadow var(--dur-fast) var(--ease-mech)",
          padding: 0,
        }}
      >
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: "50%",
            left: autoplay ? "calc(100% - 1.18rem)" : "0.12rem",
            width: "1.06rem",
            height: "1.06rem",
            borderRadius: "var(--radius-pill)",
            background: "var(--color-fg)",
            boxShadow: "0 1px 2px rgba(0,0,0,0.6)",
            transform: "translateY(-50%)",
            transition: "left var(--dur-fast) var(--ease-mech)",
          }}
        />
      </button>
      <span className="font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>
        {autoplay ? "ON" : "OFF"}
      </span>
      {/* The source picker is meaningful only while autoplay is engaged. */}
      {autoplay && (
        <label
          className="flex items-center gap-1.5"
          title="Radio = YouTube's related/Mix feed for the last track. Artist = a search by the last track's channel/artist name (best-effort, not a verified discography)."
        >
          <span className="eyebrow">Source</span>
          <select
            aria-label="Autoplay source"
            value={autoplaySource}
            onChange={(e) => onChangeSource(e.target.value as AutoplaySource)}
            className="bg-transparent px-2 py-1 text-xs font-mono tracking-tight"
            style={{ border: "1px solid var(--color-line)", color: "var(--color-fg)" }}
          >
            {(Object.keys(AUTOPLAY_SOURCE_LABELS) as AutoplaySource[]).map((s) => (
              <option
                key={s}
                value={s}
                style={{ background: "var(--color-raised)", color: "var(--color-fg)" }}
              >
                {AUTOPLAY_SOURCE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

/**
 * Total remaining listen time = sum of upcoming track durations + the remaining of the
 * current track. Unknown (null) durations count as 0 so the readout is always a real
 * time, never "—:—"/NaN. Returns whole seconds for fmtTime.
 */
function totalQueueSec(items: QueueItem[], current: CurrentItem | null): number {
  const upcoming = items.reduce((sum, it) => sum + (it.meta.durationSec ?? 0), 0);
  const remainingMs = current ? Math.max(0, current.durationMs - current.positionMs) : 0;
  return upcoming + Math.round(remainingMs / 1000);
}

export function Queue({
  items,
  current,
  upcomingRadio,
  onRemove,
  onReorder,
  onPlayNext,
  onJump,
  onShuffle,
  onClear,
  autoplay,
  autoplaySource,
  onToggleAutoplay,
  onChangeSource,
}: {
  items: QueueItem[];
  current: CurrentItem | null;
  /** Pre-resolved radio buffer, shown read-only as the "Up next on the radio" preview. */
  upcomingRadio: QueueItem[];
  onRemove: (id: string) => void;
  onReorder: (id: string, toIndex: number) => void;
  onPlayNext: (id: string) => void;
  onJump: (id: string) => void;
  onShuffle: () => void;
  onClear: () => void;
  autoplay: boolean;
  autoplaySource: AutoplaySource;
  /** Emits the new engaged state; App threads it to POST /settings. */
  onToggleAutoplay: (on: boolean) => void;
  /** Emits the newly-selected autoplay source; App threads it to POST /settings. */
  onChangeSource: (source: AutoplaySource) => void;
}) {
  return (
    <section className="card p-5 sm:p-6">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-4 flex-wrap">
          <p className="eyebrow">Up next</p>
          {/* Autoplay lives in the header so the queue running dry never means a hard
              stop — flip it and the station keeps broadcasting from YouTube's feed.
              onChangeSource passes the newly-selected source straight through; the App
              threads it to POST /settings so the Radio/Artist choice actually persists. */}
          <AutoplaySwitch
            autoplay={autoplay}
            autoplaySource={autoplaySource}
            onToggleAutoplay={onToggleAutoplay}
            onChangeSource={onChangeSource}
          />
        </div>
        <div className="flex items-center gap-3">
          {/* Total remaining time: upcoming durations + the remaining of the current
              track. A mono "counter on the deck" readout. */}
          <span
            className="font-mono text-xs tabular-nums"
            style={{ color: "var(--color-ink-faint)", letterSpacing: "0.02em" }}
          >
            {items.length} queued ·{" "}
            <span title="Total remaining time" style={{ color: "var(--color-ink-dim)" }}>
              {fmtTime(totalQueueSec(items, current))}
            </span>
          </span>
          <button
            aria-label="Shuffle the queue"
            onClick={onShuffle}
            disabled={items.length < 2}
            className="pill pill-ghost"
            style={{ padding: "0.34rem 0.8rem", fontSize: "0.75rem" }}
          >
            ⇄ Shuffle
          </button>
          <button
            aria-label="Clear the queue"
            onClick={onClear}
            disabled={items.length === 0}
            className="pill pill-ghost"
            style={{ padding: "0.34rem 0.8rem", fontSize: "0.75rem" }}
          >
            ✕ Clear
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <p
          className="mt-5 text-sm"
          style={{
            color: "var(--color-ink-faint)",
            fontFamily: "var(--font-display)",
            fontStyle: "italic",
          }}
        >
          The queue is empty.
        </p>
      ) : (
        <ol className="mt-4 flex flex-col">
          {items.map((it, i) => (
            <li
              key={it.id}
              className="group relative flex items-center gap-3 px-3 py-2.5"
              style={{
                borderRadius: "var(--radius-sm)",
                borderTop: i === 0 ? "none" : "1px solid var(--color-line)",
                transition:
                  "background var(--dur-fast) var(--ease-mech), box-shadow var(--dur-fast) var(--ease-mech)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(255,255,255,0.025)";
                e.currentTarget.style.boxShadow = "inset 2px 0 0 0 var(--color-accent)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.boxShadow = "none";
              }}
            >
              {/* Position index — a mono "track number" on the console face. */}
              <span
                className="font-mono text-xs w-6 text-right tabular-nums"
                style={{ color: "var(--color-ink-faint)" }}
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              {/* Thumb renders a placeholder (no broken <img src="">) when the url is
                  null, avoiding a spurious same-origin GET for thumbnail-less items. */}
              <Thumb url={it.meta.thumbnailUrl} size={40} />
              {/* The title block is itself the "jump to this track" control: click it to
                  skip straight here (drops the tracks before it). Kept as a button for
                  a11y. On hover the display title warms toward amber to signal it's
                  clickable. */}
              <button
                type="button"
                aria-label={`Jump to ${it.meta.title}, play it now`}
                onClick={() => onJump(it.id)}
                className="min-w-0 flex-1 text-left"
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "inherit",
                }}
                onMouseEnter={(e) => {
                  const t = e.currentTarget.querySelector(
                    "[data-queue-title]",
                  ) as HTMLElement | null;
                  if (t) t.style.color = "var(--color-accent-hi)";
                }}
                onMouseLeave={(e) => {
                  const t = e.currentTarget.querySelector(
                    "[data-queue-title]",
                  ) as HTMLElement | null;
                  if (t) t.style.color = "var(--color-fg)";
                }}
              >
                <p
                  data-queue-title
                  className="font-display truncate text-sm"
                  title={it.meta.title}
                  style={{
                    color: "var(--color-fg)",
                    transition: "color var(--dur-fast) var(--ease-mech)",
                  }}
                >
                  {it.meta.title}
                </p>
                <p className="truncate text-xs mt-0.5" style={{ color: "var(--color-ink-dim)" }}>
                  {it.meta.channel} ·{" "}
                  <span
                    className="font-mono tabular-nums"
                    style={{ color: "var(--color-ink-faint)" }}
                  >
                    {fmtTime(it.meta.durationSec)}
                  </span>{" "}
                  · {it.requester.displayName}
                </p>
              </button>
              <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <button
                  aria-label={`Play next: ${it.meta.title}`}
                  disabled={i === 0}
                  onClick={() => onPlayNext(it.id)}
                  className="pill pill-ghost"
                  style={{ padding: "0.3rem 0.6rem", fontSize: "0.7rem" }}
                >
                  Play next
                </button>
                <button
                  aria-label={`Move up: ${it.meta.title}`}
                  disabled={i === 0}
                  onClick={() => onReorder(it.id, i - 1)}
                  className="pill pill-ghost"
                  style={{ padding: "0.3rem 0.55rem", fontSize: "0.75rem" }}
                >
                  ▲
                </button>
                <button
                  aria-label={`Move down: ${it.meta.title}`}
                  disabled={i === items.length - 1}
                  onClick={() => onReorder(it.id, i + 1)}
                  className="pill pill-ghost"
                  style={{ padding: "0.3rem 0.55rem", fontSize: "0.75rem" }}
                >
                  ▼
                </button>
                <button
                  aria-label={`Remove ${it.meta.title}`}
                  onClick={() => onRemove(it.id)}
                  className="pill pill-ghost"
                  style={{ padding: "0.35rem 0.72rem", fontSize: "0.8rem" }}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}

      {/* Up next on the radio — the pre-resolved autoplay buffer, shown READ-ONLY
          (no reorder/remove/play-next): these are the station's own picks, tagged
          from-radio, waiting to be promoted once the explicit queue drains. Rendered
          only when the buffer has something so the panel stays quiet otherwise. */}
      {upcomingRadio.length > 0 && (
        <section
          aria-label="Up next on the radio"
          className="mt-6 pt-4"
          style={{ borderTop: "1px solid var(--color-line-soft)" }}
        >
          <div className="flex items-center gap-2.5">
            {/* A small amber tally reads as the live station's own feed. */}
            <span className="tally" data-live="true" aria-hidden />
            <p className="eyebrow" style={{ color: "var(--color-accent-hi)" }}>
              Up next on the radio
            </p>
            <span className="eyebrow" style={{ color: "var(--color-ink-faint)" }}>
              · from radio
            </span>
          </div>
          <ul className="mt-3 flex flex-col">
            {upcomingRadio.map((it, i) => (
              <li
                key={it.id}
                className="flex items-center gap-3 px-3 py-2"
                style={{
                  borderRadius: "var(--radius-sm)",
                  borderTop: i === 0 ? "none" : "1px solid var(--color-line-soft)",
                  opacity: 0.82,
                }}
              >
                <span
                  aria-hidden
                  className="font-mono text-[0.6rem] tracking-[0.16em] uppercase shrink-0"
                  style={{ color: "var(--color-accent)", width: "3.2ch" }}
                  title="From the radio"
                >
                  RAD
                </span>
                <Thumb url={it.meta.thumbnailUrl} size={34} />
                <div className="min-w-0 flex-1">
                  <p
                    className="font-display truncate text-sm"
                    title={it.meta.title}
                    style={{ color: "var(--color-ink-dim)" }}
                  >
                    {it.meta.title}
                  </p>
                  <p
                    className="truncate text-xs mt-0.5"
                    style={{ color: "var(--color-ink-faint)" }}
                  >
                    {it.meta.channel} ·{" "}
                    <span className="font-mono tabular-nums">{fmtTime(it.meta.durationSec)}</span>
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
