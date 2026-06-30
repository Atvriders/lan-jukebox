import type { AudioInfo } from "../types.js";

export function fmtTime(totalSec: number | null): string {
  if (totalSec === null || !Number.isFinite(totalSec)) return "—:—";
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  // Emit an hours segment for tracks ≥ 1h (real YouTube durations are routinely 60+
  // minutes) so a 1h track reads "1:00:00", not "60:00".
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** "opus · 160 kbps · 48 kHz" — drops missing parts; returns null when nothing useful. */
export function fmtAudio(audio: AudioInfo | null): string | null {
  if (!audio) return null;
  const parts: string[] = [];
  if (audio.codec) parts.push(audio.codec);
  if (audio.bitrateKbps > 0) parts.push(`${Math.round(audio.bitrateKbps)} kbps`);
  if (audio.sampleRateHz > 0) {
    // Render up to 3 decimals and strip trailing zeros so standard sub-44.1k rates read
    // accurately: 48000 -> "48", 44100 -> "44.1", 22050 -> "22.05", 11025 -> "11.025"
    // (the old fixed 0-or-1 decimal misrepresented 22050 as "22.1" and 11025 as "11.0").
    const khz = parseFloat((audio.sampleRateHz / 1000).toFixed(3));
    parts.push(`${khz} kHz`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
