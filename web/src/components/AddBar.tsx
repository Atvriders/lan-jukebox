import { useState } from "react";
import type { TrackMeta } from "../types.js";
import { Picker } from "./Picker.js";

// The "Add to queue" console strip: paste a YouTube link OR type a search, then
// submit. A link resolves + queues directly (onPlay -> { candidates: null }); a
// search returns candidates so the shared <Picker/> can surface the exact track.
export function AddBar({
  onPlay,
  onQueueAll,
  busy,
}: {
  // Returns candidates for a search, else null (a link queued directly).
  onPlay: (input: string) => Promise<{ candidates: TrackMeta[] | null }>;
  /** Queues all selected candidates IN ORDER; resolves to whether ≥1 was queued. */
  onQueueAll: (videoIds: string[]) => Promise<boolean>;
  busy?: boolean;
}) {
  const [input, setInput] = useState("");
  const [candidates, setCandidates] = useState<TrackMeta[] | null>(null);
  // Resolving a link (yt-dlp) takes several seconds. Clear the box and show a
  // pending state IMMEDIATELY on submit so the UI feels instant, then await in bg.
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = input.trim();
    if (!value || pending) return;
    setInput(""); // instant: empty the box before the (slow) resolve
    setCandidates(null);
    setPending(true);
    try {
      const { candidates: c } = await onPlay(value);
      setCandidates(c);
    } finally {
      setPending(false);
    }
  }

  const disabled = busy || pending;

  return (
    <section className="card p-5 sm:p-6">
      <span className="eyebrow">Add to queue</span>
      <form onSubmit={submit} className="mt-3 flex flex-col gap-2.5 sm:flex-row">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={disabled}
          placeholder="Paste a YouTube link, or search a song…"
          aria-label="Add a track"
          className="flex-1 text-sm"
        />
        <button className="pill pill-primary justify-center" disabled={disabled} type="submit">
          {pending ? (
            <>
              <span className="spinner" aria-hidden /> Resolving…
            </>
          ) : (
            "Queue it"
          )}
        </button>
      </form>

      {candidates && candidates.length === 0 && (
        <p className="mt-4 text-sm font-mono" style={{ color: "var(--color-ink-faint)" }}>
          No matches — try a different search.
        </p>
      )}

      {candidates && candidates.length > 0 && (
        // The "Pick the exact track" header lives inside <Picker/> (shared by
        // AddBar and Discover), so this wrapper only supplies the separator rule.
        <div className="mt-5 pt-5" style={{ borderTop: "1px solid var(--color-line)" }}>
          <Picker
            candidates={candidates}
            busy={busy}
            // Queue every selected candidate IN ORDER via one batched, ordered request.
            onQueueSelected={onQueueAll}
            onQueued={() => {
              setCandidates(null);
              setInput("");
            }}
          />
        </div>
      )}
    </section>
  );
}
