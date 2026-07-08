// web mirror of src/types/index.ts — keep in sync; domain/DTO/WS types only.
// ============================================================================
// lan-jukebox — canonical shared types (src/types/index.ts)
// Single source of truth. Every backend module + (mirrored in web/src/types.ts)
// the UI imports from here. ESM/NodeNext: relative imports use the .js extension.
// ============================================================================

// ---------------------------------------------------------------------------
// Domain: track / audio (YouTube only)
// ---------------------------------------------------------------------------

/** YouTube live-status enum. Kept for the live-stream guard in youtube/. */
export type LiveStatus = "not_live" | "is_live" | "is_upcoming" | "was_live" | "post_live";

/** Canonical YouTube track metadata. videoId IS the trackId used by /audio/:trackId. */
export interface TrackMeta {
  videoId: string;
  title: string;
  channel: string;
  durationSec: number | null;
  isLive: boolean;
  thumbnailUrl: string | null;
}

/** Real audio format of a downloaded track file (drives §8 serve-as-is vs transcode). */
export interface AudioInfo {
  codec: string;
  bitrateKbps: number;
  sampleRateHz: number;
}

// ---------------------------------------------------------------------------
// Attribution (deviceId only — no avatar, no chat-platform source)
// ---------------------------------------------------------------------------

/** Where a queue add originated. "user" = a browser remote; "autoplay" = the radio engine. */
export type RequestSource = "user" | "autoplay";

/** Attribution only — NOT a security boundary (spec §7). */
export interface Requester {
  deviceId: string;
  displayName: string;
  source: RequestSource;
}

/** Synthetic requester tagging radio-injected tracks (bypass cap, don't reset seed chain). */
export const AUTOPLAY_REQUESTER: Requester = {
  deviceId: "autoplay",
  displayName: "Autoplay",
  source: "autoplay",
};

/** One entry in the station queue. id is a per-add UUID, distinct from meta.videoId. */
export interface QueueItem {
  id: string;
  meta: TrackMeta;
  requester: Requester;
  addedAt: number;
  /** Real audio format; null until the file has been downloaded. */
  audio: AudioInfo | null;
  /** True when this item was appended by the radio engine (drives the UI radio-preview tag). */
  fromRadio: boolean;
}

/** Pure queue snapshot (queue/ module). */
export interface QueueSnapshot {
  current: QueueItem | null;
  upcoming: QueueItem[];
  history: QueueItem[];
}

// ---------------------------------------------------------------------------
// Station settings (pruned: no idle/crossfade/loudnorm/fx/commandChannel)
// ---------------------------------------------------------------------------

export type RepeatMode = "off" | "one" | "all";
export type AutoplaySource = "radio" | "artist";

export interface StationSettings {
  repeat: RepeatMode;
  /** Always-on radio; defaults true for the jukebox. */
  autoplay: boolean;
  autoplaySource: AutoplaySource;
  /** Browser <audio>.volume target, 0..200 (pct). */
  volume: number;
  /** 0 = no limit. */
  maxTrackDurationSec: number;
  /** Equal-power crossfade overlap in seconds; 0 = off. Clamped to [0, CROSSFADE_MAX]. */
  crossfadeSec: number;
}

export const DEFAULT_SETTINGS: StationSettings = {
  repeat: "off",
  autoplay: true,
  autoplaySource: "radio",
  volume: 100,
  maxTrackDurationSec: 0,
  crossfadeSec: 10,
};

export const VOLUME_MAX = 200;
export const MAX_TRACK_DURATION_CEILING_SEC = 21600;
export const CROSSFADE_MAX = 20;

// ---------------------------------------------------------------------------
// Preparing (live fetch status surfaced in /api/state)
// ---------------------------------------------------------------------------

export type PreparingPhase = "resolving" | "downloading" | "processing";

export interface PreparingState {
  videoId: string;
  title: string;
  phase: PreparingPhase;
  percent?: number;
}

// ---------------------------------------------------------------------------
// Device registry / player role (spec §5)
// ---------------------------------------------------------------------------

export interface DeviceRecord {
  deviceId: string;
  /** Human label = the device's last displayName. */
  label: string;
  lastSeen: number;
  isPreferredSpeaker: boolean;
}

/** Persisted device-registry file shape (under CACHE_DIR). */
export interface DeviceRegistryFile {
  version: 1;
  savedAt: number;
  devices: DeviceRecord[];
}

// ---------------------------------------------------------------------------
// Live listeners (presence) — currently-connected clients, deduped per device
// ---------------------------------------------------------------------------

/** One currently-connected client in the live roster (deduped per deviceId). */
export interface PresenceUser {
  deviceId: string;
  displayName: string;
  isSpeaker: boolean;
}

// ---------------------------------------------------------------------------
// Station snapshot (the broadcast shape AND the persisted state shape)
// ---------------------------------------------------------------------------

/** The now-playing item augmented with live position/duration. */
export type CurrentItem = QueueItem & { positionMs: number; durationMs: number };

/**
 * The full station state broadcast over WS ('state') and returned by GET /api/state.
 * Extends StationSettings (flattened, mirroring the bot's ControllerSnapshot).
 * The per-request fields (isThisDeviceSpeaker) are filled by the server, not the orchestrator.
 */
export interface StationSnapshot extends StationSettings {
  current: CurrentItem | null;
  upcoming: QueueItem[];
  /** Buffered radio tracks not yet promoted (UI "upcoming-radio preview"). */
  upcomingRadio: QueueItem[];
  history: QueueItem[];
  /** The most recent user-queued track — the radio seed. null = cold start. */
  seed: TrackMeta | null;
  paused: boolean;
  preparing: PreparingState | null;
  /** true when a Player (active speaker) is connected. */
  activePlayerPresent: boolean;
  /** label of the active player device, for the UI. */
  activePlayerLabel: string | null;
  /** Currently-connected clients (deduped per device) for the live listeners roster. */
  listeners: PresenceUser[];
}

/** Per-viewer view of the snapshot returned by GET /api/state (adds request-scoped flags). */
export interface StationStateResponse extends StationSnapshot {
  isThisDeviceSpeaker: boolean;
}

/** Restart-safe persisted station file (under CACHE_DIR). */
export interface StationSnapshotFile {
  version: 1;
  savedAt: number;
  seed: TrackMeta | null;
  current: QueueItem | null;
  positionMs: number;
  /** explicit user queue (excludes radio buffer). */
  queue: QueueItem[];
  /** pre-resolved radio buffer. */
  upcomingRadio: QueueItem[];
  history: QueueItem[];
  settings: StationSettings;
  activePlayerDeviceId: string | null;
}

// ---------------------------------------------------------------------------
// REST DTOs (spec §6)
// ---------------------------------------------------------------------------

export interface LoginRequest {
  password: string;
  displayName: string;
  deviceId: string;
}
export interface SessionInfo {
  displayName: string;
  deviceId: string;
}

export interface AddRequest {
  urlOrQuery: string;
}
/** Either queued directly (link) or returned candidates (search → pick). */
export interface AddResponse {
  queued?: { id: string; title: string };
  candidates?: TrackMeta[];
}

export interface PickRequest {
  candidateId: string; // a videoId from a prior AddResponse.candidates
}
export interface PickResponse {
  queued: { id: string; title: string };
}

export type ControlAction =
  | "play"
  | "pause"
  | "skip"
  | "seek"
  | "volume"
  | "repeat"
  | "shuffle"
  | "clear"
  | "remove"
  | "reorder"
  | "jump"
  | "settings";

/** value shape depends on action; validated server-side. */
export interface ControlRequest {
  action: ControlAction;
  value?:
    | number // seek(ms), volume(pct)
    | RepeatMode // repeat
    | { itemId: string } // remove, jump
    | { itemId: string; toIndex: number } // reorder
    | Partial<StationSettings>; // settings
}
export interface ControlResponse {
  ok: boolean;
}

export type SpeakerAction = "claim" | "release" | "remember" | "forget";
export interface SpeakerRequest {
  action: SpeakerAction;
}
export interface SpeakerResponse {
  ok: boolean;
  activePlayerDeviceId: string | null;
}

export interface LyricsResult {
  lyrics: string | null;
  source: string;
}

export interface ApiErrorBody {
  error: string;
}

// ---------------------------------------------------------------------------
// WebSocket protocol (spec §6). Discriminated unions on `type`.
// ---------------------------------------------------------------------------

/** Client → server. The socket's deviceId is taken from the session, echoed in hello. */
export type ClientWsMessage =
  | { type: "hello"; deviceId: string; role: "remote" }
  | { type: "becomePlayer" }
  | { type: "relinquishPlayer" }
  | { type: "position"; ms: number }
  | { type: "trackEnded" }
  | { type: "crossfadeAdvance" }
  | { type: "playbackError"; message: string };

/** Server → all subscribers (broadcast). */
export type ServerBroadcastMessage =
  | { type: "state"; state: StationSnapshot }
  | { type: "trackError"; videoId: string; title: string; reason: string };

/** Server → the active Player only (audio sink commands). */
export type ServerPlayerMessage =
  | { type: "load"; audioUrl: string; startMs: number }
  | { type: "play" }
  | { type: "pause" }
  | { type: "seek"; ms: number }
  | { type: "setVolume"; pct: number };

export type ServerWsMessage = ServerBroadcastMessage | ServerPlayerMessage;
