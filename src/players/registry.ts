import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  DeviceRecord,
  DeviceRegistryFile,
  PresenceUser,
  StationSnapshot,
} from "../types/index.js";
import { DEVICE_REGISTRY_FILE, readDeviceRegistry } from "./persist.js";
import { getRootLogger } from "../util/logger.js";

/** Per-socket audio sink the registry forwards to the station + can relinquish. */
export interface RegistrySink {
  relinquish(): void;
}

export interface StationLike {
  attachSink(sink: RegistrySink): void;
  detachSink(): void;
  resume(): void;
  pause(): void;
  snapshot(): StationSnapshot;
}

export interface PlayerRegistryDeps {
  dir: string;
  station: StationLike;
  now?: () => number;
}

/**
 * Upper bound on retained device records. deviceId + label are client-controlled
 * and unbounded (spec forbids rate-limiting), so an authed client re-logging with
 * fresh deviceIds could grow the map/file without limit — every `hello` also does
 * an O(N) synchronous JSON.stringify + write on the event loop. When the cap is
 * exceeded we LRU-evict by lastSeen, but never evict preferred speakers (device
 * memory is the point of the registry).
 */
export const MAX_DEVICES = 500;

/** A DeviceRecord that survived per-field validation on restore. */
function isValidDeviceRecord(d: unknown): d is DeviceRecord {
  return (
    typeof d === "object" &&
    d !== null &&
    typeof (d as DeviceRecord).deviceId === "string" &&
    typeof (d as DeviceRecord).label === "string" &&
    typeof (d as DeviceRecord).lastSeen === "number" &&
    typeof (d as DeviceRecord).isPreferredSpeaker === "boolean"
  );
}

export class PlayerRegistry {
  private readonly dir: string;
  private readonly station: StationLike;
  private readonly now: () => number;
  private devices = new Map<string, DeviceRecord>();
  private _activeDeviceId: string | null = null;
  private activeSink: RegistrySink | null = null;
  /**
   * Live connected-device presence (in-memory only, NOT persisted). Keyed by
   * deviceId -> { displayName, connections }. `connections` counts how many
   * open sockets a single device has (multi-tab / reload overlap), so the
   * device stays in the roster until its LAST socket closes. This is distinct
   * from `devices` (the persisted device-memory map): a device can be
   * remembered without being connected, and connected without being remembered.
   */
  private connected = new Map<string, { displayName: string; connections: number }>();

  constructor(deps: PlayerRegistryDeps) {
    this.dir = deps.dir;
    this.station = deps.station;
    this.now = deps.now ?? Date.now;
  }

  async init(): Promise<void> {
    const file = await readDeviceRegistry(this.dir);
    // Tolerant restore: the read guard only checks version + Array.isArray, so a
    // JSON-valid file can still carry malformed entries (null, non-string
    // deviceId, …). Skip bad records per-item instead of letting one corrupt row
    // throw out of init() and brick startup of the always-on station (mirrors the
    // orchestrator's isValidQueueItem/isValidSeed per-item skip on snapshot restore).
    this.devices = new Map(
      (file?.devices ?? [])
        .filter((d): d is DeviceRecord => isValidDeviceRecord(d))
        .map((d) => [d.deviceId, { ...d }]),
    );
  }

  private toFile(): DeviceRegistryFile {
    return {
      version: 1,
      savedAt: this.now(),
      devices: [...this.devices.values()],
    };
  }

  private persist(): void {
    // Best-effort bookkeeping: log-and-continue on any fs failure instead of
    // throwing. persist() runs inside the WS 'message' handler (touch) and the
    // /api/speaker handler (remember/forget), neither of which wraps it; an
    // uncaught throw (ENOSPC, EACCES, read-only/immutable volume) would reach
    // process.on('uncaughtException') and exit(1) — killing the always-playing
    // station over a lost registry write, which violates the 'never stops'
    // invariant. Losing persistence is acceptable; crashing is not. Mirrors the
    // async station-snapshot writer's .catch (src/index.ts:53).
    try {
      // Synchronous atomic write (stage to tmp sibling, then rename over the
      // target) so `touch` stays synchronous AND the file is on disk before the
      // caller's next read — a fire-and-forget async write would race the read.
      mkdirSync(this.dir, { recursive: true });
      const target = join(this.dir, DEVICE_REGISTRY_FILE);
      // Unique per-write tmp (pid + random) so this write never collides with the
      // async writeDeviceRegistry or a second registry instance sharing the dir.
      const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.toFile()));
      renameSync(tmp, target);
    } catch (err) {
      // Log-and-continue via the process-wide logger (same instance main() wires
      // up). Persistence loss is tolerable — a crash is not.
      getRootLogger().error({ err }, "device-registry persist failed (continuing)");
    }
  }

  touch(deviceId: string, label: string): void {
    const now = this.now();
    // The label IS the presence displayName: if this device is currently
    // connected, keep its live-roster name in sync with the freshest label
    // (a rename mid-session should update the roster without a reconnect).
    const pres = this.connected.get(deviceId);
    if (pres) pres.displayName = label;
    const existing = this.devices.get(deviceId);
    if (existing) {
      // Skip the O(N) serialize + synchronous write when nothing meaningful
      // changed. lastSeen is refreshed in-memory regardless, but a reconnect that
      // only bumps lastSeen (same label) does NOT need to rewrite the whole file
      // on the hot reconnect path — the value is derivable/best-effort and is
      // re-persisted on the next real change.
      const changed = existing.label !== label;
      existing.label = label;
      existing.lastSeen = now;
      if (!changed) return;
    } else {
      this.devices.set(deviceId, {
        deviceId,
        label,
        lastSeen: now,
        isPreferredSpeaker: false,
      });
      this.enforceCap();
    }
    this.persist();
  }

  /**
   * Bound the map: when it exceeds MAX_DEVICES, LRU-evict the oldest by lastSeen,
   * but never evict preferred speakers (they carry the device-memory the registry
   * exists for) or the currently-active player. Called only on inserts, so the
   * map settles at MAX_DEVICES rather than growing without limit.
   */
  private enforceCap(): void {
    if (this.devices.size <= MAX_DEVICES) return;
    const evictable = [...this.devices.values()]
      .filter((d) => !d.isPreferredSpeaker && d.deviceId !== this._activeDeviceId)
      .sort((a, b) => a.lastSeen - b.lastSeen);
    let toRemove = this.devices.size - MAX_DEVICES;
    for (const rec of evictable) {
      if (toRemove <= 0) break;
      this.devices.delete(rec.deviceId);
      toRemove--;
    }
  }

  get activePlayerDeviceId(): string | null {
    return this._activeDeviceId;
  }

  get activePlayerLabel(): string | null {
    if (!this._activeDeviceId) return null;
    return this.devices.get(this._activeDeviceId)?.label ?? null;
  }

  claim(deviceId: string, sink: RegistrySink): void {
    if (this._activeDeviceId === deviceId && this.activeSink === sink) {
      this.station.resume();
      return;
    }
    this.stepDownActive();
    this._activeDeviceId = deviceId;
    this.activeSink = sink;
    this.station.attachSink(sink);
    this.station.resume();
  }

  /** Relinquish + detach whatever is currently active. Does NOT touch _activeDeviceId. */
  private stepDownActive(): void {
    if (this.activeSink) this.activeSink.relinquish();
    if (this._activeDeviceId !== null) this.station.detachSink();
    this.activeSink = null;
  }

  release(deviceId: string): { activePlayerDeviceId: string | null } {
    if (this._activeDeviceId !== deviceId) return { activePlayerDeviceId: this._activeDeviceId };
    this.stepDownActive();
    this._activeDeviceId = null;
    this.station.pause(); // preserve current/seed/position; just stop output
    return { activePlayerDeviceId: this._activeDeviceId };
  }

  remember(deviceId: string): { activePlayerDeviceId: string | null } {
    const rec = this.devices.get(deviceId);
    if (rec) {
      rec.isPreferredSpeaker = true;
      this.persist();
    }
    return { activePlayerDeviceId: this._activeDeviceId };
  }

  forget(deviceId: string): { activePlayerDeviceId: string | null } {
    const rec = this.devices.get(deviceId);
    if (rec) {
      rec.isPreferredSpeaker = false;
      this.persist();
    }
    return { activePlayerDeviceId: this._activeDeviceId };
  }
  onConnect(deviceId: string, sink: RegistrySink): void {
    // Live presence FIRST: every connected client counts toward the listeners
    // roster, independent of whether it is/auto-becomes the speaker below. Must
    // run before the early-returns so non-speaker listeners are still tracked.
    const displayName = this.devices.get(deviceId)?.label ?? deviceId;
    const pres = this.connected.get(deviceId);
    if (pres) {
      pres.connections++;
      pres.displayName = displayName; // refresh in case the label changed since
    } else {
      this.connected.set(deviceId, { displayName, connections: 1 });
    }

    const rec = this.devices.get(deviceId);
    if (!rec || !rec.isPreferredSpeaker) return; // not a remembered speaker
    if (this._activeDeviceId !== null) return; // a player is already active
    // Auto-designate: same path as a manual claim.
    this.claim(deviceId, sink);
  }

  /**
   * Decrement the live connection count for a device on socket close, dropping
   * it from the roster when its last socket goes. deviceId-scoped (not
   * sink-scoped): each socket contributes exactly one increment (onConnect) and
   * one decrement (here), so multi-tab / reload overlap nets out correctly.
   */
  trackDisconnect(deviceId: string): void {
    const pres = this.connected.get(deviceId);
    if (!pres) return;
    pres.connections--;
    if (pres.connections <= 0) this.connected.delete(deviceId);
  }

  /** One entry per currently-connected device for the live listeners roster. */
  listConnected(): PresenceUser[] {
    return [...this.connected.entries()].map(([deviceId, p]) => ({
      deviceId,
      displayName: p.displayName,
      isSpeaker: deviceId === this._activeDeviceId,
    }));
  }
  onDisconnect(deviceId: string, sink?: RegistrySink): void {
    if (this._activeDeviceId !== deviceId) return;
    // Sink-scoped: if a sink is provided, only tear down when it is the CURRENTLY
    // active sink. A page reload swaps in a fresh sink via claim() (same deviceId,
    // new sink); the OLD socket's stale close then fires onDisconnect(deviceId) —
    // matching deviceId but NOT the live sink. Without this guard that stale close
    // would kill the just-claimed, legitimately-active session (0 active players).
    if (sink !== undefined && this.activeSink !== sink) return;
    // The socket is already closed: do NOT call relinquish() (would throw / no-op).
    if (this._activeDeviceId !== null) this.station.detachSink();
    this.activeSink = null;
    this._activeDeviceId = null;
    this.station.pause(); // preserve seed/current/position; resumes on reconnect via onConnect
  }
  isSpeaker(deviceId: string): boolean {
    return this._activeDeviceId === deviceId;
  }
}
