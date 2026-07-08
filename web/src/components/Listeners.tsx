import { useEffect, useRef } from "react";
import type { PresenceUser } from "../types.js";

/**
 * Live-listeners roster as a right-side slide-in DRAWER.
 *
 * The App owns a header button "Listeners (N)" that toggles `open`. This component is the
 * panel that slides in from the right over a dimming overlay. It is an accessible modal
 * dialog: role="dialog" aria-modal, Escape-to-close, click-overlay-to-close, and the panel
 * receives focus on open. When closed it renders nothing (no hidden dialog in the tree).
 *
 * Each row shows the listener's displayName, a "●" speaker badge when they are the active
 * Player (isSpeaker), and "(you)" when the row is this device (deviceId === myDeviceId).
 * Monochrome B&W theme via the shared tokens/classes (.card, .eyebrow, --color-fg,
 * --color-ink-faint, --color-accent).
 */
export function Listeners({
  listeners,
  myDeviceId,
  open,
  onClose,
}: {
  listeners: PresenceUser[];
  myDeviceId: string;
  open: boolean;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Move focus into the dialog when it opens so keyboard/screen-reader users land inside it
  // and Escape (handled on the panel) works immediately.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const title = "listeners-drawer-title";

  return (
    <div
      className="listeners-overlay"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <div
        ref={panelRef}
        className="card reveal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
        style={{
          width: "min(360px, 90vw)",
          height: "100%",
          overflowY: "auto",
          borderRadius: 0,
          borderTop: "none",
          borderBottom: "none",
          borderRight: "none",
          outline: "none",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div className="flex items-baseline justify-between gap-3">
          <p id={title} className="eyebrow">
            Listeners
          </p>
          <button
            type="button"
            aria-label="Close listeners"
            onClick={onClose}
            className="pill pill-ghost"
            style={{ padding: "0.3rem 0.7rem", fontSize: "0.75rem" }}
          >
            <span aria-hidden className="font-mono leading-none">
              ✕
            </span>{" "}
            Close
          </button>
        </div>

        <p
          className="mt-1 font-mono text-xs uppercase tracking-wider"
          style={{ color: "var(--color-ink-faint)" }}
        >
          {listeners.length} connected
        </p>

        {listeners.length === 0 ? (
          <p
            className="mt-5 text-sm"
            style={{ color: "var(--color-ink-faint)", fontFamily: "var(--font-mono)" }}
          >
            No one is connected.
          </p>
        ) : (
          <ul className="mt-4 flex flex-col gap-1.5">
            {listeners.map((u) => {
              const isYou = u.deviceId === myDeviceId;
              return (
                <li
                  key={u.deviceId}
                  className="flex items-center gap-2 px-3 py-2.5"
                  style={{
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--color-line)",
                  }}
                >
                  {u.isSpeaker && (
                    <span
                      aria-label="Speaker"
                      title="Active speaker"
                      className="font-mono leading-none"
                      style={{ color: "var(--color-accent)" }}
                    >
                      ●
                    </span>
                  )}
                  <span
                    className="truncate text-sm font-display"
                    style={{ color: "var(--color-fg)", fontWeight: 600 }}
                    title={u.displayName}
                  >
                    {u.displayName}
                  </span>
                  {isYou && (
                    <span className="font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>
                      (you)
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
