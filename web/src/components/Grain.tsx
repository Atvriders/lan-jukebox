/**
 * Grain — the console's photographed-in-a-dark-room texture layer.
 *
 * Decorative + inert: fixed behind the whole UI, aria-hidden, never
 * interactive. It layers three signature motifs from the Late-Night Studio
 * design system over the page:
 *   1. film grain   — tiled fractal noise (matches the --grain token's
 *                     baseFrequency 0.85 / 2 octaves), overlay-blended.
 *   2. amber light-leak — a soft amber bloom leaking from the top edge, the
 *                     visual proof the console is powered on.
 *   3. vignette     — corners pulled down so the deck reads three-dimensional.
 *
 * The body stylesheet also carries grain/vignette; this supplementary layer
 * deepens the texture and is harmless to leave mounted.
 */
export function Grain() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: -1,
        pointerEvents: "none",
        userSelect: "none",
      }}
    >
      {/* Red light-leak from the top edge — the "amp is on" glow. */}
      <div
        style={{
          position: "absolute",
          inset: "-30% -10% auto -10%",
          height: "55%",
          background: "radial-gradient(60% 100% at 50% 0%, rgba(240,178,74,0.10), transparent 70%)",
          filter: "blur(8px)",
        }}
      />
      {/* Corner vignette pulling the deck into the dark room. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(130% 100% at 50% 0%, transparent 58%, rgba(0,0,0,0.50) 100%)",
        }}
      />
      {/* Film grain — tiled fractal noise, overlay-blended at low opacity. */}
      <svg
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          opacity: 0.045,
          mixBlendMode: "overlay",
        }}
      >
        <filter id="grain-fractal" x="0" y="0" width="100%" height="100%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.85"
            numOctaves="2"
            stitchTiles="stitch"
          />
        </filter>
        <rect width="100%" height="100%" filter="url(#grain-fractal)" />
      </svg>
    </div>
  );
}
