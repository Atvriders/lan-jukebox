const Icon = { skip: "⏭", pause: "⏸", resume: "▶" } as const;

export function Controls({
  onAction,
  paused,
  disabled,
}: {
  onAction: (a: "skip" | "pause" | "resume") => void;
  paused: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <span className="eyebrow">Transport</span>
      <div
        role="group"
        aria-label="Playback transport"
        className="flex flex-wrap items-center gap-2.5"
      >
        <button
          className="pill pill-primary"
          disabled={disabled}
          aria-label={paused ? "Resume" : "Pause"}
          onClick={() => onAction(paused ? "resume" : "pause")}
        >
          <span aria-hidden className="font-mono text-[0.95em] leading-none">
            {paused ? Icon.resume : Icon.pause}
          </span>
          {paused ? "Resume" : "Pause"}
        </button>
        <button
          className="pill"
          disabled={disabled}
          aria-label="Skip"
          onClick={() => onAction("skip")}
        >
          <span aria-hidden className="font-mono text-[0.95em] leading-none">
            {Icon.skip}
          </span>
          Skip
        </button>
      </div>
    </div>
  );
}
