// A square track thumbnail with a graceful placeholder. yt-dlp does not always
// return an image (older uploads, some search entries), so `url` may be null —
// in that case we render a styled placeholder box instead of a broken <img>.
//
// Styling: a machined faceplate slot. The real thumbnail sits in a carved well
// with a top rim-light + soft contact shadow (it reads as a photo seated in the
// console). The empty placeholder is the same recessed slot with a dim cream
// music-note glyph and a faint amber-floor → red signal sheen, matching the
// VU/console aesthetic without stealing focus from the lit transport keys.
export function Thumb({ url, size = 44 }: { url: string | null | undefined; size?: number }) {
  const dim = { width: size, height: size } as const;

  // Shared "carved slot" chrome: inset depth + a hairline top rim-light, so both
  // the populated and empty states sit IN the faceplate rather than on top of it.
  const slotChrome = {
    borderRadius: "var(--radius-sm)",
    boxShadow: "var(--shadow-inset), var(--shadow-rim)",
    outline: "1px solid var(--color-line)",
    outlineOffset: "-1px",
  } as const;

  if (url) {
    return (
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        className="object-cover shrink-0"
        style={{ ...dim, ...slotChrome }}
      />
    );
  }
  return (
    <span
      aria-hidden
      data-testid="thumb-placeholder"
      className="shrink-0 grid place-items-center relative overflow-hidden"
      style={{
        ...dim,
        ...slotChrome,
        // Recessed well: warm near-black floor with a faint red-signal sheen
        // leaking from the top edge — the empty slot still reads as "powered".
        background:
          "radial-gradient(120% 90% at 50% 0%, rgba(255,255,255,0.10), transparent 60%)," +
          "linear-gradient(180deg, var(--color-raised) 0%, var(--color-sunken) 100%)",
        color: "var(--color-ink-faint)",
      }}
    >
      {/* simple music-note glyph so an empty slot still reads as a track */}
      <svg
        width={Math.round(size * 0.5)}
        height={Math.round(size * 0.5)}
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
  );
}
