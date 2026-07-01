import type { RepeatMode, StationSettings } from "../types.js";

const MAX_LEN_PRESETS: { sec: number; label: string }[] = [
  { sec: 3600, label: "1 hour" },
  { sec: 7200, label: "2 hours" },
  { sec: 10800, label: "3 hours" },
  { sec: 14400, label: "4 hours" },
  { sec: 21600, label: "6 hours" },
  { sec: 0, label: "No limit" },
];
const REPEAT_LABELS: Record<RepeatMode, string> = {
  off: "Off",
  one: "Repeat one",
  all: "Repeat all",
};
const VOLUME_MAX = 200;

// NOTE: the Autoplay toggle + source picker deliberately live ONLY in the Queue header
// (see Queue.tsx AutoplaySwitch), not here. The App renders both panels on one page, so
// duplicating role=switch/aria-label="Autoplay" and <select aria-label="Autoplay source">
// in Settings would produce two identically-named controls — a screen-reader ambiguity and
// an ambiguous getByLabelText match. Queue owns autoplay; Settings owns the rest.
export function Settings({
  repeat,
  volume,
  maxTrackDurationSec,
  disabled,
  onChange,
}: {
  repeat: RepeatMode;
  volume: number;
  maxTrackDurationSec: number;
  disabled?: boolean;
  onChange: (patch: Partial<StationSettings>) => void;
}) {
  const inputStyle = {
    border: "1px solid var(--color-line)",
    color: "var(--color-fg)",
  } as const;
  const selectClass = "bg-transparent px-3 py-2 text-sm font-mono tracking-tight";
  const optStyle = { background: "var(--color-raised)", color: "var(--color-fg)" } as const;
  const maxLenIsPreset = MAX_LEN_PRESETS.some((p) => p.sec === maxTrackDurationSec);

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3" aria-label="Playback settings">
      <label className="flex flex-col gap-1.5">
        <span className="eyebrow">Repeat</span>
        <select
          aria-label="Repeat mode"
          value={repeat}
          disabled={disabled}
          onChange={(e) => onChange({ repeat: e.target.value as RepeatMode })}
          className={selectClass}
          style={inputStyle}
        >
          {(Object.keys(REPEAT_LABELS) as RepeatMode[]).map((m) => (
            <option key={m} value={m} style={optStyle}>
              {REPEAT_LABELS[m]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="eyebrow">Volume</span>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={VOLUME_MAX}
            step={5}
            aria-label="Volume"
            value={volume}
            disabled={disabled}
            onChange={(e) => onChange({ volume: Number(e.target.value) })}
            style={{ "--range-fill": `${(volume / VOLUME_MAX) * 100}%` } as React.CSSProperties}
          />
          <span
            className="font-mono tabular-nums text-sm"
            style={{ minWidth: "4ch", color: "var(--color-fg)", textAlign: "right" }}
          >
            {volume}%
          </span>
        </div>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="eyebrow">Max track length</span>
        <select
          aria-label="Max track length"
          value={String(maxTrackDurationSec)}
          disabled={disabled}
          onChange={(e) => onChange({ maxTrackDurationSec: Number(e.target.value) })}
          className={selectClass}
          style={inputStyle}
        >
          {!maxLenIsPreset && (
            <option key={maxTrackDurationSec} value={String(maxTrackDurationSec)} style={optStyle}>
              {maxTrackDurationSec}s (current)
            </option>
          )}
          {MAX_LEN_PRESETS.map((p) => (
            <option key={p.sec} value={String(p.sec)} style={optStyle}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
