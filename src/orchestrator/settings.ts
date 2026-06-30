import type { AutoplaySource, RepeatMode, StationSettings } from "../types/index.js";
import { VOLUME_MAX, MAX_TRACK_DURATION_CEILING_SEC } from "../types/index.js";

const REPEAT_MODES: ReadonlySet<RepeatMode> = new Set<RepeatMode>(["off", "one", "all"]);
const AUTOPLAY_SOURCES: ReadonlySet<AutoplaySource> = new Set<AutoplaySource>(["radio", "artist"]);

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  // Booleans coerce via Number() to 0/1 and would otherwise slip past as "valid" numbers —
  // e.g. {volume:false} silently mutes. Treat them as invalid (fall back).
  if (typeof value === "boolean") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Merge an untrusted partial patch onto a base settings object, clamping/validating every
 * surviving field. Unknown or out-of-range values fall back to the current value. Removed
 * bot fields (idleTimeoutSec/crossfadeSec/normalizeLoudness/fx/commandChannelId) are ignored.
 */
export function applySettingsPatch(
  base: StationSettings,
  patch: Partial<Record<keyof StationSettings, unknown>> | null | undefined,
): StationSettings {
  const p = patch ?? {};
  const repeat =
    typeof p.repeat === "string" && REPEAT_MODES.has(p.repeat as RepeatMode)
      ? (p.repeat as RepeatMode)
      : base.repeat;
  const autoplaySource =
    typeof p.autoplaySource === "string" && AUTOPLAY_SOURCES.has(p.autoplaySource as AutoplaySource)
      ? (p.autoplaySource as AutoplaySource)
      : base.autoplaySource;
  return {
    repeat,
    autoplay: typeof p.autoplay === "boolean" ? p.autoplay : base.autoplay,
    autoplaySource,
    volume: p.volume == null ? base.volume : clampInt(p.volume, 0, VOLUME_MAX, base.volume),
    maxTrackDurationSec:
      p.maxTrackDurationSec == null
        ? base.maxTrackDurationSec
        : clampInt(
            p.maxTrackDurationSec,
            0,
            MAX_TRACK_DURATION_CEILING_SEC,
            base.maxTrackDurationSec,
          ),
  };
}
