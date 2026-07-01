import { useState } from "react";
import type { SessionInfo } from "../types.js";
import { api } from "../lib/api.js";
import { getDeviceId, getDisplayName, setDisplayName } from "../lib/deviceId.js";

export function LoginGate({ onAuthed }: { onAuthed: (s: SessionInfo) => void }) {
  const [displayName, setName] = useState(getDisplayName());
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setDisplayName(displayName);
      const session = await api.login({
        password,
        displayName: displayName.trim() || "Guest",
        deviceId: getDeviceId(),
      });
      onAuthed(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-full grid place-items-center px-6 py-12">
      <form onSubmit={submit} className="card hero-glow reveal max-w-md w-full p-10">
        <p className="eyebrow" style={{ color: "var(--color-ember-soft)" }}>
          LAN Jukebox
        </p>
        <h1
          className="font-display text-4xl mt-3 leading-tight"
          style={{ color: "var(--color-ink)" }}
        >
          Join the station.
        </h1>
        <label className="flex flex-col gap-1.5 mt-7">
          <span className="eyebrow">Display name</span>
          <input
            value={displayName}
            onChange={(e) => setName(e.target.value)}
            aria-label="Display name"
            autoComplete="nickname"
            className="outline-none text-sm px-4 py-3"
            style={{ border: "1px solid var(--color-line)", color: "var(--color-ink)" }}
          />
        </label>
        <label className="flex flex-col gap-1.5 mt-4">
          <span className="eyebrow">Password</span>
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            aria-label="Password"
            autoComplete="current-password"
            className="outline-none text-sm px-4 py-3"
            style={{ border: "1px solid var(--color-line)", color: "var(--color-ink)" }}
          />
        </label>
        {error && (
          <p
            role="alert"
            className="mt-4 text-sm font-mono"
            style={{ color: "var(--color-ember-soft)" }}
          >
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="pill pill-primary mt-7 justify-center w-full"
        >
          {busy ? (
            <>
              <span className="spinner" aria-hidden /> Entering…
            </>
          ) : (
            "Enter the station"
          )}
        </button>
      </form>
    </main>
  );
}
