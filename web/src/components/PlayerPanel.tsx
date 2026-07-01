export function PlayerPanel({
  isSpeaker,
  onRelinquish,
  audioRef,
}: {
  isSpeaker: boolean;
  onRelinquish: () => void;
  audioRef: React.RefObject<HTMLAudioElement | null>;
}) {
  return (
    <section className="card p-5 sm:p-6">
      {/* The managed sink is always mounted so `load` frames can buffer even before the
          role flips; it is hidden (audio has no visual). */}
      <audio ref={audioRef} hidden preload="auto" />
      {isSpeaker ? (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="font-mono text-sm"
              style={{ color: "var(--color-ember-soft)" }}
            >
              ●
            </span>
            <span className="text-sm" style={{ color: "var(--color-ink)" }}>
              This device is the speaker
            </span>
          </div>
          <button
            className="pill pill-ghost"
            onClick={onRelinquish}
            aria-label="Relinquish speaker"
          >
            Relinquish
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <span className="eyebrow">Player</span>
          <span className="text-sm" style={{ color: "var(--color-ink-dim)" }}>
            Not the speaker on this device.
          </span>
        </div>
      )}
    </section>
  );
}
