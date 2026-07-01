import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeviceRecord, DeviceRegistryFile, StationSnapshot } from "../types/index.js";
import { DEVICE_REGISTRY_FILE, readDeviceRegistry } from "./persist.js";

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

export class PlayerRegistry {
  private readonly dir: string;
  private readonly station: StationLike;
  private readonly now: () => number;
  private devices = new Map<string, DeviceRecord>();
  private _activeDeviceId: string | null = null;
  private activeSink: RegistrySink | null = null;

  constructor(deps: PlayerRegistryDeps) {
    this.dir = deps.dir;
    this.station = deps.station;
    this.now = deps.now ?? Date.now;
  }

  async init(): Promise<void> {
    const file = await readDeviceRegistry(this.dir);
    this.devices = new Map((file?.devices ?? []).map((d) => [d.deviceId, { ...d }]));
  }

  private toFile(): DeviceRegistryFile {
    return {
      version: 1,
      savedAt: this.now(),
      devices: [...this.devices.values()],
    };
  }

  private persist(): void {
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
  }

  touch(deviceId: string, label: string): void {
    const existing = this.devices.get(deviceId);
    if (existing) {
      existing.label = label;
      existing.lastSeen = this.now();
    } else {
      this.devices.set(deviceId, {
        deviceId,
        label,
        lastSeen: this.now(),
        isPreferredSpeaker: false,
      });
    }
    this.persist();
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
    const rec = this.devices.get(deviceId);
    if (!rec || !rec.isPreferredSpeaker) return; // not a remembered speaker
    if (this._activeDeviceId !== null) return; // a player is already active
    // Auto-designate: same path as a manual claim.
    this.claim(deviceId, sink);
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
