import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type {
  QueueItem,
  StationSettings,
  StationSnapshot,
  StationSnapshotFile,
  TrackMeta,
} from "../types/index.js";

export const STATION_SNAPSHOT_FILE = "station-snapshot.json";

interface StationLike {
  snapshot(): StationSnapshot;
  settings: StationSettings;
  seed: TrackMeta | null;
}

/** Build the restart-safe persisted file from the controller's live snapshot. */
export function collectStationSnapshot(
  station: StationLike,
  activePlayerDeviceId: string | null,
  now: number,
): StationSnapshotFile {
  const snap = station.snapshot();
  // strip the live-only positionMs/durationMs off current → a plain QueueItem for persistence.
  const current: QueueItem | null = snap.current
    ? {
        id: snap.current.id,
        meta: snap.current.meta,
        requester: snap.current.requester,
        addedAt: snap.current.addedAt,
        audio: snap.current.audio,
        fromRadio: snap.current.fromRadio,
      }
    : null;
  return {
    version: 1,
    savedAt: now,
    seed: snap.seed,
    current,
    positionMs: snap.current ? snap.current.positionMs : 0,
    queue: snap.upcoming.map((i) => ({ ...i })),
    upcomingRadio: snap.upcomingRadio.map((i) => ({ ...i })),
    history: snap.history.map((i) => ({ ...i })),
    settings: { ...station.settings },
    activePlayerDeviceId,
  };
}

export async function writeStationSnapshot(dir: string, file: StationSnapshotFile): Promise<void> {
  await mkdir(dir, { recursive: true });
  // Per-write unique suffix (pid alone collides when two saves from the SAME process overlap —
  // a debounced + interval save firing together, a save triggered while a prior one is in
  // flight — making all-but-one rename ENOENT once the first winner moves the tmp away).
  const tmp = join(
    dir,
    `${STATION_SNAPSHOT_FILE}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  await writeFile(tmp, JSON.stringify(file));
  await rename(tmp, join(dir, STATION_SNAPSHOT_FILE)); // atomic swap
}

export async function readStationSnapshot(dir: string): Promise<StationSnapshotFile | null> {
  try {
    const raw = await readFile(join(dir, STATION_SNAPSHOT_FILE), "utf8");
    const parsed = JSON.parse(raw) as StationSnapshotFile;
    return parsed && parsed.version === 1 && Array.isArray(parsed.queue) ? parsed : null;
  } catch {
    return null;
  }
}

export async function restoreStationSnapshot(
  file: StationSnapshotFile,
  station: { restore(file: StationSnapshotFile): Promise<void> },
  log: Pick<Logger, "info" | "error">,
): Promise<void> {
  try {
    await station.restore(file);
    log.info(
      {
        tracks: (file.queue?.length ?? 0) + (file.current ? 1 : 0),
        seed: file.seed?.videoId ?? null,
      },
      "restored station",
    );
  } catch (err) {
    log.error({ err }, "failed to restore station");
  }
}
