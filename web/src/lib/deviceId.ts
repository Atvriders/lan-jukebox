const DEVICE_KEY = "ljb.deviceId";
const NAME_KEY = "ljb.displayName";

/** Persistent random device token (localStorage). The backend's device-memory key (spec §5). */
export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `dev-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

/** Attribution display name; defaults to "Guest". */
export function getDisplayName(): string {
  return localStorage.getItem(NAME_KEY) ?? "Guest";
}

/** Persist a trimmed display name; a blank value is ignored (keeps the prior name). */
export function setDisplayName(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  localStorage.setItem(NAME_KEY, trimmed);
}
