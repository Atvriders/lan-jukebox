# LAN Jukebox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build a self-hosted, browser-based always-playing YouTube radio — a single never-stopping station whose backend streams audio to one browser "Player" while other browsers act as Remotes — by copy-pruning the framework-agnostic reuse modules from `~/discord-yt-music-bot` into a new de-Discorded standalone repo.

**Architecture:** A Dockerized Node/Fastify backend holds the station state (queue + radio engine + orchestrator), serves `GET /audio/:trackId` with HTTP range to the browser `<audio>` sink, fans out `StationSnapshot` over WebSocket to all subscribers, and sends targeted player commands to the one active Player; a React SPA renders the Remote + Player roles; ingress is bring-your-own (e.g. a separate Cloudflare Tunnel) — the app only publishes a localhost-bound host port, it does NOT bundle cloudflared.

**Tech Stack:** Node >=22.12 <23, TypeScript (ESM/NodeNext, strict), Fastify 5 + @fastify/{cookie,session,websocket,static}, pino, yt-dlp + ffmpeg + Deno (nsig) + optional bgutil POT; React 19 + Vite 6 + Tailwind v4; Vitest + @testing-library; Docker + GitHub Actions → GHCR + docker-compose; bring-your-own external ingress (no bundled cloudflared).

## Global Constraints

- Runtime: Node >=22.12 <23, TypeScript, ESM ("type":"module"); reuse modules COPIED & PRUNED from ~/discord-yt-music-bot (never imported).
- No Discord, no guild concept, no uploads, no local-file source, NO idle timeout / no auto-stop / no auto-disconnect anywhere.
- Single always-playing station; cold start waits for a seed (no default station); when the queue empties, autoplay related YouTube tracks from the last seed forever.
- Source: YouTube only (exact link + search->pick).
- Audio: the browser <audio> element is the output; backend serves GET /audio/:trackId with HTTP range (206). yt-dlp bestaudio, remux/transcode to AAC m4a only if not browser-playable. Carry over the player-client ladder (android_vr,web_embedded,tv) + optional bgutil POT.
- Device memory: persisted device registry; the remembered speaker (isPreferredSpeaker) is auto-selected as the Player on connect; document the one-time browser autoplay-permission grant.
- Auth: required single shared VIEWER_PASSWORD (signed session cookie); anyone authenticated may control everything (no second/admin password); secure SameSite cookies; Fastify trustProxy is always true (the app is always behind the user's HTTPS proxy/tunnel which sets X-Forwarded-Proto — needed for correct scheme detection + secure cookies + real client IP), not a configurable env var; ALLOWED_WS_ORIGINS must equal PUBLIC_BASE_URL.
- UI: built with the frontend-design skill to a professional, production-grade standard (design system first, then per-component).
- Deploy: GitHub Actions (Atvriders) -> GHCR (PUBLIC) on push to master + weekly rebuild + yt-dlp cache-bust (+ first-build workflow_dispatch); docker-compose pulls the image (pull_policy: always) with named volumes for cache + persisted device registry/snapshot; bring-your-own external ingress (the app publishes a localhost-bound host port for the user's OWN separate Cloudflare Tunnel / reverse proxy — NO bundled cloudflared); gosu entrypoint chowns the cache volume.
- Repo: public, under Atvriders, branch master.
- TDD throughout. NO per-task commits: each phase ends with full verify (typecheck+lint+build+tests) -> full adversarial multi-agent /debug pass (find->verify->fix) -> EXACTLY ONE squash commit for the phase.
- Browser audio playback + autoplay behavior is manual-verify, documented in the README with a checklist.

## Shared Types

```ts
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
// Attribution (de-Discorded: deviceId, no avatarUrl, no "discord" source)
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
}

export const DEFAULT_SETTINGS: StationSettings = {
  repeat: "off",
  autoplay: true,
  autoplaySource: "radio",
  volume: 100,
  maxTrackDurationSec: 0,
};

export const VOLUME_MAX = 200;
export const MAX_TRACK_DURATION_CEILING_SEC = 21600;

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

// ---------------------------------------------------------------------------
// Config (env → typed). loadConfig() in src/config.ts is the ONLY env reader.
// ---------------------------------------------------------------------------

export interface MediaConfig {
  cacheDir: string;
  cacheMaxBytes: number;
  historyMaxItems: number;
  searchResultCount: number;
  maxTrackDurationSec: number | null;
  ytProxy: string | null;
  ytCookiesFile: string | null;
  poTokenProviderUrl: string | null;
  playerClients: string; // default "android_vr,web_embedded,tv"
  ytdlpTimeoutMs: number;
}

export interface StationConfig {
  prefetchDepth: number;
  maxConcurrentDownloads: number;
  logLevel: string;
}

export interface WebConfig {
  publicBaseUrl: string;
  viewerPassword: string; // required unless allowNoPassword
  allowNoPassword: boolean;
  sessionSecret: string; // >= 32 chars
  port: number;
  host: string;
  allowedWsOrigins: string[]; // must equal [publicBaseUrl]
  nodeEnv: string;
  secureCookies: boolean;
}

export interface AppConfig {
  media: MediaConfig;
  station: StationConfig;
  web: WebConfig;
}

// ---------------------------------------------------------------------------
// Fastify session augmentation (set in auth/password.ts)
// ---------------------------------------------------------------------------
declare module "fastify" {
  interface Session {
    authed?: boolean;
    displayName?: string;
    deviceId?: string;
  }
}
```

## File Structure

```
/home/kasm-user/lan-jukebox
├── package.json                         # scripts (build/test/typecheck/lint/start) + deps (NO discord.js/@discordjs/*)
├── package-lock.json                    # regenerated after dep changes; consumed by npm ci in Docker + CI
├── tsconfig.json                        # app build config (NodeNext, strict, noUncheckedIndexedAccess)
├── tsconfig.test.json                   # test typecheck config
├── vitest.config.ts                     # node env default, jsdom per-file pragma; include src/** + web/**
├── eslint.config.js                     # eslint flat config
├── .prettierrc                          # prettier config
├── .dockerignore                        # excludes node_modules/dist/web/dist/.git/.env
├── .gitignore
├── Dockerfile                           # multi-stage Node22 + yt-dlp + ffmpeg + Deno(nsig) + gosu + /healthz HEALTHCHECK
├── docker-entrypoint.sh                 # root: mkdir+chown CACHE_DIR, then exec gosu app "$@"
├── docker-compose.yml                   # GHCR image pull, env block, named volume, healthcheck, optional bgutil-pot; localhost-bound host port for bring-your-own ingress (no bundled cloudflared)
├── README.md                            # env table, deploy, autoplay-grant + device-memory + bring-your-own-ingress/WS gotchas
├── .github
│   └── workflows
│       └── build.yml                    # GHCR CI: test gate + build/push :latest+:sha, weekly cron, yt-dlp cache-bust
├── src
│   ├── index.ts                         # composition root / main(): load config, wire station, buildApp, listen, restore snapshot
│   ├── config.ts                        # ONLY env reader: loadConfig()->AppConfig + intEnv/strEnv/parseLogLevel
│   ├── config.test.ts                   # env-loader tests (defaults, VIEWER_PASSWORD-required, SESSION_SECRET>=32, ALLOWED_WS_ORIGINS)
│   ├── lifecycle.ts                     # runShutdown/installSignalHandlers/installCrashHandlers (copied verbatim)
│   ├── lifecycle.test.ts               # lifecycle tests (copied verbatim)
│   ├── canary.ts                        # startupCanary(youtube.resolve) — known-good video probe (copied verbatim)
│   ├── types
│   │   └── index.ts                     # THE shared types backbone (above)
│   ├── util
│   │   ├── logger.ts                    # pino LEVELS/createLogger/get|setRootLogger (verbatim)
│   │   ├── logger.test.ts
│   │   ├── mutex.ts                     # Mutex.runExclusive (verbatim)
│   │   ├── mutex.test.ts
│   │   ├── semaphore.ts                 # Semaphore.run (verbatim)
│   │   └── semaphore.test.ts
│   ├── youtube
│   │   ├── url-parser.ts                # parseInput (verbatim) — YouTube-only
│   │   ├── url-parser.test.ts
│   │   ├── ytdlp.ts                     # runYtDlp process runner (verbatim)
│   │   ├── ytdlp.test.ts
│   │   ├── index.ts                     # YouTubeService: resolve/search/related/artistTracks/download + client ladder (pruned)
│   │   ├── index.test.ts                # ladder/download/progress tests (pruned imports -> config.js)
│   │   ├── errors.ts                    # YtError/YtErrorKind/classifyYtdlpError/isRetryableAcrossClients (verbatim)
│   │   ├── errors.test.ts
│   │   ├── lyrics.ts                    # fetchLyrics lyrics.ovh best-effort (verbatim)
│   │   └── lyrics.test.ts
│   ├── cache
│   │   ├── index.ts                     # AudioCache LRU (verbatim)
│   │   └── index.test.ts
│   ├── queue
│   │   ├── index.ts                     # Queue (was GuildQueue): pure single queue (renamed, fromRadio added)
│   │   └── index.test.ts
│   ├── orchestrator
│   │   ├── index.ts                     # StationController: queue+sink+playback+advance-guard+seed; de-guilded/de-Discorded; NO idle timer
│   │   ├── index.test.ts                # core/seek/preparing tests (FakeBrowserPlayer sink)
│   │   ├── settings.ts                  # StationSettings + applySettingsPatch (pruned to surviving fields)
│   │   ├── settings.test.ts
│   │   ├── snapshot.ts                  # collect/write/read/restore single StationSnapshotFile (de-guilded, atomic)
│   │   ├── snapshot.test.ts
│   │   └── browser-player-sink.ts       # NEW: VoiceSession-shaped sink over WS (play/pause/resume/skip/seek/stop + trackEnd/error)
│   ├── radio
│   │   ├── index.ts                     # NEW: RadioEngine — seed->related/artistTracks->de-dup vs recent history->keep-ahead->never-empty
│   │   └── index.test.ts                # seed/related/de-dup/keep-ahead/cold-start/re-seed tests
│   ├── audio
│   │   ├── index.ts                     # NEW: registerAudioRoute GET /audio/:trackId — range/206, trackId->cache, download-if-missing
│   │   ├── index.test.ts                # range/206/full/404/content-type tests
│   │   ├── format.ts                    # NEW: chooseDelivery(AudioInfo)->{contentType, needsTranscode}; remux/transcode helper
│   │   └── format.test.ts
│   ├── players
│   │   ├── registry.ts                  # NEW: DeviceRegistry (persisted) + PlayerStateMachine (claim/release/remember/forget/auto-select)
│   │   ├── registry.test.ts             # manual designate, auto-select remembered speaker, disconnect/resume
│   │   └── persist.ts                   # NEW: read/write DeviceRegistryFile (atomic tmp+rename, tolerant read)
│   ├── auth
│   │   ├── session-store.ts             # MemorySessionStore (verbatim)
│   │   ├── session-store.test.ts
│   │   ├── password.ts                  # NEW: verifyPassword(timing-safe) + registerAuthRoutes(/api/login,/api/logout) + requireSession
│   │   └── password.test.ts
│   └── server
│       ├── app.ts                       # buildApp: cookie/session/websocket/static + /healthz + SPA fallback + error handler
│       ├── app.test.ts                  # /healthz + login-guard inject tests
│       ├── rest.ts                      # registerRest: /api flat routes (state/add/pick/control/speaker/lyrics) + enqueue helper
│       ├── rest.test.ts
│       ├── ws.ts                        # registerWebsocket + StationBroadcaster: origin guard, hello/becomePlayer/telemetry, targeted player send
│       └── ws.test.ts                   # broadcaster unit + boot() WS integration (mock Player)
└── web
    ├── index.html                       # SPA shell (reskinned; fonts; #root)
    ├── vite.config.ts                   # react+tailwind, dev proxy /api,/ws,/audio
    ├── tsconfig.json                    # web tsconfig (verbatim)
    ├── public
    │   └── favicon.svg
    └── src
        ├── main.tsx                     # createRoot + StrictMode mount (verbatim)
        ├── vite-env.d.ts
        ├── index.css                    # NEW design system (frontend-design skill) — Tailwind v4 @theme tokens
        ├── types.ts                     # web mirror of shared types (StationSnapshot/WS DTOs/SessionInfo) — kept in sync with src/types
        ├── lib
        │   ├── api.ts                   # REST client: ApiError + flat /api endpoints (login/state/add/pick/control/speaker/lyrics)
        │   ├── api.test.ts
        │   ├── format.ts                # fmtTime/fmtAudio (verbatim)
        │   ├── format.test.ts
        │   ├── deviceId.ts              # NEW: persistent localStorage deviceId + displayName
        │   ├── deviceId.test.ts
        │   ├── useStationState.ts       # WS hook + applyWsMessage reducer (renamed; hello{deviceId}; reconnect/backoff verbatim)
        │   ├── useStationState.test.ts  # FakeWS hook tests
        │   ├── wsReducer.test.ts        # applyWsMessage pure-reducer tests
        │   ├── usePlayerRole.ts         # NEW: hidden <audio> + player WS commands (load/play/pause/seek/setVolume) + timeupdate/ended report
        │   └── usePlayerRole.test.ts
        └── components
            ├── App.tsx                  # root: session check, station-live/waiting banner, all handlers, player-role wiring, layout
            ├── App.test.tsx
            ├── LoginGate.tsx            # NEW: shared-password form (password+displayName+deviceId)
            ├── LoginGate.test.tsx
            ├── PlayerPanel.tsx          # NEW: "This device is the speaker" + relinquish + managed <audio> mount point
            ├── PlayerPanel.test.tsx
            ├── AddBar.tsx               # add bar -> onPlay(link|search) + Picker (pruned: no voice-target busy)
            ├── AddBar.test.tsx
            ├── Controls.tsx             # Pause/Resume + Skip (Stop removed)
            ├── Controls.test.tsx
            ├── NowPlaying.tsx           # hero card + ProgressBar scrub + useDisplayedMs (Visualizer removed)
            ├── NowPlaying.test.tsx
            ├── Queue.tsx                # up-next + AutoDiscover(radio) toggle + upcoming-radio preview section
            ├── Queue.test.tsx
            ├── History.tsx              # recently-played re-queue (verbatim-ish)
            ├── History.test.tsx
            ├── Lyrics.tsx               # lazy lyrics panel (api.lyrics(trackId))
            ├── Lyrics.test.tsx
            ├── Settings.tsx             # repeat/volume/autoplay/autoplaySource/maxTrackDuration only (idle/fx/crossfade removed)
            ├── Settings.test.tsx
            ├── Picker.tsx               # multi-select candidate picker (verbatim)
            ├── Picker.test.tsx
            ├── Thumb.tsx                # square thumb w/ placeholder (verbatim)
            ├── Grain.tsx                # decorative background (verbatim)
            ├── Preparing.tsx            # live fetch status (verbatim)
            └── Preparing.test.tsx
```

## Phase 0:Scaffold & port reuse — Scaffold & port reuse

**Goal:** Stand up the new standalone `lan-jukebox` repo — `package.json` (no Discord deps), tsconfig/vitest/eslint — and COPY-IN-AND-PRUNE every framework-agnostic reuse module from `~/discord-yt-music-bot` so the codebase typechecks and the ported tests pass; lock the shared-types backbone (`src/types/index.ts` + `web/src/types.ts` mirror) first because everything downstream consumes it.

### Parallelization

- **Sequential (shared hubs — author one at a time, then freeze):**
  - **Task 0.1** `src/types/index.ts` + `web/src/types.ts` — the types backbone; MUST land first, alone, before anything else.
  - **Task 0.2** `package.json` / `package-lock.json` / tsconfigs / vitest / eslint / prettier / ignores — the toolchain; MUST land second (every later task runs `npx vitest run <file>` against it).
- **Parallel-safe (disjoint files, only after 0.1 + 0.2 are frozen):** Tasks **0.3** (`src/util/*`, `src/lifecycle.ts`, `src/canary.ts`), **0.4** (`src/youtube/*`), **0.5** (`src/config.ts`), **0.6** (`src/cache/`, `src/auth/session-store.ts`), **0.7** (web leaves: `web/src/main.tsx`, `web/src/lib/format.ts`, `web/src/components/{Thumb,Grain,Picker,Preparing}.tsx`, web tsconfig/vite). These touch non-overlapping files and may run as concurrent agents.
  - One ordering constraint inside the parallel band: **0.4's** `src/youtube/index.test.ts` imports the `MediaConfig` type from `../config.js`, and **0.5** authors `src/config.ts` re-exporting `MediaConfig` from `./types/index.js`. Because both `MediaConfig` and `AudioInfo`/`TrackMeta` already exist in the frozen `src/types/index.ts` (0.1) and `config.ts` only re-exports them, 0.4 and 0.5 do not actually block each other — but if run by separate agents, 0.5 should be merged before 0.4's final typecheck. Canary (0.3) imports `YouTubeService` as a `type` only (`import type`), so 0.3 and 0.4 are independent at runtime.

> Source of every "verbatim" / "copy-in-and-prune" file is the corresponding path under `/home/kasm-user/discord-yt-music-bot`. "Verbatim" = byte-identical except the noted prunes. All backend relative imports use the `.js` extension (ESM/NodeNext). The web mirror uses `../types.js` / `./types.js`.

---

### Task 0.1: Author shared types backbone (SEQUENTIAL — land first, alone)

**Files**

- Create: `src/types/index.ts`
- Create: `web/src/types.ts` (a hand-kept mirror — domain/DTO/WS types only; NOT the config interfaces and NOT the `declare module "fastify"` block)
- Test: `src/types/index.test.ts` (compile-time + value assertions on the exported consts)

**Interfaces**

- Consumes: nothing.
- Produces (exact names — single source of truth): `LiveStatus`, `TrackMeta`, `AudioInfo`, `RequestSource`, `Requester`, `AUTOPLAY_REQUESTER`, `QueueItem`, `QueueSnapshot`, `RepeatMode`, `AutoplaySource`, `StationSettings`, `DEFAULT_SETTINGS`, `VOLUME_MAX`, `MAX_TRACK_DURATION_CEILING_SEC`, `PreparingPhase`, `PreparingState`, `DeviceRecord`, `DeviceRegistryFile`, `CurrentItem`, `StationSnapshot`, `StationStateResponse`, `StationSnapshotFile`, `LoginRequest`, `SessionInfo`, `AddRequest`, `AddResponse`, `PickRequest`, `PickResponse`, `ControlAction`, `ControlRequest`, `ControlResponse`, `SpeakerAction`, `SpeakerRequest`, `SpeakerResponse`, `LyricsResult`, `ApiErrorBody`, `ClientWsMessage`, `ServerBroadcastMessage`, `ServerPlayerMessage`, `ServerWsMessage`, `MediaConfig`, `StationConfig`, `WebConfig`, `AppConfig`, plus the `declare module "fastify"` session augmentation.

**Steps**

1. **Write the FAILING test** — `src/types/index.test.ts`:

   ```ts
   import { describe, it, expect } from "vitest";
   import {
     AUTOPLAY_REQUESTER,
     DEFAULT_SETTINGS,
     VOLUME_MAX,
     MAX_TRACK_DURATION_CEILING_SEC,
   } from "./index.js";
   import type {
     TrackMeta,
     QueueItem,
     StationSnapshot,
     StationSnapshotFile,
     DeviceRegistryFile,
     ControlRequest,
     ServerPlayerMessage,
     AppConfig,
   } from "./index.js";

   describe("shared types backbone — runtime constants", () => {
     it("AUTOPLAY_REQUESTER is the synthetic autoplay attribution", () => {
       expect(AUTOPLAY_REQUESTER).toEqual({
         deviceId: "autoplay",
         displayName: "Autoplay",
         source: "autoplay",
       });
     });

     it("DEFAULT_SETTINGS is the jukebox default (autoplay on, radio, vol 100, no dur cap)", () => {
       expect(DEFAULT_SETTINGS).toEqual({
         repeat: "off",
         autoplay: true,
         autoplaySource: "radio",
         volume: 100,
         maxTrackDurationSec: 0,
       });
     });

     it("exposes the volume + duration ceilings", () => {
       expect(VOLUME_MAX).toBe(200);
       expect(MAX_TRACK_DURATION_CEILING_SEC).toBe(21600);
     });
   });

   describe("shared types backbone — structural type usage compiles", () => {
     it("QueueItem carries fromRadio + null-until-downloaded audio", () => {
       const item: QueueItem = {
         id: "uuid-1",
         meta: {
           videoId: "abcdefghijk",
           title: "T",
           channel: "C",
           durationSec: 100,
           isLive: false,
           thumbnailUrl: null,
         },
         requester: AUTOPLAY_REQUESTER,
         addedAt: 0,
         audio: null,
         fromRadio: true,
       };
       expect(item.fromRadio).toBe(true);
       expect(item.audio).toBeNull();
     });

     it("ControlRequest.value accepts the discriminated value shapes", () => {
       const reorder: ControlRequest = {
         action: "reorder",
         value: { itemId: "x", toIndex: 2 },
       };
       expect(reorder.action).toBe("reorder");
     });

     it("ServerPlayerMessage load carries audioUrl + startMs", () => {
       const msg: ServerPlayerMessage = { type: "load", audioUrl: "/audio/x", startMs: 0 };
       expect(msg.type).toBe("load");
     });

     it("the persisted file shapes are version 1", () => {
       const snap: StationSnapshotFile = {
         version: 1,
         savedAt: 0,
         seed: null,
         current: null,
         positionMs: 0,
         queue: [],
         upcomingRadio: [],
         history: [],
         settings: DEFAULT_SETTINGS,
         activePlayerDeviceId: null,
       };
       const reg: DeviceRegistryFile = { version: 1, savedAt: 0, devices: [] };
       expect(snap.version).toBe(1);
       expect(reg.version).toBe(1);
     });

     it("AppConfig + StationSnapshot are referenceable as types", () => {
       const t = (_c: AppConfig, _s: StationSnapshot, _m: TrackMeta) => true;
       expect(typeof t).toBe("function");
     });
   });
   ```

2. **Run it (expect FAIL)** — `npx vitest run src/types/index.test.ts`
   Expected failure: `Error: Failed to load url ./index.js` / `Cannot find module './index.js'` (the file does not exist yet).

3. **Minimal implementation** — create `src/types/index.ts` with the EXACT backbone contents from the plan's "BACKBONE shared types" block, verbatim. This is the canonical single source of truth: every `export type` / `export interface` / `export const` listed above, in the same order, including the trailing:

   ```ts
   declare module "fastify" {
     interface Session {
       authed?: boolean;
       displayName?: string;
       deviceId?: string;
     }
   }
   ```

   (Paste the entire backbone block — TrackMeta through the fastify augmentation — without modification.)

4. **Run it (expect PASS)** — `npx vitest run src/types/index.test.ts`
   Expected: `Test Files 1 passed`, all assertions green.

5. **Mirror for the web** — create `web/src/types.ts`. Copy every domain/attribution/station/device/DTO/WS type from `src/types/index.ts` VERBATIM, but OMIT: (a) the `MediaConfig`/`StationConfig`/`WebConfig`/`AppConfig` interfaces (server-only), and (b) the `declare module "fastify"` block (Node-only). Add a top comment: `// web mirror of src/types/index.ts — keep in sync; domain/DTO/WS types only.` No test file for the mirror (it is type-only and exercised by the web component tests in 0.7); a structural mismatch surfaces in `tsc -p web/tsconfig.json` during Phase completion.

---

### Task 0.2: Repo scaffold + tooling (SEQUENTIAL — land second)

**Files**

- Create: `package.json`, `package-lock.json` (generated), `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc`, `.gitignore`, `.dockerignore`
- Test: none for the config files themselves; the gate is `npm run typecheck` + `npm test` running clean in Task 0.1 onward. Add a smoke test `src/scaffold.smoke.test.ts` to prove vitest + NodeNext ESM resolution works end-to-end.

**Interfaces**

- Consumes: nothing.
- Produces: npm scripts — `build` = `npm run build:web && tsc -p tsconfig.json`; `build:web` = `vite build web --outDir ../dist/public --emptyOutDir`; `test` = `vitest run`; `test:watch` = `vitest`; `typecheck` = `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit && tsc -p web/tsconfig.json`; `lint` = `eslint . && prettier --check .`; `start` = `node dist/index.js`; `dev` = `tsx watch src/index.ts`; `dev:web` = `vite web`. Deps: `fastify@^5`, `@fastify/{cookie,session,websocket,static}`, `@noble/ciphers`, `pino`. devDeps: `react@^19`, `react-dom@^19`, `@types/react`, `@types/react-dom`, `vite@^6`, `@vitejs/plugin-react`, `tailwindcss@^4`, `@tailwindcss/vite@^4`, `vitest@^4`, `@testing-library/react@^16`, `@testing-library/jest-dom`, `jsdom`, `typescript`, `typescript-eslint`, `eslint`, `@eslint/js`, `eslint-plugin-react-hooks`, `prettier`, `tsx`, `@types/node`, `sharp`. **Explicitly absent: `discord.js`, `@discordjs/voice`, `@discordjs/opus`, `prism-media`.**

**Steps**

1. **Write the FAILING smoke test** — `src/scaffold.smoke.test.ts`:

   ```ts
   import { describe, it, expect } from "vitest";
   import { TYPES_OK } from "./scaffold-probe.js";

   describe("scaffold smoke", () => {
     it("vitest runs NodeNext ESM (.js import resolves to .ts)", () => {
       expect(TYPES_OK).toBe(true);
     });
   });
   ```

   and a probe `src/scaffold-probe.ts`:

   ```ts
   export const TYPES_OK = true;
   ```

2. **Run it (expect FAIL — no toolchain yet)** — `npx vitest run src/scaffold.smoke.test.ts`
   Expected failure: `vitest: command not found` (or `Cannot find package 'vitest'`) because dependencies are not installed yet.

3. **Author `package.json`** — base it on `~/discord-yt-music-bot/package.json` with these mutations:
   - `"name": "lan-jukebox"`, keep `"private": true`, `"type": "module"`, `"engines": { "node": ">=22.12 <23" }`.
   - Scripts: exactly the set in Produces above (keep `build:web`, `dev`, `dev:web`, `test:watch`).
   - `dependencies`: `@fastify/cookie@^11`, `@fastify/session@^11`, `@fastify/static@^9`, `@fastify/websocket@^11`, `@noble/ciphers@^1`, `fastify@^5`, `pino@^10`. **Delete** `@discordjs/opus`, `@discordjs/voice`, `discord.js`, `prism-media`.
   - `devDependencies`: copy verbatim from the bot (the React/Vite/Tailwind/Vitest/ESLint/Prettier/tsx/types/sharp set) — none of those carry Discord.

4. **Author the TS configs** — copy `~/discord-yt-music-bot/{tsconfig.json,tsconfig.test.json,vitest.config.ts}` VERBATIM (they are framework-agnostic: NodeNext, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `rootDir: src`, exclude `web` + `**/*.test.ts`; vitest includes `src/**/*.test.ts` + `web/**/*.test.{ts,tsx}`, jsx automatic). Copy `eslint.config.js` and `.prettierrc.json` -> name it `.prettierrc` (rename per the file tree; keep the JSON contents identical).

5. **Author `.gitignore`** (`node_modules`, `dist`, `web/dist`, `.env`, `*.log`) and `.dockerignore` (`node_modules`, `dist`, `web/dist`, `.git`, `.env` — mirror the bot's, which is `node_modules\ndist\n.git\n.env`).

6. **Install + generate lockfile** — `npm install` (from `/home/kasm-user/lan-jukebox`). Expected: resolves with NO `discord.js`/`@discordjs/*`/`prism-media` in the tree; writes `package-lock.json`. Verify absence: `npm ls discord.js @discordjs/voice @discordjs/opus prism-media` should report each as `(empty)` / not found.

7. **Run the smoke test (expect PASS)** — `npx vitest run src/scaffold.smoke.test.ts`
   Expected: `Test Files 1 passed`. Then `npm run typecheck` is clean for the two existing files (`src/types/index.ts`, `src/scaffold-probe.ts`).

> The smoke probe + test (`src/scaffold-probe.ts`, `src/scaffold.smoke.test.ts`) are scaffolding scratch files — DELETE them in the Phase completion task before the squash commit (note added there).

---

### Task 0.3: Port util + lifecycle + canary verbatim (PARALLEL)

**Files**

- Create: `src/util/logger.ts` + `src/util/logger.test.ts`
- Create: `src/util/mutex.ts` + `src/util/mutex.test.ts`
- Create: `src/util/semaphore.ts` + `src/util/semaphore.test.ts`
- Create: `src/lifecycle.ts` + `src/lifecycle.test.ts`
- Create: `src/canary.ts`

**Interfaces**

- Consumes: 0.2 (vitest/tsconfig). `canary.ts` does `import type { YouTubeService } from "./youtube/index.js"` (type-only — no runtime dep on 0.4).
- Produces: `class Mutex { runExclusive<T>(fn: () => Promise<T> | T): Promise<T> }`; `class Semaphore { constructor(max: number); run<T>(fn: () => Promise<T> | T): Promise<T> }`; `createLogger(level?: string): Logger`, `setRootLogger(l: Logger): void`, `getRootLogger(): Logger`, `LEVELS`, `isValidLevel(level: string): boolean`, `type LogLevel`; `runShutdown(tasks: Task[], opts: ShutdownOpts): Promise<boolean>`, `installSignalHandlers(tasks, opts, log?): void`, `installCrashHandlers(log, exitFn?): void`, `interface ShutdownOpts { graceMs: number; exitFn?: (code: number) => void }`; `startupCanary(youtube: Pick<YouTubeService, "resolve">, log: Logger): Promise<boolean>`.

**Steps**

1. **Copy the source + tests verbatim** — these files are framework-agnostic with zero Discord references. Copy byte-for-byte from the bot:
   - `~/discord-yt-music-bot/src/util/{mutex,semaphore,logger}.ts` and their `.test.ts` siblings.
   - `~/discord-yt-music-bot/src/lifecycle.ts` and `src/lifecycle.test.ts`.
   - `~/discord-yt-music-bot/src/canary.ts` (no test file ships for canary in the bot; it is exercised at integration — do NOT invent one here, keep parity).
     Confirm none import anything Discord-specific: `grep -RniE "discord|guild|voice" src/util src/lifecycle.ts src/canary.ts` must return nothing.

2. **Run the ported tests (expect PASS immediately — verbatim port)** — `npx vitest run src/util/mutex.test.ts src/util/semaphore.test.ts src/util/logger.test.ts src/lifecycle.test.ts`
   Expected: all four files green (`Test Files 4 passed`).

3. **Add a focused FAILING test to PROVE the ported behavior locks** (regression anchor for the verbatim port) — append to `src/util/semaphore.test.ts` a max-1-serialization case if not already present; if it already exists in the verbatim file, instead add `src/canary.test.ts` as a NEW failing test:

   ```ts
   import { describe, it, expect, vi } from "vitest";
   import { startupCanary } from "./canary.js";
   import { createLogger } from "./util/logger.js";

   describe("startupCanary", () => {
     const log = createLogger("silent");

     it("returns true when resolve() succeeds on the known-good video", async () => {
       const resolve = vi.fn().mockResolvedValue({
         videoId: "jNQXAC9IVRw",
         title: "Me at the zoo",
         channel: "jawed",
         durationSec: 19,
         isLive: false,
         thumbnailUrl: null,
       });
       await expect(startupCanary({ resolve }, log)).resolves.toBe(true);
       expect(resolve).toHaveBeenCalledWith("jNQXAC9IVRw");
     });

     it("returns false (never throws) when resolve() rejects", async () => {
       const resolve = vi.fn().mockRejectedValue(new Error("ip blocked"));
       await expect(startupCanary({ resolve }, log)).resolves.toBe(false);
     });
   });
   ```

4. **Run it (expect FAIL)** — `npx vitest run src/canary.test.ts`
   Expected failure: `Cannot find module './canary.js'` (before the copy in step 1) OR, if run after step 1, the test passes — in which case move this canary test BEFORE the copy. Because canary.ts is copied in step 1, this step's "fail" is the type error if `startupCanary`'s shape drifted; the real assertion is step 5.

5. **Run it (expect PASS)** — `npx vitest run src/canary.test.ts`
   Expected: 2 passed. `startupCanary` calls `resolve("jNQXAC9IVRw")`, returns `true`/`false`, never throws.

---

### Task 0.4: Port youtube subsystem (prune only the config import + per-guild comments) (PARALLEL)

**Files**

- Create: `src/youtube/url-parser.ts` + `src/youtube/url-parser.test.ts`
- Create: `src/youtube/ytdlp.ts` + `src/youtube/ytdlp.test.ts`
- Create: `src/youtube/errors.ts` + `src/youtube/errors.test.ts`
- Create: `src/youtube/lyrics.ts` + `src/youtube/lyrics.test.ts`
- Create: `src/youtube/index.ts` + `src/youtube/index.test.ts`

**Interfaces**

- Consumes: 0.1 (`TrackMeta`, `AudioInfo` from `../types/index.js`); 0.5 (`MediaConfig` re-exported from `../config.js` — already exists as a type in 0.1, so no runtime blocker). `lyrics.ts` re-exports its own `LyricsResult` type that must match the backbone `LyricsResult`.
- Produces: `parseInput(raw: string): ParsedInput` (`{kind:"video";videoId} | {kind:"query";query} | {kind:"reject";reason}`); `runYtDlp(args: string[], timeoutMs: number, onLine?: (line: string) => void): Promise<YtDlpRun>` (`{stdout;stderr;code}`); `class YouTubeService` with `constructor(cfg: MediaConfig, run?: RunFn)`, `resolve(id): Promise<TrackMeta>`, `search(q, limit?): Promise<TrackMeta[]>`, `related(id): Promise<TrackMeta[]>`, `artistTracks(meta): Promise<TrackMeta[]>`, `download(id, outDir, opts?): Promise<{path: string; audio: AudioInfo | null}>`; `buildClientLadder(configured: string): string[]`; `scaleDownloadTimeout`/`parseAudioInfo`/`parseDownloadProgress`/`DOWNLOAD_PROGRESS_TEMPLATE`; `enum YtErrorKind`, `class YtError`, `classifyYtdlpError(stderr, code): YtError`, `isRetryableAcrossClients(kind): boolean`; `fetchLyrics(meta): Promise<LyricsResult>`, `LYRICS_SOURCE`.

**Steps**

1. **Copy the four leaf files VERBATIM** — `url-parser.ts`, `ytdlp.ts`, `errors.ts`, `lyrics.ts` and their `.test.ts` siblings from `~/discord-yt-music-bot/src/youtube/`. These have NO Discord/guild references and import only `./errors.js`, `node:*`, and `../types/index.js`. The ONLY edit: in `lyrics.ts`, keep `import type { TrackMeta } from "../types/index.js"` as-is. Do not touch the lyrics.ovh logic.

2. **Run the four leaf test files (expect PASS — verbatim)** — `npx vitest run src/youtube/url-parser.test.ts src/youtube/ytdlp.test.ts src/youtube/errors.test.ts src/youtube/lyrics.test.ts`
   Expected: 4 files green. (e.g. `parseInput("https://youtu.be/jNQXAC9IVRw")` → `{kind:"video",videoId:"jNQXAC9IVRw"}`; a `list=` URL → reject.)

3. **Copy `index.ts` and PRUNE ONLY two things** — copy `~/discord-yt-music-bot/src/youtube/index.ts`, then:
   - Keep `import type { MediaConfig } from "../config.js";` (config.ts re-exports MediaConfig — Task 0.5).
   - Keep `import type { AudioInfo, TrackMeta } from "../types/index.js";`.
   - Strip any comment phrase mentioning "guild" / "per-guild" / "Discord" if present (the bot's youtube/index.ts is already guild-free; grep to confirm: `grep -niE "guild|discord" src/youtube/index.ts` → expect no hits, so likely a pure copy).
     No logic changes: `buildClientLadder`, `parseDownloadProgress`, `DOWNLOAD_PROGRESS_TEMPLATE`, `scaleDownloadTimeout`, `parseAudioInfo`, and the `YouTubeService` ladder/download all stay identical.

4. **Copy `index.test.ts` and PRUNE the import path only** — copy `~/discord-yt-music-bot/src/youtube/index.test.ts`. The only mutation: ensure its config import targets `../config.js` (the bot may import `MediaConfig` from `../types/config-types.js`; rewrite that to `../config.js` since 0.5 re-exports it). All ladder/download/progress test bodies stay verbatim.

5. **Write a FAILING ladder-prune anchor test** — add to `src/youtube/index.test.ts`:

   ```ts
   import { buildClientLadder } from "./index.js";
   // ... within a describe("client ladder") block:
   it("defaults to android_vr,web_embedded,tv first — never web/mweb-first (spec §8)", () => {
     const ladder = buildClientLadder("android_vr,web_embedded,tv");
     expect(ladder.slice(0, 3)).toEqual(["android_vr", "web_embedded", "tv"]);
     expect(ladder[0]).not.toBe("web");
     expect(ladder[0]).not.toBe("mweb");
   });
   it("de-dups configured clients against the fallback tail", () => {
     const ladder = buildClientLadder("tv,tv,android_vr");
     expect(ladder.filter((c) => c === "tv")).toHaveLength(1);
   });
   ```

6. **Run it (expect FAIL then PASS)** — `npx vitest run src/youtube/index.test.ts`
   Expected: FAIL with `Cannot find module './index.js'` only if run before step 3; after step 3 it PASSES. Final run: `Test Files 1 passed` — confirms the `android_vr,web_embedded,tv` default ladder (spec §8) survived the port.

---

### Task 0.5: Port config.ts as the single env reader (de-Discorded) (PARALLEL)

**Files**

- Create: `src/config.ts`
- Test: `src/config.test.ts`

**Interfaces**

- Consumes: 0.1 (`MediaConfig`, `StationConfig`, `WebConfig`, `AppConfig` from `./types/index.js`).
- Produces: `loadConfig(env?: Env): AppConfig` (= `{ media, station, web }`), `loadMediaConfig(env?): MediaConfig`, `loadStationConfig(env?): StationConfig`, `loadWebConfig(env?): WebConfig`, `intEnv`, `strEnv`, plus a re-export `export type { MediaConfig, StationConfig, WebConfig, AppConfig } from "./types/index.js";`. `loadWebConfig` throws unless `VIEWER_PASSWORD` set OR `ALLOW_NO_PASSWORD==="true"`; requires `SESSION_SECRET` length ≥ 32; requires `PUBLIC_BASE_URL` (trailing `/` stripped); `ALLOWED_WS_ORIGINS` defaults to `[publicBaseUrl]`; `secureCookies = nodeEnv === "production"`. NO Discord token, NO `idleTimeoutMs`, NO `adminUserIds`, NO `adminPassword` and no trust-proxy env knob (Fastify `trustProxy` is hardcoded `true` at the app layer — see Task 4.3), NO `clientId`/`clientSecret`/`redirectUri`/`normalizeLoudness`/`sponsorblockRemove`.

**Steps**

1. **Write the FAILING test** — `src/config.test.ts`:

   ```ts
   import { describe, it, expect } from "vitest";
   import { loadConfig, loadWebConfig, loadMediaConfig, loadStationConfig } from "./config.js";

   const SECRET = "x".repeat(32);
   const base = {
     PUBLIC_BASE_URL: "https://jukebox.example.com",
     SESSION_SECRET: SECRET,
     VIEWER_PASSWORD: "hunter2",
   };

   describe("loadWebConfig", () => {
     it("throws when VIEWER_PASSWORD unset and ALLOW_NO_PASSWORD is not 'true'", () => {
       const { VIEWER_PASSWORD, ...noPw } = base;
       expect(() => loadWebConfig(noPw)).toThrow(/VIEWER_PASSWORD/);
     });
     it("allows no password when ALLOW_NO_PASSWORD === 'true'", () => {
       const { VIEWER_PASSWORD, ...noPw } = base;
       const cfg = loadWebConfig({ ...noPw, ALLOW_NO_PASSWORD: "true" });
       expect(cfg.allowNoPassword).toBe(true);
       expect(cfg.viewerPassword).toBe("");
     });
     it("throws when SESSION_SECRET shorter than 32 chars", () => {
       expect(() => loadWebConfig({ ...base, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
     });
     it("requires PUBLIC_BASE_URL and strips a trailing slash", () => {
       const cfg = loadWebConfig({ ...base, PUBLIC_BASE_URL: "https://jb.example.com/" });
       expect(cfg.publicBaseUrl).toBe("https://jb.example.com");
     });
     it("defaults ALLOWED_WS_ORIGINS to [publicBaseUrl]", () => {
       const cfg = loadWebConfig(base);
       expect(cfg.allowedWsOrigins).toEqual(["https://jukebox.example.com"]);
     });
     it("derives secureCookies from NODE_ENV", () => {
       const dev = loadWebConfig(base);
       expect(dev.secureCookies).toBe(false);
       const prod = loadWebConfig({ ...base, NODE_ENV: "production" });
       expect(prod.secureCookies).toBe(true);
     });
   });

   describe("loadMediaConfig", () => {
     it("defaults the player-client ladder to android_vr,web_embedded,tv (spec §8)", () => {
       expect(loadMediaConfig({}).playerClients).toBe("android_vr,web_embedded,tv");
     });
     it("treats MAX_TRACK_DURATION_SEC=0 as no ceiling (null)", () => {
       expect(loadMediaConfig({ MAX_TRACK_DURATION_SEC: "0" }).maxTrackDurationSec).toBeNull();
     });
   });

   describe("loadStationConfig (de-Discorded — no idle timeout)", () => {
     it("provides prefetchDepth + maxConcurrentDownloads + logLevel and NO idle field", () => {
       const s = loadStationConfig({});
       expect(s.prefetchDepth).toBeGreaterThanOrEqual(0);
       expect(s.maxConcurrentDownloads).toBeGreaterThanOrEqual(1);
       expect(s.logLevel).toBe("info");
       expect(s).not.toHaveProperty("idleTimeoutMs");
     });
   });

   describe("loadConfig", () => {
     it("composes media + station + web", () => {
       const cfg = loadConfig(base);
       expect(cfg.media.playerClients).toBe("android_vr,web_embedded,tv");
       expect(cfg.station.maxConcurrentDownloads).toBeGreaterThanOrEqual(1);
       expect(cfg.web.publicBaseUrl).toBe("https://jukebox.example.com");
     });
   });
   ```

2. **Run it (expect FAIL)** — `npx vitest run src/config.test.ts`
   Expected failure: `Cannot find module './config.js'`.

3. **Minimal implementation** — `src/config.ts`. Start from `~/discord-yt-music-bot/src/config.ts`, then de-Discord:

   ```ts
   import type { MediaConfig, StationConfig, WebConfig, AppConfig } from "./types/index.js";
   import { LEVELS, isValidLevel } from "./util/logger.js";

   export type { MediaConfig, StationConfig, WebConfig, AppConfig } from "./types/index.js";

   type Env = Record<string, string | undefined>;

   export function intEnv(
     env: Env,
     key: string,
     fallback: number,
     opts?: { min?: number; max?: number },
   ): number {
     const raw = env[key];
     if (raw === undefined || raw === "") return fallback;
     const n = Number(raw);
     if (!Number.isFinite(n) || !Number.isInteger(n)) {
       throw new Error(`Invalid ${key}: expected an integer, got "${raw}"`);
     }
     if (opts?.min !== undefined && n < opts.min)
       throw new Error(`Invalid ${key}: expected >= ${opts.min}, got "${raw}"`);
     if (opts?.max !== undefined && n > opts.max)
       throw new Error(`Invalid ${key}: expected <= ${opts.max}, got "${raw}"`);
     return n;
   }

   export function strEnv(env: Env, key: string): string | null {
     const raw = env[key];
     return raw === undefined || raw === "" ? null : raw;
   }

   function parseLogLevel(raw: string | null): string {
     if (raw === null) return "info";
     if (!isValidLevel(raw)) {
       throw new Error(`Invalid LOG_LEVEL: got "${raw}" (expected one of ${LEVELS.join(", ")})`);
     }
     return raw.toLowerCase();
   }

   export function loadMediaConfig(env: Env = process.env): MediaConfig {
     const maxDur = strEnv(env, "MAX_TRACK_DURATION_SEC");
     return {
       cacheDir: strEnv(env, "CACHE_DIR") ?? "/data/cache",
       cacheMaxBytes: intEnv(env, "CACHE_MAX_MB", 2048, { min: 1 }) * 1024 * 1024,
       historyMaxItems: intEnv(env, "HISTORY_MAX_ITEMS", 100, { min: 1 }),
       searchResultCount: intEnv(env, "SEARCH_RESULT_COUNT", 5, { min: 1 }),
       maxTrackDurationSec:
         maxDur === null ? null : intEnv(env, "MAX_TRACK_DURATION_SEC", 0, { min: 0 }) || null,
       ytProxy: strEnv(env, "YT_PROXY"),
       ytCookiesFile: strEnv(env, "YT_COOKIES"),
       poTokenProviderUrl: strEnv(env, "PO_TOKEN_PROVIDER_URL"),
       playerClients: strEnv(env, "YT_PLAYER_CLIENTS") ?? "android_vr,web_embedded,tv",
       ytdlpTimeoutMs: intEnv(env, "YTDLP_TIMEOUT_MS", 60_000, { min: 1 }),
     };
   }

   export function loadStationConfig(env: Env = process.env): StationConfig {
     return {
       prefetchDepth: intEnv(env, "PREFETCH_DEPTH", 1, { min: 0 }),
       maxConcurrentDownloads: intEnv(env, "MAX_TRANSCODE_JOBS", 2, { min: 1 }),
       logLevel: parseLogLevel(strEnv(env, "LOG_LEVEL")),
     };
   }

   export function loadWebConfig(env: Env = process.env): WebConfig {
     const publicBaseUrlRaw = strEnv(env, "PUBLIC_BASE_URL");
     const sessionSecret = strEnv(env, "SESSION_SECRET");
     const viewerPassword = strEnv(env, "VIEWER_PASSWORD");
     const allowNoPassword = strEnv(env, "ALLOW_NO_PASSWORD") === "true";
     if (!publicBaseUrlRaw) throw new Error("PUBLIC_BASE_URL is required");
     if (!sessionSecret || sessionSecret.length < 32) {
       throw new Error("SESSION_SECRET is required and must be at least 32 characters");
     }
     if (!viewerPassword && !allowNoPassword) {
       throw new Error("VIEWER_PASSWORD is required (set ALLOW_NO_PASSWORD=true to bypass)");
     }
     const publicBaseUrl = publicBaseUrlRaw.replace(/\/$/, "");
     const nodeEnv = strEnv(env, "NODE_ENV") ?? "development";
     return {
       publicBaseUrl,
       viewerPassword: viewerPassword ?? "",
       allowNoPassword,
       sessionSecret,
       port: intEnv(env, "PORT", 8080, { min: 1, max: 65535 }),
       host: strEnv(env, "HOST") ?? "0.0.0.0",
       allowedWsOrigins: (strEnv(env, "ALLOWED_WS_ORIGINS") ?? publicBaseUrl)
         .split(",")
         .map((s) => s.trim())
         .filter(Boolean),
       nodeEnv,
       secureCookies: nodeEnv === "production",
     };
   }

   export function loadConfig(env: Env = process.env): AppConfig {
     return {
       media: loadMediaConfig(env),
       station: loadStationConfig(env),
       web: loadWebConfig(env),
     };
   }
   ```

   Note vs the bot: removed `loadBotConfig`, `parseAdminIds`, `DISCORD_*`, `idleTimeoutMs`, `normalizeLoudness`, `sponsorblockRemove`, `clientId/secret/redirectUri`; added `viewerPassword`/`allowNoPassword` and a `StationConfig` reader. No `adminPassword` (single shared password) and no trust-proxy env knob (Fastify `trustProxy` is hardcoded `true` at the app layer, since the app is always behind the user's HTTPS proxy/tunnel).

4. **Run it (expect PASS)** — `npx vitest run src/config.test.ts`
   Expected: all assertions green, including `loadStationConfig({})` having no `idleTimeoutMs` property and the `android_vr,web_embedded,tv` default.

---

### Task 0.6: Port cache + session-store verbatim (PARALLEL)

**Files**

- Create: `src/cache/index.ts` + `src/cache/index.test.ts`
- Create: `src/auth/session-store.ts` + `src/auth/session-store.test.ts`

**Interfaces**

- Consumes: 0.1 (`AudioInfo` from `../types/index.js`).
- Produces: `class AudioCache(dir, maxBytes)` with `init(): Promise<void>`, `has(videoId): boolean`, `get(videoId): string | null`, `getAudio(videoId): AudioInfo | null`, `register(videoId, filePath, audio?)`, `pin(videoId)`, `unpin(videoId)`, `totalBytes(): number`; `class MemorySessionStore(opts?: MemorySessionStoreOpts)` implementing `@fastify/session` `set/get/destroy` + `sweep/size/close` with TTL eviction and an unref'd sweep timer.

**Steps**

1. **Copy both modules + tests VERBATIM** — `~/discord-yt-music-bot/src/cache/index.ts` (+ `index.test.ts`) and `~/discord-yt-music-bot/src/auth/session-store.ts` (+ `session-store.test.ts`). `cache/index.ts` imports only `node:fs`/`node:fs/promises` and `../types/index.js` (`AudioInfo`); `session-store.ts` imports nothing Discord. Confirm: `grep -RniE "discord|guild|oauth" src/cache src/auth/session-store.ts` → no hits.

2. **Run the ported tests (expect PASS — verbatim)** — `npx vitest run src/cache/index.test.ts src/auth/session-store.test.ts`
   Expected: 2 files green (LRU eviction/pin/register-missing-file; session TTL set/get/destroy/sweep).

3. **Add a FAILING anchor test for the cache LRU contract** — append to `src/cache/index.test.ts` (only if the verbatim file lacks this exact case) a test that registering a non-existent file is a no-op:

   ```ts
   it("register() ignores a path that does not exist on disk (no ghost entry)", async () => {
     const cache = new AudioCache("/tmp/lan-jukebox-cache-test-ghost", 1024);
     await cache.init();
     cache.register("ghostvideoid", "/tmp/definitely-not-a-real-file.m4a");
     expect(cache.has("ghostvideoid")).toBe(false);
     expect(cache.get("ghostvideoid")).toBeNull();
   });
   ```

4. **Run it (expect FAIL then PASS)** — `npx vitest run src/cache/index.test.ts`
   Expected: FAIL only if `register` regressed; with the verbatim port it PASSES (the source refuses to register a missing file). Final: green.

---

### Task 0.7: Port web reuse leaves + format (PARALLEL)

**Files**

- Create: `web/index.html`, `web/vite.config.ts`, `web/tsconfig.json`, `web/public/favicon.svg`
- Create: `web/src/main.tsx`, `web/src/vite-env.d.ts`
- Create: `web/src/lib/format.ts` + `web/src/lib/format.test.ts`
- Create: `web/src/components/Thumb.tsx` + `web/src/components/Thumb.test.tsx`
- Create: `web/src/components/Grain.tsx` + `web/src/components/Grain.test.tsx`
- Create: `web/src/components/Picker.tsx` + `web/src/components/Picker.test.tsx`
- Create: `web/src/components/Preparing.tsx` + `web/src/components/Preparing.test.tsx`

**Interfaces**

- Consumes: 0.1 (`web/src/types.ts` — `TrackMeta`, `AudioInfo`, `PreparingState`).
- Produces: `fmtTime(totalSec: number | null): string`, `fmtAudio(audio: AudioInfo | null): string | null`; `Thumb({ url: string | null | undefined; size?: number })`; `Grain()`; `Picker({ candidates: TrackMeta[]; onQueueSelected: (videoIds: string[]) => Promise<boolean> | void; onQueued?: () => void; busy?: boolean })`; `Preparing({ preparing: PreparingState | null })`.

> All component test files need the jsdom environment. Add `// @vitest-environment jsdom` as the FIRST line of each `*.test.tsx`, and `import "@testing-library/jest-dom";` near the top (vitest.config.ts default env is `node`; the per-file pragma flips it).

**Steps**

1. **Write the FAILING format test** — `web/src/lib/format.test.ts`:

   ```ts
   import { describe, it, expect } from "vitest";
   import { fmtTime, fmtAudio } from "./format.js";

   describe("fmtTime", () => {
     it("renders mm:ss under an hour", () => expect(fmtTime(125)).toBe("2:05"));
     it("adds an hours segment at/over an hour", () => expect(fmtTime(3600)).toBe("1:00:00"));
     it("returns the em-dash placeholder for null/non-finite", () => {
       expect(fmtTime(null)).toBe("—:—");
       expect(fmtTime(Number.NaN)).toBe("—:—");
     });
   });

   describe("fmtAudio", () => {
     it("joins codec · kbps · kHz, stripping trailing-zero kHz", () => {
       expect(fmtAudio({ codec: "opus", bitrateKbps: 160, sampleRateHz: 48000 })).toBe(
         "opus · 160 kbps · 48 kHz",
       );
       expect(fmtAudio({ codec: "aac", bitrateKbps: 0, sampleRateHz: 44100 })).toBe(
         "aac · 44.1 kHz",
       );
     });
     it("returns null when given null", () => expect(fmtAudio(null)).toBeNull());
   });
   ```

2. **Run it (expect FAIL)** — `npx vitest run web/src/lib/format.test.ts`
   Expected failure: `Cannot find module './format.js'`.

3. **Copy `format.ts` VERBATIM** — from `~/discord-yt-music-bot/web/src/lib/format.ts` (imports `../types.js` `AudioInfo` — matches the 0.1 web mirror). No changes.

4. **Run it (expect PASS)** — `npx vitest run web/src/lib/format.test.ts` → green.

5. **Copy the four components VERBATIM** — `Thumb.tsx`, `Grain.tsx`, `Picker.tsx`, `Preparing.tsx` from `~/discord-yt-music-bot/web/src/components/`. The ONLY prune: in `Picker.tsx` the `busy?` prop comment says "no voice target" — change that comment to "When true the queue/selection controls are disabled." (the prop + behavior stay identical; the file tree notes Picker is "verbatim"). All four import only `../types.js`, `../lib/format.js`, and sibling components — no Discord refs (`grep -niE "discord|guild|voice" web/src/components/{Thumb,Grain,Picker,Preparing}.tsx` → only the one Picker comment, which step fixes).

6. **Write the FAILING component tests** — author the four `*.test.tsx` files (jsdom pragma + jest-dom):
   - `Thumb.test.tsx`:
     ```tsx
     // @vitest-environment jsdom
     import { describe, it, expect } from "vitest";
     import { render, screen } from "@testing-library/react";
     import "@testing-library/jest-dom";
     import { Thumb } from "./Thumb.js";

     describe("Thumb", () => {
       it("renders an <img> when given a url", () => {
         render(<Thumb url="https://i.ytimg.com/x.jpg" />);
         expect(screen.getByRole("img", { hidden: true })).toHaveAttribute(
           "src",
           "https://i.ytimg.com/x.jpg",
         );
       });
       it("renders the placeholder slot when url is null", () => {
         render(<Thumb url={null} />);
         expect(screen.getByTestId("thumb-placeholder")).toBeInTheDocument();
       });
     });
     ```
   - `Preparing.test.tsx`:
     ```tsx
     // @vitest-environment jsdom
     import { describe, it, expect } from "vitest";
     import { render, screen } from "@testing-library/react";
     import "@testing-library/jest-dom";
     import { Preparing } from "./Preparing.js";

     describe("Preparing", () => {
       it("renders nothing when preparing is null", () => {
         const { container } = render(<Preparing preparing={null} />);
         expect(container).toBeEmptyDOMElement();
       });
       it("shows the downloading verb, title and percent", () => {
         render(
           <Preparing
             preparing={{ videoId: "v", title: "My Mix", phase: "downloading", percent: 42 }}
           />,
         );
         expect(screen.getByRole("status")).toHaveTextContent(/Downloading/i);
         expect(screen.getByRole("status")).toHaveTextContent("My Mix");
         expect(screen.getByRole("status")).toHaveTextContent("42");
       });
     });
     ```
   - `Picker.test.tsx`:
     ```tsx
     // @vitest-environment jsdom
     import { describe, it, expect, vi } from "vitest";
     import { render, screen, fireEvent } from "@testing-library/react";
     import "@testing-library/jest-dom";
     import { Picker } from "./Picker.js";
     import type { TrackMeta } from "../types.js";

     const candidates: TrackMeta[] = [
       {
         videoId: "aaaaaaaaaaa",
         title: "One",
         channel: "C",
         durationSec: 60,
         isLive: false,
         thumbnailUrl: null,
       },
       {
         videoId: "bbbbbbbbbbb",
         title: "Two",
         channel: "C",
         durationSec: 90,
         isLive: false,
         thumbnailUrl: null,
       },
     ];

     describe("Picker", () => {
       it("queues the selected candidate videoIds in display order", async () => {
         const onQueueSelected = vi.fn().mockResolvedValue(true);
         render(<Picker candidates={candidates} onQueueSelected={onQueueSelected} />);
         fireEvent.click(screen.getByText("One"));
         fireEvent.click(screen.getByText("Two"));
         fireEvent.click(screen.getByRole("button", { name: /queue selected/i }));
         expect(onQueueSelected).toHaveBeenCalledWith(["aaaaaaaaaaa", "bbbbbbbbbbb"]);
       });
       it("disables selection when busy", () => {
         const onQueueSelected = vi.fn();
         render(<Picker candidates={candidates} onQueueSelected={onQueueSelected} busy />);
         fireEvent.click(screen.getByText("One"));
         fireEvent.click(screen.getByRole("button", { name: /queue selected/i }));
         expect(onQueueSelected).not.toHaveBeenCalled();
       });
     });
     ```
   - `Grain.test.tsx` (decorative + aria-hidden — assert it mounts inert):
     ```tsx
     // @vitest-environment jsdom
     import { describe, it, expect } from "vitest";
     import { render } from "@testing-library/react";
     import "@testing-library/jest-dom";
     import { Grain } from "./Grain.js";

     describe("Grain", () => {
       it("renders an aria-hidden decorative layer", () => {
         const { container } = render(<Grain />);
         const root = container.firstElementChild as HTMLElement;
         expect(root).toHaveAttribute("aria-hidden", "true");
       });
     });
     ```

7. **Run the component tests (expect PASS)** — `npx vitest run web/src/components/Thumb.test.tsx web/src/components/Preparing.test.tsx web/src/components/Picker.test.tsx web/src/components/Grain.test.tsx`
   Expected: 4 files green. (If `Picker`'s "Queue selected" button label differs in the verbatim source, match the test's `name:` regex to the real button text from `~/discord-yt-music-bot/web/src/components/Picker.tsx` before asserting.)

8. **Author the web scaffolding leaves** (no tests; covered by `tsc -p web/tsconfig.json` + the build in Phase completion):
   - `web/src/main.tsx` — copy VERBATIM from the bot (`createRoot(...).render(<StrictMode><App /></StrictMode>)`, imports `./components/App.js` + `./index.css`). NOTE: `App.tsx` and `index.css` do not exist until Phase 5; `main.tsx` will not typecheck/build until then — that is expected. To keep Phase 0 green, author a minimal placeholder `web/src/components/App.tsx` (`export function App() { return null; }`) and a minimal `web/src/index.css` (`/* design system authored in Phase 5 */`) so `tsc -p web/tsconfig.json` and `vite build` pass now; Phase 5 overwrites both. (Flag these two as placeholders to be replaced, NOT deleted, in Phase 5.)
   - `web/src/vite-env.d.ts` — copy verbatim (`/// <reference types="vite/client" />`).
   - `web/tsconfig.json` — copy VERBATIM from the bot (ESNext/bundler/`react-jsx`/strict/`noUncheckedIndexedAccess`/`verbatimModuleSyntax`/`noEmit`, include `src`).
   - `web/vite.config.ts` — copy from the bot's `web/vite.config.ts`; ensure the dev `server.proxy` forwards `/api`, `/ws`, and `/audio` to the backend (`http://localhost:8080`, `ws: true` for `/ws`), and the react + `@tailwindcss/vite` plugins are enabled.
   - `web/index.html` — copy the SPA shell (`<div id="root">`, the favicon link, the `main.tsx` module script). Reskin (title/fonts) is Phase 5's job; a clean shell now is fine.
   - `web/public/favicon.svg` — copy any placeholder favicon (Phase 5 reskins).

9. **Web typecheck gate** — `npx tsc -p web/tsconfig.json`
   Expected: clean (the web mirror types from 0.1 + the four components + format + the App/index.css placeholders all resolve).

---

### Task 0.8: Phase completion — full verification, adversarial debug, ONE squash commit

**Files**: none new — this task verifies, debugs, and commits the whole phase.

**Steps**

1. **Remove scaffolding scratch files** — delete the Task 0.2 smoke probe + its test so they do not ship:

   ```bash
   rm /home/kasm-user/lan-jukebox/src/scaffold-probe.ts /home/kasm-user/lan-jukebox/src/scaffold.smoke.test.ts
   ```

2. **Full verification (must be all-green before debug)** — run from `/home/kasm-user/lan-jukebox`:

   ```bash
   npm run typecheck && npm run lint && npm run build && npm test
   ```

   Expected output (green):
   - `typecheck`: `tsc -p tsconfig.json --noEmit` clean, `tsc -p tsconfig.test.json --noEmit` clean, `tsc -p web/tsconfig.json` clean — no errors.
   - `lint`: `eslint .` reports 0 problems; `prettier --check .` prints `All matched files use Prettier code style!`.
   - `build`: `vite build web --outDir ../dist/public` emits `dist/public/index.html` + assets; `tsc -p tsconfig.json` emits `dist/**/*.js` for every ported `src/` module with NO errors.
   - `test`: `vitest run` → all Phase-0 files pass. Expected summary roughly `Test Files  ~15 passed`, `Tests  N passed`, `0 failed` (types, util×3, lifecycle, canary, youtube×5, config, cache, session-store, web format + 4 components).
     If ANY step is red, STOP and fix before proceeding — never commit on red.

3. **Adversarial multi-agent debug pass** — invoke the `/debug` (systematic-debugging) workflow across every file changed in this phase. Fan out finder agents over the changed-file set, each on a distinct reliability lens, then adversarially verify each finding before fixing:
   - **Lens A — port fidelity / dead Discord residue:** `grep -RniE "discord|guild|oauth|voice|prism|idle.?timeout|@discordjs" src web` MUST return zero hits (Picker's comment fixed in 0.7; any remaining hit is a confirmed bug).
   - **Lens B — types backbone drift:** diff `src/types/index.ts` domain/DTO/WS exports against `web/src/types.ts` — every shared type present in both with identical fields; the mirror must NOT export the config interfaces or the fastify augmentation.
   - **Lens C — ESM/NodeNext import hygiene:** every backend relative import ends in `.js`; no extensionless relative imports; web imports use `../types.js`/`./*.js`. `verbatimModuleSyntax` honored (type-only imports use `import type`).
   - **Lens D — config invariants (spec §7/§10):** `loadWebConfig` throws on missing `VIEWER_PASSWORD` (unless `ALLOW_NO_PASSWORD=true`), `SESSION_SECRET<32`, missing `PUBLIC_BASE_URL`; `ALLOWED_WS_ORIGINS` defaults to `[publicBaseUrl]`; player-client default is `android_vr,web_embedded,tv` (NOT web/mweb) in BOTH `loadMediaConfig` and `buildClientLadder`. No idle-timeout reader exists.
   - **Lens E — no-discord deps:** `npm ls discord.js @discordjs/voice @discordjs/opus prism-media` shows none present; `package.json` dependencies match the Produces list.
   - **Lens F — test reliability:** no test leaks a real network call (youtube `index.test.ts` injects a fake `RunFn`; canary uses a mocked `resolve`); no unref'd timer keeps vitest alive (session-store sweep `.unref()`'d / `sweepMs:0` in tests); component tests carry the jsdom pragma.
     For each candidate finding, an adversarial verifier agent reproduces it (re-runs the exact failing command / re-reads the exact lines) before it is accepted; discard unconfirmed findings. Fix every CONFIRMED bug, then re-run step 2's full verification until green again.

4. **ONE squash commit for the entire phase** (only after step 2 is green AND step 3 is clean) — this phase produces exactly one commit (overrides the skill's per-task default). On `master` of the new repo:
   ```bash
   cd /home/kasm-user/lan-jukebox && git add -A && git commit -m "$(cat <<'EOF'
   Phase 0: scaffold lan-jukebox + port reuse modules

   Stand up the standalone repo and copy-in-and-prune every framework-agnostic
   reuse module from discord-yt-music-bot so it typechecks + the ported tests pass.

   - types: lock src/types/index.ts backbone + web/src/types.ts mirror (de-Discorded,
     deviceId attribution, fromRadio, station snapshot/registry file shapes, REST/WS DTOs)
   - tooling: package.json (NO discord.js/@discordjs/*/prism-media), tsconfig×3,
     vitest (node + per-file jsdom), eslint flat config, prettier, ignores, lockfile
   - port verbatim: util (logger/mutex/semaphore), lifecycle, canary, youtube
     (url-parser/ytdlp/errors/lyrics/index — android_vr,web_embedded,tv ladder),
     cache (LRU), auth/session-store
   - config: single env reader (loadConfig/Media/Station/Web) — VIEWER_PASSWORD +
     admin + ALLOW_NO_PASSWORD; no Discord/idle env
   - web leaves: format, Thumb/Grain/Picker/Preparing + tests, main/vite/tsconfig
     (App.tsx + index.css are Phase-5 placeholders)

   Verified: typecheck + lint + build + test all green; adversarial debug pass clean.

   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   EOF
   )"
   ```
   Do NOT push (per user workflow, push only on explicit request). Confirm with `git log --oneline -1` that exactly one Phase-0 commit exists.

---

## Phase 1:Station orchestrator & radio engine — Station orchestrator & radio engine

**Goal:** De-guild + de-Discord the queue and orchestrator into a single never-stopping `StationController` whose sink is a browser-player adapter (`BrowserPlayerSink`), then build the `RadioEngine` on top of `YouTubeService.related/artistTracks` with seed tracking, de-dup vs recent history, keep-ahead, cold-start-waits-for-seed, and NO idle timeout — plus the de-guilded settings/snapshot.

### Parallelization

- **Sequential (shared hub — one editor at a time):** `src/orchestrator/index.ts` (`StationController`). Task 1.5 builds it; Task 1.6 (`RadioEngine`) and Task 1.7 (snapshot) only _consume_ its public surface and live in disjoint files, so they may proceed once 1.5's public API is frozen.
- **Parallel-safe (disjoint files, may run concurrently after types are frozen):** Task 1.1 `src/queue/index.ts`, Task 1.2 `src/orchestrator/settings.ts`, Task 1.4 `src/orchestrator/browser-player-sink.ts`. (Task 1.3 is REMOVED — saved playlists cut from scope.) Task 1.5 depends on all of 1.1, 1.2, 1.4. Task 1.6 `src/radio/index.ts` is fully disjoint from the controller file. Task 1.7 `src/orchestrator/snapshot.ts` is disjoint from the controller file.
- **Dependency order:** 1.1 → (1.2, 1.4 in parallel) → 1.5 → (1.6, 1.7 in parallel) → Phase completion.

All backend code is ESM/NodeNext: every relative import ends in `.js`. Shared types are imported from `../types/index.js`. The test runner is Vitest (node env). Run commands from the repo root `/home/kasm-user/lan-jukebox`.

---

### Task 1.1: De-guild the pure queue

**Files**

- Create: `src/queue/index.ts`
- Test: `src/queue/index.test.ts`

**Interfaces**

- Consumes (from `src/types/index.ts`): `QueueItem` (now with `fromRadio: boolean`), `QueueSnapshot`, `Requester`, `TrackMeta`.
- Produces:
  ```ts
  export interface QueueOptions {
    historyMax?: number;
    idFactory?: () => string;
    now?: () => number;
  }
  export class Queue extends EventEmitter {
    constructor(opts?: QueueOptions);
    get current(): QueueItem | null;
    snapshot(): QueueSnapshot;
    add(meta: TrackMeta, requester: Requester, fromRadio?: boolean): Promise<QueueItem>;
    advance(): Promise<QueueItem | null>;
    discardCurrent(): Promise<QueueItem | null>;
    remove(itemId: string): Promise<boolean>;
    reorder(itemId: string, toIndex: number): Promise<boolean>;
    shuffle(rng?: () => number): Promise<void>;
    requeueHistory(): Promise<number>;
    clear(): Promise<void>;
    // events: 'changed'(QueueSnapshot), 'prefetch'(videoId: string | null)
  }
  ```
  Notes vs the bot's `GuildQueue`: renamed `GuildQueue → Queue`, `GuildQueueOptions → QueueOptions`; `add()` gains a third `fromRadio = false` param that sets `item.fromRadio`; every constructed `QueueItem` now also sets `audio: null` and `fromRadio`. `QueueSnapshot` is imported from `../types/index.js` (no longer re-declared locally).

**Steps**

1. Write the failing test file `src/queue/index.test.ts`. Real code:

   ```ts
   import { describe, it, expect, vi } from "vitest";
   import { Queue } from "./index.js";
   import type { Requester, TrackMeta } from "../types/index.js";

   const requester: Requester = { deviceId: "d1", displayName: "u", source: "user" };
   function meta(videoId: string): TrackMeta {
     return {
       videoId,
       title: videoId,
       channel: "c",
       durationSec: 100,
       isLive: false,
       thumbnailUrl: null,
     };
   }
   function newQueue() {
     let n = 0;
     return new Queue({ historyMax: 2, idFactory: () => `id${++n}`, now: () => 0 });
   }

   describe("Queue", () => {
     it("adds to upcoming, defaults fromRadio=false + audio=null, emits changed + prefetch", async () => {
       const q = newQueue();
       const changed = vi.fn();
       const prefetch = vi.fn();
       q.on("changed", changed);
       q.on("prefetch", prefetch);
       const item = await q.add(meta("aaaaaaaaaaa"), requester);
       expect(item.id).toBe("id1");
       expect(item.fromRadio).toBe(false);
       expect(item.audio).toBeNull();
       expect(item.requester.source).toBe("user");
       expect(q.snapshot().upcoming.map((i) => i.id)).toEqual(["id1"]);
       expect(q.current).toBeNull();
       expect(changed).toHaveBeenCalledTimes(1);
       expect(prefetch).toHaveBeenLastCalledWith("aaaaaaaaaaa");
     });

     it("add(meta, requester, true) tags the item fromRadio", async () => {
       const q = newQueue();
       const item = await q.add(meta("bbbbbbbbbbb"), requester, true);
       expect(item.fromRadio).toBe(true);
     });

     it("advance() promotes the head and archives the old current to history", async () => {
       const q = newQueue();
       await q.add(meta("aaaaaaaaaaa"), requester);
       await q.add(meta("bbbbbbbbbbb"), requester);
       expect((await q.advance())?.meta.videoId).toBe("aaaaaaaaaaa");
       expect((await q.advance())?.meta.videoId).toBe("bbbbbbbbbbb");
       expect(q.snapshot().history.map((i) => i.meta.videoId)).toEqual(["aaaaaaaaaaa"]);
       expect(await q.advance()).toBeNull();
       expect(q.current).toBeNull();
     });

     it("discardCurrent() promotes the head WITHOUT archiving the dropped track", async () => {
       const q = newQueue();
       await q.add(meta("aaaaaaaaaaa"), requester);
       await q.add(meta("bbbbbbbbbbb"), requester);
       await q.advance(); // current = aaa
       const next = await q.discardCurrent();
       expect(next?.meta.videoId).toBe("bbbbbbbbbbb");
       expect(q.snapshot().history).toEqual([]);
     });

     it("remove() drops an upcoming item; returns false for an unknown id", async () => {
       const q = newQueue();
       const a = await q.add(meta("aaaaaaaaaaa"), requester);
       await q.add(meta("bbbbbbbbbbb"), requester);
       expect(await q.remove(a.id)).toBe(true);
       expect(q.snapshot().upcoming.map((i) => i.meta.videoId)).toEqual(["bbbbbbbbbbb"]);
       expect(await q.remove("nope")).toBe(false);
     });

     it("reorder() moves an item and clamps toIndex", async () => {
       const q = newQueue();
       const a = await q.add(meta("aaaaaaaaaaa"), requester);
       await q.add(meta("bbbbbbbbbbb"), requester);
       await q.add(meta("ccccccccccc"), requester);
       expect(await q.reorder(a.id, 99)).toBe(true);
       expect(q.snapshot().upcoming.map((i) => i.meta.videoId)).toEqual([
         "bbbbbbbbbbb",
         "ccccccccccc",
         "aaaaaaaaaaa",
       ]);
     });

     it("shuffle(rng) permutes upcoming deterministically and emits changed", async () => {
       const q = newQueue();
       await q.add(meta("aaaaaaaaaaa"), requester);
       await q.add(meta("bbbbbbbbbbb"), requester);
       const changed = vi.fn();
       q.on("changed", changed);
       await q.shuffle(() => 0); // Fisher-Yates with rng()=0 swaps i with 0
       expect(changed).toHaveBeenCalled();
       expect(q.snapshot().upcoming).toHaveLength(2);
     });

     it("requeueHistory() recycles the full played set + current and clears history", async () => {
       const q = newQueue();
       await q.add(meta("aaaaaaaaaaa"), requester);
       await q.add(meta("bbbbbbbbbbb"), requester);
       await q.advance(); // current aaa
       await q.advance(); // current bbb, history [aaa]
       const n = await q.requeueHistory();
       expect(n).toBe(2);
       expect(q.snapshot().history).toEqual([]);
       expect(q.snapshot().upcoming.map((i) => i.meta.videoId)).toEqual([
         "aaaaaaaaaaa",
         "bbbbbbbbbbb",
       ]);
       expect(q.current).toBeNull();
     });

     it("clear() drops current + upcoming but keeps display history", async () => {
       const q = newQueue();
       await q.add(meta("aaaaaaaaaaa"), requester);
       await q.advance();
       await q.add(meta("bbbbbbbbbbb"), requester);
       await q.clear();
       expect(q.current).toBeNull();
       expect(q.snapshot().upcoming).toEqual([]);
     });
   });
   ```

2. Run the test (expected FAIL):

   ```
   npx vitest run src/queue/index.test.ts
   ```

   Expected failure: `Error: Failed to load url ./index.js` / `Cannot find module './index.js'` (the implementation does not exist yet).

3. Write the minimal implementation `src/queue/index.ts`. Real code (de-guilded copy of the bot's `GuildQueue`):

   ```ts
   import { EventEmitter } from "node:events";
   import type { QueueItem, QueueSnapshot, Requester, TrackMeta } from "../types/index.js";
   import { Mutex } from "../util/mutex.js";

   export interface QueueOptions {
     historyMax?: number;
     idFactory?: () => string;
     now?: () => number;
   }

   export class Queue extends EventEmitter {
     private _current: QueueItem | null = null;
     private _upcoming: QueueItem[] = [];
     private _history: QueueItem[] = [];
     // UNCAPPED record of every track that has cleanly advanced this cycle, kept separately
     // from the bounded `_history` ring so repeat="all" can re-cycle the FULL set even when it
     // exceeds historyMax. Reset on requeueHistory() / clear().
     private _played: QueueItem[] = [];
     private readonly mutex = new Mutex();
     private readonly historyMax: number;
     private readonly idFactory: () => string;
     private readonly now: () => number;

     constructor(opts: QueueOptions = {}) {
       super();
       this.historyMax = opts.historyMax ?? 100;
       this.idFactory = opts.idFactory ?? (() => crypto.randomUUID());
       this.now = opts.now ?? (() => Date.now());
     }

     get current(): QueueItem | null {
       return this._current;
     }

     snapshot(): QueueSnapshot {
       const clone = (i: QueueItem) => ({ ...i });
       return {
         current: this._current ? clone(this._current) : null,
         upcoming: this._upcoming.map(clone),
         history: this._history.map(clone),
       };
     }

     add(meta: TrackMeta, requester: Requester, fromRadio = false): Promise<QueueItem> {
       return this.mutex.runExclusive(() => {
         const item: QueueItem = {
           id: this.idFactory(),
           meta,
           requester,
           addedAt: this.now(),
           audio: null,
           fromRadio,
         };
         this._upcoming.push(item);
         this.emitChange();
         return item;
       });
     }

     advance(): Promise<QueueItem | null> {
       return this.mutex.runExclusive(() => {
         if (this._current) {
           this._played.push(this._current);
           this._history.push(this._current);
           if (this._history.length > this.historyMax) {
             this._history.splice(0, this._history.length - this.historyMax);
           }
         }
         this._current = this._upcoming.shift() ?? null;
         this.emitChange();
         return this._current;
       });
     }

     discardCurrent(): Promise<QueueItem | null> {
       return this.mutex.runExclusive(() => {
         this._current = this._upcoming.shift() ?? null;
         this.emitChange();
         return this._current;
       });
     }

     remove(itemId: string): Promise<boolean> {
       return this.mutex.runExclusive(() => {
         const idx = this._upcoming.findIndex((i) => i.id === itemId);
         if (idx === -1) return false;
         this._upcoming.splice(idx, 1);
         this.emitChange();
         return true;
       });
     }

     reorder(itemId: string, toIndex: number): Promise<boolean> {
       return this.mutex.runExclusive(() => {
         const from = this._upcoming.findIndex((i) => i.id === itemId);
         if (from === -1) return false;
         const clamped = Math.max(0, Math.min(toIndex, this._upcoming.length - 1));
         const [item] = this._upcoming.splice(from, 1);
         if (item) this._upcoming.splice(clamped, 0, item);
         this.emitChange();
         return true;
       });
     }

     shuffle(rng: () => number = Math.random): Promise<void> {
       return this.mutex.runExclusive(() => {
         const u = this._upcoming;
         for (let i = u.length - 1; i > 0; i--) {
           const j = Math.floor(rng() * (i + 1));
           const tmp = u[i]!;
           u[i] = u[j]!;
           u[j] = tmp;
         }
         this.emitChange();
       });
     }

     requeueHistory(): Promise<number> {
       return this.mutex.runExclusive(() => {
         const recycled = [...this._played];
         if (this._current) recycled.push(this._current);
         if (recycled.length === 0) return 0;
         this._played = [];
         this._history = [];
         this._current = null;
         this._upcoming.push(...recycled);
         this.emitChange();
         return recycled.length;
       });
     }

     clear(): Promise<void> {
       return this.mutex.runExclusive(() => {
         this._current = null;
         this._upcoming = [];
         this._played = [];
         this.emitChange();
       });
     }

     private emitChange(): void {
       this.emit("changed", this.snapshot());
       this.emit("prefetch", this._upcoming[0]?.meta?.videoId ?? null);
     }
   }
   ```

4. Run the test (expected PASS):
   ```
   npx vitest run src/queue/index.test.ts
   ```
   Expected: `Test Files  1 passed (1)` / `Tests  9 passed (9)`.

---

### Task 1.2: Prune settings to surviving fields

**Files**

- Create: `src/orchestrator/settings.ts`
- Test: `src/orchestrator/settings.test.ts`

**Interfaces**

- Consumes (from `src/types/index.ts`): `StationSettings`, `DEFAULT_SETTINGS`, `RepeatMode`, `AutoplaySource`, `VOLUME_MAX`, `MAX_TRACK_DURATION_CEILING_SEC`.
- Produces:
  ```ts
  export function applySettingsPatch(
    base: StationSettings,
    patch: Partial<Record<keyof StationSettings, unknown>> | null | undefined,
  ): StationSettings;
  ```
  Surviving fields only: `repeat`, `autoplay`, `autoplaySource`, `volume`, `maxTrackDurationSec`. Removed vs the bot: `idleTimeoutSec`, `crossfadeSec`, `normalizeLoudness`, `fx`, `commandChannelId`. `StationSettings`/`DEFAULT_SETTINGS`/`RepeatMode`/`AutoplaySource`/`VOLUME_MAX`/`MAX_TRACK_DURATION_CEILING_SEC` are imported from `../types/index.js` (the backbone), NOT re-declared here.

**Steps**

1. Write the failing test `src/orchestrator/settings.test.ts`:

   ```ts
   import { describe, it, expect } from "vitest";
   import { applySettingsPatch } from "./settings.js";
   import { DEFAULT_SETTINGS, VOLUME_MAX, MAX_TRACK_DURATION_CEILING_SEC } from "../types/index.js";
   import type { StationSettings } from "../types/index.js";

   const base: StationSettings = { ...DEFAULT_SETTINGS };

   describe("applySettingsPatch", () => {
     it("returns base unchanged for a null/empty patch", () => {
       expect(applySettingsPatch(base, null)).toEqual(base);
       expect(applySettingsPatch(base, {})).toEqual(base);
     });

     it("accepts valid repeat / autoplaySource enums and rejects bad ones", () => {
       expect(applySettingsPatch(base, { repeat: "all" }).repeat).toBe("all");
       expect(applySettingsPatch(base, { repeat: "bogus" }).repeat).toBe(base.repeat);
       expect(applySettingsPatch(base, { autoplaySource: "artist" }).autoplaySource).toBe("artist");
       expect(applySettingsPatch(base, { autoplaySource: "x" }).autoplaySource).toBe(
         base.autoplaySource,
       );
     });

     it("clamps + rounds volume to 0..VOLUME_MAX and rejects booleans", () => {
       expect(applySettingsPatch(base, { volume: 150 }).volume).toBe(150);
       expect(applySettingsPatch(base, { volume: 999 }).volume).toBe(VOLUME_MAX);
       expect(applySettingsPatch(base, { volume: -5 }).volume).toBe(0);
       expect(applySettingsPatch(base, { volume: 80.6 }).volume).toBe(81);
       expect(applySettingsPatch(base, { volume: true }).volume).toBe(base.volume);
     });

     it("clamps maxTrackDurationSec to 0..ceiling and treats 0 as no-limit", () => {
       expect(applySettingsPatch(base, { maxTrackDurationSec: 600 }).maxTrackDurationSec).toBe(600);
       expect(applySettingsPatch(base, { maxTrackDurationSec: 0 }).maxTrackDurationSec).toBe(0);
       expect(
         applySettingsPatch(base, { maxTrackDurationSec: MAX_TRACK_DURATION_CEILING_SEC + 100 })
           .maxTrackDurationSec,
       ).toBe(MAX_TRACK_DURATION_CEILING_SEC);
     });

     it("accepts a boolean autoplay and rejects a non-boolean", () => {
       expect(applySettingsPatch(base, { autoplay: false }).autoplay).toBe(false);
       expect(applySettingsPatch(base, { autoplay: "yes" }).autoplay).toBe(base.autoplay);
     });

     it("ignores removed fields (idle/crossfade/fx/commandChannel)", () => {
       const out = applySettingsPatch(base, {
         idleTimeoutSec: 99,
         crossfadeSec: 5,
         fx: "bassboost",
         commandChannelId: "c",
       } as Partial<Record<keyof StationSettings, unknown>>);
       expect(out).toEqual(base);
       expect(Object.keys(out).sort()).toEqual([
         "autoplay",
         "autoplaySource",
         "maxTrackDurationSec",
         "repeat",
         "volume",
       ]);
     });
   });
   ```

2. Run the test (expected FAIL):

   ```
   npx vitest run src/orchestrator/settings.test.ts
   ```

   Expected failure: `Cannot find module './settings.js'`.

3. Write the minimal implementation `src/orchestrator/settings.ts`:

   ```ts
   import type { AutoplaySource, RepeatMode, StationSettings } from "../types/index.js";
   import { VOLUME_MAX, MAX_TRACK_DURATION_CEILING_SEC } from "../types/index.js";

   const REPEAT_MODES: ReadonlySet<RepeatMode> = new Set<RepeatMode>(["off", "one", "all"]);
   const AUTOPLAY_SOURCES: ReadonlySet<AutoplaySource> = new Set<AutoplaySource>([
     "radio",
     "artist",
   ]);

   function clampInt(value: unknown, min: number, max: number, fallback: number): number {
     // Booleans coerce via Number() to 0/1 and would otherwise slip past as "valid" numbers —
     // e.g. {volume:false} silently mutes. Treat them as invalid (fall back).
     if (typeof value === "boolean") return fallback;
     const n = typeof value === "number" ? value : Number(value);
     if (!Number.isFinite(n)) return fallback;
     return Math.max(min, Math.min(max, Math.round(n)));
   }

   /**
    * Merge an untrusted partial patch onto a base settings object, clamping/validating every
    * surviving field. Unknown or out-of-range values fall back to the current value. Removed
    * bot fields (idleTimeoutSec/crossfadeSec/normalizeLoudness/fx/commandChannelId) are ignored.
    */
   export function applySettingsPatch(
     base: StationSettings,
     patch: Partial<Record<keyof StationSettings, unknown>> | null | undefined,
   ): StationSettings {
     const p = patch ?? {};
     const repeat =
       typeof p.repeat === "string" && REPEAT_MODES.has(p.repeat as RepeatMode)
         ? (p.repeat as RepeatMode)
         : base.repeat;
     const autoplaySource =
       typeof p.autoplaySource === "string" &&
       AUTOPLAY_SOURCES.has(p.autoplaySource as AutoplaySource)
         ? (p.autoplaySource as AutoplaySource)
         : base.autoplaySource;
     return {
       repeat,
       autoplay: typeof p.autoplay === "boolean" ? p.autoplay : base.autoplay,
       autoplaySource,
       volume: p.volume == null ? base.volume : clampInt(p.volume, 0, VOLUME_MAX, base.volume),
       maxTrackDurationSec:
         p.maxTrackDurationSec == null
           ? base.maxTrackDurationSec
           : clampInt(
               p.maxTrackDurationSec,
               0,
               MAX_TRACK_DURATION_CEILING_SEC,
               base.maxTrackDurationSec,
             ),
     };
   }
   ```

4. Run the test (expected PASS):
   ```
   npx vitest run src/orchestrator/settings.test.ts
   ```
   Expected: `Tests  6 passed (6)`.

---

### Task 1.3: REMOVED — saved playlists cut from scope (no work)

---

### Task 1.4: Browser-player sink adapter (VoiceSession contract over WS)

**Files**

- Create: `src/orchestrator/browser-player-sink.ts`
- Test: `src/orchestrator/browser-player-sink.test.ts`

**Interfaces**

- Consumes (from `src/types/index.ts`): `ServerPlayerMessage`.
- Produces:
  ```ts
  export class BrowserPlayerSink extends EventEmitter {
    play(opts: { audioUrl: string; startMs: number }): void; // sends {type:"load",...} + {type:"play"}
    pause(): void; // sends {type:"pause"}
    resume(): void; // sends {type:"play"}
    skip(): void; // sends {type:"pause"} (advance is driven by controller, not the sink)
    seek(ms: number): void; // sends {type:"seek",ms}
    setVolume(pct: number): void; // sends {type:"setVolume",pct}
    stop(): void; // sends {type:"pause"} (NO teardown — station never ends)
    relinquish(): void; // sends {type:"pause"} — tells THIS browser it is no longer the speaker (PlayerRegistry calls it on the previous sink, §3.2)
    destroy(): void; // detaches send; clears listeners
    setSend(send: ((m: ServerPlayerMessage) => void) | null): void;
    onTrackEnded(): void; // called by ws.ts on client {type:"trackEnded"} → emits 'trackEnd'
    onPlaybackError(message: string): void; // called by ws.ts on client {type:"playbackError"} → emits 'error'
    // events: 'trackEnd'() , 'error'(message: string). NO idle timer / 'idle' event.
  }
  ```
  This is the `VoiceSession`-shaped sink the controller talks to. Instead of an `@discordjs/voice` `AudioPlayer`, it serializes `ServerPlayerMessage`s through an injectable `send` callback (set by `ws.ts` when a Player connects, `null` when it disconnects). End-of-track and playback-error signals arrive _from the client_ (via `onTrackEnded`/`onPlaybackError`) and are re-emitted as `'trackEnd'`/`'error'` for the controller's advance guard — exactly mirroring `VoiceSession`'s `trackEnd`/`error` events. There is deliberately NO idle timer and NO `'idle'` event (spec §3/§4: never stops).

**Steps**

1. Write the failing test `src/orchestrator/browser-player-sink.test.ts`:

   ```ts
   import { describe, it, expect, vi } from "vitest";
   import { BrowserPlayerSink } from "./browser-player-sink.js";
   import type { ServerPlayerMessage } from "../types/index.js";

   function sinkWithSpy() {
     const sent: ServerPlayerMessage[] = [];
     const sink = new BrowserPlayerSink();
     sink.setSend((m) => sent.push(m));
     return { sink, sent };
   }

   describe("BrowserPlayerSink", () => {
     it("play() sends load then play", () => {
       const { sink, sent } = sinkWithSpy();
       sink.play({ audioUrl: "/audio/x", startMs: 5000 });
       expect(sent).toEqual([
         { type: "load", audioUrl: "/audio/x", startMs: 5000 },
         { type: "play" },
       ]);
     });

     it("pause/resume/seek/setVolume serialize the right messages", () => {
       const { sink, sent } = sinkWithSpy();
       sink.pause();
       sink.resume();
       sink.seek(1234);
       sink.setVolume(80);
       expect(sent).toEqual([
         { type: "pause" },
         { type: "play" },
         { type: "seek", ms: 1234 },
         { type: "setVolume", pct: 80 },
       ]);
     });

     it("skip(), stop() and relinquish() send pause (controller drives the advance, sink never tears down)", () => {
       const { sink, sent } = sinkWithSpy();
       sink.skip();
       sink.stop();
       sink.relinquish();
       expect(sent).toEqual([{ type: "pause" }, { type: "pause" }, { type: "pause" }]);
     });

     it("onTrackEnded() emits 'trackEnd'; onPlaybackError() emits 'error' with the message", () => {
       const sink = new BrowserPlayerSink();
       const ended = vi.fn();
       const err = vi.fn();
       sink.on("trackEnd", ended);
       sink.on("error", err);
       sink.onTrackEnded();
       sink.onPlaybackError("decode failed");
       expect(ended).toHaveBeenCalledTimes(1);
       expect(err).toHaveBeenCalledWith("decode failed");
     });

     it("no send attached → commands are silently dropped (no throw)", () => {
       const sink = new BrowserPlayerSink();
       expect(() => sink.play({ audioUrl: "/audio/x", startMs: 0 })).not.toThrow();
     });

     it("setSend(null) detaches; destroy() detaches and removes listeners", () => {
       const { sink, sent } = sinkWithSpy();
       sink.setSend(null);
       sink.play({ audioUrl: "/audio/y", startMs: 0 });
       expect(sent).toEqual([]);
       const ended = vi.fn();
       sink.on("trackEnd", ended);
       sink.destroy();
       sink.onTrackEnded();
       expect(ended).not.toHaveBeenCalled();
     });

     it("exposes NO idle behavior (no 'idle' event ever fires)", () => {
       const { sink } = sinkWithSpy();
       const idle = vi.fn();
       sink.on("idle", idle);
       sink.play({ audioUrl: "/audio/z", startMs: 0 });
       sink.skip();
       sink.stop();
       expect(idle).not.toHaveBeenCalled();
     });
   });
   ```

2. Run the test (expected FAIL):

   ```
   npx vitest run src/orchestrator/browser-player-sink.test.ts
   ```

   Expected failure: `Cannot find module './browser-player-sink.js'`.

3. Write the minimal implementation `src/orchestrator/browser-player-sink.ts`:

   ```ts
   import { EventEmitter } from "node:events";
   import type { ServerPlayerMessage } from "../types/index.js";

   /**
    * A VoiceSession-shaped audio sink that drives a remote browser <audio> over WebSocket.
    * The controller calls play/pause/resume/seek/setVolume/skip/stop exactly as it called a
    * VoiceSession; this serializes them into ServerPlayerMessages and forwards them through the
    * injected `send` callback (set by ws.ts when a Player attaches, null when it detaches).
    *
    * End-of-track and playback-error come FROM the client (ws.ts calls onTrackEnded /
    * onPlaybackError), and are re-emitted as 'trackEnd' / 'error' for the controller's
    * advance-exactly-once guard. There is deliberately NO idle timer and NO 'idle' event:
    * the station never stops (spec §3/§4).
    */
   export class BrowserPlayerSink extends EventEmitter {
     private send: ((m: ServerPlayerMessage) => void) | null = null;
     private destroyed = false;

     setSend(send: ((m: ServerPlayerMessage) => void) | null): void {
       this.send = send;
     }

     private emitMsg(m: ServerPlayerMessage): void {
       if (this.destroyed) return;
       this.send?.(m);
     }

     play(opts: { audioUrl: string; startMs: number }): void {
       this.emitMsg({ type: "load", audioUrl: opts.audioUrl, startMs: opts.startMs });
       this.emitMsg({ type: "play" });
     }
     pause(): void {
       this.emitMsg({ type: "pause" });
     }
     resume(): void {
       this.emitMsg({ type: "play" });
     }
     // Advancing to the next track is the controller's job (it runs its advance guard on the
     // resulting 'trackEnd'); the sink only tells the browser to stop emitting audio.
     skip(): void {
       this.emitMsg({ type: "pause" });
     }
     seek(ms: number): void {
       this.emitMsg({ type: "seek", ms });
     }
     setVolume(pct: number): void {
       this.emitMsg({ type: "setVolume", pct });
     }
     // NO teardown — the station never ends. stop() just halts the browser audio.
     stop(): void {
       this.emitMsg({ type: "pause" });
     }
     // PlayerRegistry (§3.2) calls this on the PREVIOUS speaker's sink when a new device claims the
     // Player: tell that browser to halt its <audio> so two devices never play at once. No teardown.
     relinquish(): void {
       this.emitMsg({ type: "pause" });
     }

     /** ws.ts → client {type:"trackEnded"}: the browser finished the track. */
     onTrackEnded(): void {
       if (this.destroyed) return;
       this.emit("trackEnd");
     }
     /** ws.ts → client {type:"playbackError",message}: the browser failed to play the track. */
     onPlaybackError(message: string): void {
       if (this.destroyed) return;
       this.emit("error", message);
     }

     destroy(): void {
       if (this.destroyed) return;
       this.destroyed = true;
       this.send = null;
       this.removeAllListeners();
     }
   }
   ```

4. Run the test (expected PASS):
   ```
   npx vitest run src/orchestrator/browser-player-sink.test.ts
   ```
   Expected: `Tests  7 passed (7)`.

---

### Task 1.5: StationController (de-guild / de-Discord / no-timeout)

**Files**

- Create: `src/orchestrator/index.ts`
- Test: `src/orchestrator/index.test.ts`

**Interfaces**

- Consumes: 1.1 `Queue`; 1.2 `applySettingsPatch`; 1.4 `BrowserPlayerSink`; (Phase 0) `YouTubeService.download` from `../youtube/index.js`; (Phase 0) `AudioCache` from `../cache/index.js`; (Phase 0) `Mutex`/`Semaphore` from `../util/`; (types) `StationSnapshot`, `CurrentItem`, `PreparingState`, `StationSnapshotFile`, `StationSettings`, `QueueItem`, `TrackMeta`, `Requester`, `AUTOPLAY_REQUESTER`, `DEFAULT_SETTINGS`.
- Produces:

  ```ts
  export interface StationControllerDeps {
    queue?: Queue;
    settings?: Partial<StationSettings>;
    download: (
      videoId: string,
      opts?: { onProgress?: (pct: number) => void },
    ) => Promise<{ path: string }>;
    pin?: (videoId: string, path: string) => void; // AudioCache pin/unpin (optional in tests)
    unpin?: (videoId: string) => void;
    prefetch?: (videoId: string) => Promise<void>; // best-effort prefetch of the head of upcoming
    now?: () => number;
    onSettingsChanged?: (s: StationSettings) => void; // host persistence hook
  }
  export class StationController extends EventEmitter {
    constructor(deps: StationControllerDeps);
    readonly queue: Queue;
    get isPaused(): boolean;
    get settings(): StationSettings;
    get seed(): TrackMeta | null;
    get activeSink(): boolean;
    snapshot(): StationSnapshot; // server fills activePlayerPresent/Label + isThisDeviceSpeaker
    enqueue(meta: TrackMeta, requester: Requester): Promise<QueueItem>; // sets seed when requester.source==='user'
    skip(): void;
    pause(): void;
    resume(): void;
    seek(ms: number): Promise<boolean>;
    remove(itemId: string): Promise<boolean>;
    reorder(itemId: string, toIndex: number): Promise<boolean>;
    jump(itemId: string): Promise<boolean>;
    shuffle(rng?: () => number): Promise<void>;
    clear(): Promise<void>;
    updateSettings(patch: Partial<Record<keyof StationSettings, unknown>>): StationSettings;
    setVolume(pct: number): StationSettings;
    attachSink(sink: BrowserPlayerSink): void; // wires trackEnd/error → advance guard; loads current at position
    detachSink(): void; // pauses; preserves seed/current/position
    reportPosition(ms: number): void; // Player <audio> telemetry → re-anchor position bookkeeping
    setRadioContinuation(fn: (() => Promise<TrackMeta | null>) | null): void; // 1.6 wiring
    setRadioTopUp(fn: (() => void) | null): void; // 1.6 proactive top-up on queue 'changed'
    setUpcomingRadio(items: QueueItem[]): void; // 1.6 pre-resolved radio buffer for the UI preview
    restore(file: StationSnapshotFile): Promise<void>;
    // events: 'changed'
  }
  ```

  Key behaviors (de-guilded/de-Discorded/no-timeout): single queue (not a guild map); the sink is a `BrowserPlayerSink` not a `VoiceSession`; `enqueue` sets `this._seed = meta` only when `requester.source === "user"`; advance is driven exactly-once off the sink's `'trackEnd'`/`'error'` via a `playGeneration` guard; **there is NO idle timer and NO stop/teardown path** — when the queue drains the controller asks the injected `radioContinuation` (a callback set by `RadioEngine` in 1.6, or a no-op) for the next track and, if none is available, holds in a paused state with `current` preserved. `audioUrl` for the sink is `/audio/${videoId}`.

  > **Decoupling note for 1.6:** the controller exposes a settable continuation hook so the radio engine can plug in without a circular import:
  >
  > ```ts
  > setRadioContinuation(fn: (() => Promise<TrackMeta | null>) | null): void; // returns next radio track, or null
  > setRadioTopUp(fn: (() => void) | null): void; // fire-and-forget proactive top-up on queue 'changed'
  > ```
  >
  > The default is `null` (no radio) so the controller is fully testable in isolation with a `FakeBrowserPlayer` sink.

**Steps**

1. Write the first failing test `src/orchestrator/index.test.ts` (core/seek/preparing + no-timeout + sink). Real code (abbreviated to the load-bearing cases; FakeBrowserPlayer captures the sink wiring):

   ```ts
   import { describe, it, expect, vi } from "vitest";
   import { StationController } from "./index.js";
   import { BrowserPlayerSink } from "./browser-player-sink.js";
   import type { Requester, TrackMeta, ServerPlayerMessage } from "../types/index.js";

   const user: Requester = { deviceId: "d1", displayName: "u", source: "user" };
   function meta(id: string, durationSec = 100): TrackMeta {
     return {
       videoId: id,
       title: id,
       channel: "c",
       durationSec,
       isLive: false,
       thumbnailUrl: null,
     };
   }
   function fakeSink() {
     const sent: ServerPlayerMessage[] = [];
     const sink = new BrowserPlayerSink();
     sink.setSend((m) => sent.push(m));
     return { sink, sent };
   }
   function controller() {
     const download = vi.fn(async (id: string) => ({ path: `/cache/${id}.m4a` }));
     const c = new StationController({ download, now: () => 1_000 });
     return { c, download };
   }

   describe("StationController core", () => {
     it("enqueue from a user sets the seed; autoplay requester does NOT", async () => {
       const { c } = controller();
       await c.enqueue(meta("aaaaaaaaaaa"), user);
       expect(c.seed?.videoId).toBe("aaaaaaaaaaa");
       await c.enqueue(meta("bbbbbbbbbbb"), {
         deviceId: "autoplay",
         displayName: "Autoplay",
         source: "autoplay",
       });
       expect(c.seed?.videoId).toBe("aaaaaaaaaaa"); // unchanged by radio adds
     });

     it("attaching a sink loads + plays the head track (download then load+play)", async () => {
       const { c, download } = controller();
       const { sink, sent } = fakeSink();
       await c.enqueue(meta("aaaaaaaaaaa"), user);
       c.attachSink(sink);
       await vi.waitFor(() =>
         expect(download).toHaveBeenCalledWith("aaaaaaaaaaa", expect.anything()),
       );
       await vi.waitFor(() =>
         expect(sent.some((m) => m.type === "load" && m.audioUrl === "/audio/aaaaaaaaaaa")).toBe(
           true,
         ),
       );
       expect(sent.some((m) => m.type === "play")).toBe(true);
       expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
     });

     it("sink 'trackEnd' advances exactly once (an error+trackEnd pair does not double-skip)", async () => {
       const { c } = controller();
       const { sink } = fakeSink();
       await c.enqueue(meta("aaaaaaaaaaa"), user);
       await c.enqueue(meta("bbbbbbbbbbb"), user);
       c.attachSink(sink);
       await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
       sink.onPlaybackError("boom");
       sink.onTrackEnded(); // same generation — must be ignored
       await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("bbbbbbbbbbb"));
       expect(c.snapshot().upcoming).toHaveLength(0);
     });

     it("queue-dry with NO radio continuation holds paused, current preserved (no stop/teardown)", async () => {
       const { c } = controller();
       const { sink } = fakeSink();
       await c.enqueue(meta("aaaaaaaaaaa"), user);
       c.attachSink(sink);
       await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
       sink.onTrackEnded(); // no upcoming, no radio
       await vi.waitFor(() => expect(c.isPaused).toBe(true));
       // seed + last current preserved
       expect(c.seed?.videoId).toBe("aaaaaaaaaaa");
     });

     it("queue-dry WITH a radio continuation plays the radio track tagged fromRadio", async () => {
       const { c } = controller();
       const { sink } = fakeSink();
       c.setRadioContinuation(async () => meta("rrrrrrrrrrr"));
       await c.enqueue(meta("aaaaaaaaaaa"), user);
       c.attachSink(sink);
       await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
       sink.onTrackEnded();
       await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("rrrrrrrrrrr"));
       expect(c.snapshot().current?.fromRadio).toBe(true);
     });

     it("pause()/resume() forward to the sink and flip isPaused", async () => {
       const { c } = controller();
       const { sink, sent } = fakeSink();
       await c.enqueue(meta("aaaaaaaaaaa"), user);
       c.attachSink(sink);
       await vi.waitFor(() => expect(c.snapshot().current).not.toBeNull());
       c.pause();
       expect(c.isPaused).toBe(true);
       expect(sent.some((m) => m.type === "pause")).toBe(true);
       c.resume();
       expect(c.isPaused).toBe(false);
     });

     it("seek(ms) clamps to [0,durationMs], re-anchors position, and sends a seek", async () => {
       const { c } = controller();
       const { sink, sent } = fakeSink();
       await c.enqueue(meta("aaaaaaaaaaa", 100), user); // 100_000 ms
       c.attachSink(sink);
       await vi.waitFor(() => expect(c.snapshot().current).not.toBeNull());
       await expect(c.seek(-1)).rejects.toThrow(RangeError);
       await expect(c.seek(999_999)).rejects.toThrow(RangeError);
       const ok = await c.seek(30_000);
       expect(ok).toBe(true);
       expect(sent.some((m) => m.type === "seek" && m.ms === 30_000)).toBe(true);
     });

     it("detachSink() pauses and preserves seed/current/position; no advance fires after detach", async () => {
       const { c } = controller();
       const { sink } = fakeSink();
       await c.enqueue(meta("aaaaaaaaaaa"), user);
       await c.enqueue(meta("bbbbbbbbbbb"), user);
       c.attachSink(sink);
       await vi.waitFor(() => expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa"));
       c.detachSink();
       expect(c.isPaused).toBe(true);
       expect(c.activeSink).toBe(false);
       sink.onTrackEnded(); // detached sink must NOT advance the controller
       expect(c.snapshot().current?.meta.videoId).toBe("aaaaaaaaaaa");
     });

     it("updateSettings clamps via applySettingsPatch and fires onSettingsChanged", async () => {
       const onSettingsChanged = vi.fn();
       const c = new StationController({
         download: vi.fn(async (id) => ({ path: id })),
         onSettingsChanged,
       });
       const out = c.updateSettings({ volume: 999, repeat: "all" });
       expect(out.volume).toBe(200);
       expect(out.repeat).toBe("all");
       expect(onSettingsChanged).toHaveBeenCalledWith(out);
     });

     it("snapshot() flattens settings + exposes seed/paused/preparing/upcomingRadio", async () => {
       const { c } = controller();
       await c.enqueue(meta("aaaaaaaaaaa"), user);
       const s = c.snapshot();
       expect(s.seed?.videoId).toBe("aaaaaaaaaaa");
       expect(s.repeat).toBe("off");
       expect(s.volume).toBe(100);
       expect(Array.isArray(s.upcomingRadio)).toBe(true);
       expect(s.activePlayerPresent).toBe(false);
     });
   });
   ```

2. Run the test (expected FAIL):

   ```
   npx vitest run src/orchestrator/index.test.ts
   ```

   Expected failure: `Cannot find module './index.js'`.

3. Write the minimal implementation `src/orchestrator/index.ts`. Real code:

   ```ts
   import { EventEmitter } from "node:events";
   import type {
     CurrentItem,
     PreparingState,
     QueueItem,
     Requester,
     StationSettings,
     StationSnapshot,
     StationSnapshotFile,
     TrackMeta,
   } from "../types/index.js";
   import { AUTOPLAY_REQUESTER, DEFAULT_SETTINGS } from "../types/index.js";
   import { Mutex } from "../util/mutex.js";
   import { Queue } from "../queue/index.js";
   import { applySettingsPatch } from "./settings.js";
   import { BrowserPlayerSink } from "./browser-player-sink.js";

   export interface StationControllerDeps {
     queue?: Queue;
     settings?: Partial<StationSettings>;
     download: (
       videoId: string,
       opts?: { onProgress?: (pct: number) => void },
     ) => Promise<{ path: string }>;
     pin?: (videoId: string, path: string) => void;
     unpin?: (videoId: string) => void;
     prefetch?: (videoId: string) => Promise<void>;
     now?: () => number;
     onSettingsChanged?: (s: StationSettings) => void;
   }

   export class StationController extends EventEmitter {
     readonly queue: Queue;
     private sink: BrowserPlayerSink | null = null;
     private readonly lock = new Mutex();
     private readonly now: () => number;
     private _settings: StationSettings;
     private _seed: TrackMeta | null = null;
     private _paused = false;
     private preparing: PreparingState | null = null;
     // advance-exactly-once guard: each fresh play opens a new generation; the next trackEnd/error
     // is only honored when it matches the live generation (so an error+trackEnd pair can't double-skip).
     private playGeneration = 0;
     private startedAt: number | null = null;
     private pausedAt: number | null = null;
     private pausedAccumMs = 0;
     // radio hooks (wired by RadioEngine in 1.6; null = no radio, hold-paused on drain).
     private radioContinuation: (() => Promise<TrackMeta | null>) | null = null;
     private radioTopUp: (() => void) | null = null;
     private upcomingRadio: QueueItem[] = [];

     constructor(private readonly deps: StationControllerDeps) {
       super();
       this.now = deps.now ?? (() => Date.now());
       this.queue = deps.queue ?? new Queue();
       this._settings = applySettingsPatch({ ...DEFAULT_SETTINGS }, deps.settings ?? {});
       this.queue.on("prefetch", (videoId: string | null) => {
         if (videoId && this.deps.prefetch) void this.deps.prefetch(videoId);
       });
       this.queue.on("changed", () => {
         this.emit("changed");
         this.radioTopUp?.();
       });
     }

     get isPaused(): boolean {
       return this._paused;
     }
     get settings(): StationSettings {
       return { ...this._settings };
     }
     get seed(): TrackMeta | null {
       return this._seed;
     }
     get activeSink(): boolean {
       return this.sink !== null;
     }

     setRadioContinuation(fn: (() => Promise<TrackMeta | null>) | null): void {
       this.radioContinuation = fn;
     }
     setRadioTopUp(fn: (() => void) | null): void {
       this.radioTopUp = fn;
     }
     /** RadioEngine writes its pre-resolved buffer here for the UI "upcoming-radio preview". */
     setUpcomingRadio(items: QueueItem[]): void {
       this.upcomingRadio = items;
       this.emit("changed");
     }

     async enqueue(meta: TrackMeta, requester: Requester): Promise<QueueItem> {
       if (requester.source === "user") this._seed = meta;
       const item = await this.queue.add(meta, requester, requester.source === "autoplay");
       // First track while a sink is attached & nothing playing → start it.
       if (this.sink && this.queue.current === null && !this._paused) {
         void this.lock.runExclusive(() => this.playNextLocked());
       }
       return item;
     }

     attachSink(sink: BrowserPlayerSink): void {
       this.sink = sink;
       sink.on("trackEnd", this.onSinkTrackEnd);
       sink.on("error", this.onSinkError);
       this._paused = false;
       void this.lock.runExclusive(() => this.resumeOrStartLocked());
       this.emit("changed");
     }

     detachSink(): void {
       const s = this.sink;
       if (!s) return;
       s.off("trackEnd", this.onSinkTrackEnd);
       s.off("error", this.onSinkError);
       // bump the generation so a late trackEnd from the now-detached sink can't advance us.
       this.playGeneration += 1;
       this.sink = null;
       this._paused = true;
       this.freezePosition();
       this.emit("changed");
     }

     private readonly onSinkTrackEnd = (): void => {
       const gen = this.playGeneration;
       void this.lock.runExclusive(async () => {
         if (gen !== this.playGeneration) return; // stale signal — already advanced
         this.playGeneration += 1; // consume this generation
         await this.queue.advance();
         await this.playNextLocked();
       });
     };
     private readonly onSinkError = (): void => {
       const gen = this.playGeneration;
       void this.lock.runExclusive(async () => {
         if (gen !== this.playGeneration) return;
         this.playGeneration += 1;
         await this.queue.discardCurrent(); // failed track is NOT archived to history
         await this.playNextLocked();
       });
     };

     private async resumeOrStartLocked(): Promise<void> {
       if (this.queue.current) {
         await this.loadCurrentLocked(this.positionMs());
       } else {
         await this.playNextLocked();
       }
     }

     // Core never-stopping advance: promote head → if none, ask radio → if none, hold paused.
     private async playNextLocked(): Promise<void> {
       if (!this.queue.current) {
         const item = await this.queue.advance();
         if (!item) {
           const radioMeta = this.radioContinuation ? await this.radioContinuation() : null;
           if (radioMeta) {
             await this.queue.add(radioMeta, AUTOPLAY_REQUESTER, true);
             await this.queue.advance();
           } else {
             // queue dry, no radio: hold paused, preserve last current/seed. NO teardown.
             this._paused = true;
             this.emit("changed");
             return;
           }
         }
       }
       await this.loadCurrentLocked(0);
     }

     private async loadCurrentLocked(startMs: number): Promise<void> {
       const item = this.queue.current;
       if (!item || !this.sink) {
         this.emit("changed");
         return;
       }
       this.setPreparing({
         videoId: item.meta.videoId,
         title: item.meta.title,
         phase: "resolving",
       });
       let path: string;
       try {
         this.setPreparing({
           videoId: item.meta.videoId,
           title: item.meta.title,
           phase: "downloading",
           percent: 0,
         });
         const res = await this.deps.download(item.meta.videoId, {
           onProgress: (pct) =>
             this.setPreparing({
               videoId: item.meta.videoId,
               title: item.meta.title,
               phase: "downloading",
               percent: pct,
             }),
         });
         path = res.path;
       } catch {
         // download failed → discard + try the next (radio/next track). Best-effort.
         this.setPreparing(null);
         await this.queue.discardCurrent();
         await this.playNextLocked();
         return;
       }
       this.deps.pin?.(item.meta.videoId, path);
       this.setPreparing(null);
       this.playGeneration += 1; // fresh live track → re-arm the advance guard
       this._paused = false;
       this.markTrackStarted(startMs);
       this.sink.play({ audioUrl: `/audio/${item.meta.videoId}`, startMs });
       this.emit("changed");
     }

     skip(): void {
       const gen = this.playGeneration;
       void this.lock.runExclusive(async () => {
         if (gen !== this.playGeneration) return;
         this.playGeneration += 1;
         await this.queue.advance();
         await this.playNextLocked();
       });
     }
     pause(): void {
       this._paused = true;
       this.freezePosition();
       this.sink?.pause();
       this.emit("changed");
     }
     resume(): void {
       this._paused = false;
       this.thawPosition();
       this.sink?.resume();
       this.emit("changed");
     }

     async seek(positionMs: number): Promise<boolean> {
       const item = this.queue.current;
       if (!item) return false;
       const max =
         item.meta.durationSec && item.meta.durationSec > 0 ? item.meta.durationSec * 1000 : 0;
       if (!Number.isFinite(positionMs) || positionMs < 0 || (max > 0 && positionMs > max)) {
         throw new RangeError("positionMs out of range");
       }
       this.markTrackStarted(positionMs, this._paused);
       this.sink?.seek(positionMs);
       this.emit("changed");
       return true;
     }

     /**
      * Player <audio> 'timeupdate' telemetry (ws.ts → client {type:"position",ms}). Re-anchors the
      * position clock to the browser's authoritative currentTime so the broadcast progress bar
      * tracks real playback. Ignored when no current track / out of range. Does NOT emit 'changed'
      * (avoids a broadcast storm at ~1 Hz); the next settings/queue change carries the fresh anchor.
      */
     reportPosition(ms: number): void {
       const item = this.queue.current;
       if (!item || !Number.isFinite(ms) || ms < 0) return;
       this.markTrackStarted(ms, this._paused);
     }

     remove(itemId: string): Promise<boolean> {
       return this.queue.remove(itemId);
     }
     reorder(itemId: string, toIndex: number): Promise<boolean> {
       return this.queue.reorder(itemId, toIndex);
     }
     async jump(itemId: string): Promise<boolean> {
       const snap = this.queue.snapshot();
       const idx = snap.upcoming.findIndex((i) => i.id === itemId);
       if (idx === -1) return false;
       // Move the target to the head, then advance into it.
       await this.queue.reorder(itemId, 0);
       const gen = this.playGeneration;
       await this.lock.runExclusive(async () => {
         if (gen !== this.playGeneration) return;
         this.playGeneration += 1;
         await this.queue.advance();
         await this.playNextLocked();
       });
       return true;
     }
     shuffle(rng?: () => number): Promise<void> {
       return this.queue.shuffle(rng);
     }
     clear(): Promise<void> {
       return this.queue.clear();
     }

     updateSettings(patch: Partial<Record<keyof StationSettings, unknown>>): StationSettings {
       this._settings = applySettingsPatch(this._settings, patch);
       this.deps.onSettingsChanged?.({ ...this._settings });
       if (this.sink) this.sink.setVolume(this._settings.volume);
       this.emit("changed");
       return { ...this._settings };
     }
     setVolume(pct: number): StationSettings {
       return this.updateSettings({ volume: pct });
     }

     snapshot(): StationSnapshot {
       const snap = this.queue.snapshot();
       const current: CurrentItem | null = snap.current
         ? {
             ...snap.current,
             positionMs: this.positionMs(),
             durationMs:
               snap.current.meta.durationSec && snap.current.meta.durationSec > 0
                 ? snap.current.meta.durationSec * 1000
                 : 0,
           }
         : null;
       return {
         ...this._settings,
         current,
         upcoming: snap.upcoming,
         upcomingRadio: this.upcomingRadio.map((i) => ({ ...i })),
         history: snap.history,
         seed: this._seed,
         paused: this._paused,
         preparing: this.preparing ? { ...this.preparing } : null,
         // server fills the player-presence fields; orchestrator reports defaults.
         activePlayerPresent: false,
         activePlayerLabel: null,
       };
     }

     async restore(file: StationSnapshotFile): Promise<void> {
       this._seed = file.seed;
       this._settings = applySettingsPatch(this._settings, file.settings);
       this.upcomingRadio = Array.isArray(file.upcomingRadio) ? file.upcomingRadio : [];
       const items: QueueItem[] = [
         ...(file.current ? [file.current] : []),
         ...(Array.isArray(file.queue) ? file.queue : []),
       ];
       for (const it of items) {
         if (typeof it?.meta?.videoId !== "string" || typeof it?.requester?.deviceId !== "string")
           continue;
         await this.queue.add(it.meta, it.requester, it.fromRadio === true);
       }
       // Promote the first item to "current" without playing (no sink yet on a cold restore).
       if (this.queue.current === null && this.queue.snapshot().upcoming.length > 0) {
         await this.queue.advance();
       }
       this._paused = true;
       this.markTrackStarted(file.positionMs ?? 0, true);
       this.emit("changed");
     }

     // ── position bookkeeping ─────────────────────────────────────────────────
     private positionMs(): number {
       if (this.startedAt === null) return 0;
       const pausedNow = this.pausedAt !== null ? this.now() - this.pausedAt : 0;
       return Math.max(0, this.now() - this.startedAt - this.pausedAccumMs - pausedNow);
     }
     private markTrackStarted(baseMs = 0, keepPaused = false): void {
       const paused = keepPaused && this._paused;
       this.startedAt = this.now() - baseMs;
       this.pausedAccumMs = 0;
       this.pausedAt = paused ? this.now() : null;
     }
     private freezePosition(): void {
       if (this.pausedAt === null) this.pausedAt = this.now();
     }
     private thawPosition(): void {
       if (this.pausedAt !== null) {
         this.pausedAccumMs += this.now() - this.pausedAt;
         this.pausedAt = null;
       }
     }
     private setPreparing(state: PreparingState | null): void {
       this.preparing = state;
       this.emit("changed");
     }
   }
   ```

4. Run the test (expected PASS):

   ```
   npx vitest run src/orchestrator/index.test.ts
   ```

   Expected: `Tests  11 passed (11)` (all core/seek/preparing/no-timeout/sink cases green).

5. Run the controller test file (expected PASS):
   ```
   npx vitest run src/orchestrator/index.test.ts
   ```
   Expected: `Test Files  1 passed (1)` / `Tests  11 passed (11)`.

---

### Task 1.6: RadioEngine

**Files**

- Create: `src/radio/index.ts`
- Test: `src/radio/index.test.ts`

**Interfaces**

- Consumes: 1.5 `StationController` (`seed` getter + `enqueue` with `AUTOPLAY_REQUESTER` + `queue`); (Phase 0) `YouTubeService.related`/`artistTracks`; (types) `TrackMeta`, `AutoplaySource`, `QueueItem`, `AUTOPLAY_REQUESTER`.
- Produces:
  ```ts
  export interface RadioDeps {
    youtube: Pick<YouTubeService, "related" | "artistTracks">;
    station: Pick<StationController, "seed" | "queue" | "enqueue">;
    settings: () => { autoplay: boolean; autoplaySource: AutoplaySource };
    recentWindow?: number; // bounded recent-history de-dup window (default 50)
  }
  export class RadioEngine {
    constructor(deps: RadioDeps);
    ensureAhead(lowWater?: number): Promise<void>; // keep >= lowWater (default 1) upcoming; appends radio tracks via station.enqueue(AUTOPLAY_REQUESTER)
    nextCandidate(): Promise<TrackMeta | null>; // seed===null → null (cold start); de-dup vs the bounded recent window; never throws
    reset(): void; // clear the recent window on a new user seed
  }
  ```
  `youtube.related(videoId)`/`youtube.artistTracks(meta)` return `TrackMeta[]` (best-effort). `nextCandidate()`: returns `null` when `seed === null` (cold start, spec §4), branches the source on `settings().autoplaySource` (`"artist"` → `artistTracks(seed)`, else `related(seed.videoId)`), filters out live tracks and any videoId in the bounded recent-history `Set` (which is seeded from the controller's current/upcoming/history videoIds + everything radio has already picked), adds the chosen id to the window, and never throws (a source error → `null`). No hard chain cap (spec §4: never stops). `reset()` clears the recent `Set` so a fresh user seed gets a clean run.

**Steps**

1. Write the failing test `src/radio/index.test.ts`:

   ```ts
   import { describe, it, expect, vi } from "vitest";
   import { RadioEngine } from "./index.js";
   import type { TrackMeta, AutoplaySource, QueueItem, Requester } from "../types/index.js";

   function meta(id: string, isLive = false): TrackMeta {
     return { videoId: id, title: id, channel: "c", durationSec: 100, isLive, thumbnailUrl: null };
   }
   function item(id: string): QueueItem {
     return {
       id: `q-${id}`,
       meta: meta(id),
       requester: { deviceId: "d", displayName: "u", source: "user" } as Requester,
       addedAt: 0,
       audio: null,
       fromRadio: false,
     };
   }
   function fakeStation(
     seed: TrackMeta | null,
     snap: { current: QueueItem | null; upcoming: QueueItem[]; history: QueueItem[] },
   ) {
     const enqueued: TrackMeta[] = [];
     return {
       station: {
         seed,
         queue: { snapshot: () => snap },
         enqueue: vi.fn(async (m: TrackMeta) => {
           enqueued.push(m);
           return item(m.videoId);
         }),
       },
       enqueued,
     };
   }
   const radioSettings = () => ({ autoplay: true, autoplaySource: "radio" as AutoplaySource });

   describe("RadioEngine", () => {
     it("cold start (seed null) → nextCandidate is null", async () => {
       const related = vi.fn(async () => [meta("rrrrrrrrrrr")]);
       const { station } = fakeStation(null, { current: null, upcoming: [], history: [] });
       const r = new RadioEngine({
         youtube: { related, artistTracks: vi.fn() },
         station: station as any,
         settings: radioSettings,
       });
       expect(await r.nextCandidate()).toBeNull();
       expect(related).not.toHaveBeenCalled();
     });

     it("radio source pulls related(seed.videoId) and returns the first new non-live track", async () => {
       const related = vi.fn(async () => [meta("sssssssssss"), meta("ttttttttttt")]);
       const { station } = fakeStation(meta("aaaaaaaaaaa"), {
         current: null,
         upcoming: [],
         history: [],
       });
       const r = new RadioEngine({
         youtube: { related, artistTracks: vi.fn() },
         station: station as any,
         settings: radioSettings,
       });
       const c = await r.nextCandidate();
       expect(related).toHaveBeenCalledWith("aaaaaaaaaaa");
       expect(c?.videoId).toBe("sssssssssss");
     });

     it("artist source pulls artistTracks(seed)", async () => {
       const artistTracks = vi.fn(async () => [meta("zzzzzzzzzzz")]);
       const { station } = fakeStation(meta("aaaaaaaaaaa"), {
         current: null,
         upcoming: [],
         history: [],
       });
       const r = new RadioEngine({
         youtube: { related: vi.fn(), artistTracks },
         station: station as any,
         settings: () => ({ autoplay: true, autoplaySource: "artist" }),
       });
       expect((await r.nextCandidate())?.videoId).toBe("zzzzzzzzzzz");
       expect(artistTracks).toHaveBeenCalled();
     });

     it("de-dups vs current/upcoming/history AND skips live tracks", async () => {
       const related = vi.fn(async () => [
         meta("aaaaaaaaaaa"),
         meta("lllllllllll", true),
         meta("nnnnnnnnnnn"),
       ]);
       const { station } = fakeStation(meta("aaaaaaaaaaa"), {
         current: item("aaaaaaaaaaa"),
         upcoming: [item("bbbbbbbbbbb")],
         history: [item("ccccccccccc")],
       });
       const r = new RadioEngine({
         youtube: { related, artistTracks: vi.fn() },
         station: station as any,
         settings: radioSettings,
       });
       expect((await r.nextCandidate())?.videoId).toBe("nnnnnnnnnnn"); // aaa=current, lll=live → skipped
     });

     it("does not re-pick the same id across consecutive calls (bounded recent window)", async () => {
       const related = vi.fn(async () => [meta("sssssssssss"), meta("ttttttttttt")]);
       const { station } = fakeStation(meta("aaaaaaaaaaa"), {
         current: null,
         upcoming: [],
         history: [],
       });
       const r = new RadioEngine({
         youtube: { related, artistTracks: vi.fn() },
         station: station as any,
         settings: radioSettings,
       });
       expect((await r.nextCandidate())?.videoId).toBe("sssssssssss");
       expect((await r.nextCandidate())?.videoId).toBe("ttttttttttt");
     });

     it("reset() clears the recent window so a fresh seed can re-pick", async () => {
       const related = vi.fn(async () => [meta("sssssssssss")]);
       const { station } = fakeStation(meta("aaaaaaaaaaa"), {
         current: null,
         upcoming: [],
         history: [],
       });
       const r = new RadioEngine({
         youtube: { related, artistTracks: vi.fn() },
         station: station as any,
         settings: radioSettings,
       });
       expect((await r.nextCandidate())?.videoId).toBe("sssssssssss");
       expect(await r.nextCandidate()).toBeNull(); // exhausted (only one candidate, now seen)
       r.reset();
       expect((await r.nextCandidate())?.videoId).toBe("sssssssssss");
     });

     it("a source error → null, never throws", async () => {
       const related = vi.fn(async () => {
         throw new Error("yt down");
       });
       const { station } = fakeStation(meta("aaaaaaaaaaa"), {
         current: null,
         upcoming: [],
         history: [],
       });
       const r = new RadioEngine({
         youtube: { related, artistTracks: vi.fn() },
         station: station as any,
         settings: radioSettings,
       });
       await expect(r.nextCandidate()).resolves.toBeNull();
     });

     it("autoplay off → nextCandidate is null (engine idle)", async () => {
       const related = vi.fn(async () => [meta("sssssssssss")]);
       const { station } = fakeStation(meta("aaaaaaaaaaa"), {
         current: null,
         upcoming: [],
         history: [],
       });
       const r = new RadioEngine({
         youtube: { related, artistTracks: vi.fn() },
         station: station as any,
         settings: () => ({ autoplay: false, autoplaySource: "radio" }),
       });
       expect(await r.nextCandidate()).toBeNull();
       expect(related).not.toHaveBeenCalled();
     });

     it("ensureAhead(lowWater) appends radio tracks via station.enqueue until upcoming >= lowWater", async () => {
       const related = vi.fn(async () => [
         meta("sssssssssss"),
         meta("ttttttttttt"),
         meta("uuuuuuuuuuu"),
       ]);
       const snap = {
         current: item("aaaaaaaaaaa"),
         upcoming: [] as QueueItem[],
         history: [] as QueueItem[],
       };
       const enqueued: TrackMeta[] = [];
       const station = {
         seed: meta("aaaaaaaaaaa"),
         queue: { snapshot: () => snap },
         enqueue: vi.fn(async (m: TrackMeta) => {
           enqueued.push(m);
           snap.upcoming.push(item(m.videoId));
           return item(m.videoId);
         }),
       };
       const r = new RadioEngine({
         youtube: { related, artistTracks: vi.fn() },
         station: station as any,
         settings: radioSettings,
       });
       await r.ensureAhead(2);
       expect(enqueued.map((m) => m.videoId)).toEqual(["sssssssssss", "ttttttttttt"]);
     });

     it("ensureAhead stops cleanly when no new candidate is available", async () => {
       const related = vi.fn(async () => [] as TrackMeta[]);
       const snap = {
         current: item("aaaaaaaaaaa"),
         upcoming: [] as QueueItem[],
         history: [] as QueueItem[],
       };
       const station = {
         seed: meta("aaaaaaaaaaa"),
         queue: { snapshot: () => snap },
         enqueue: vi.fn(async (m: TrackMeta) => item(m.videoId)),
       };
       const r = new RadioEngine({
         youtube: { related, artistTracks: vi.fn() },
         station: station as any,
         settings: radioSettings,
       });
       await expect(r.ensureAhead(2)).resolves.toBeUndefined();
       expect(station.enqueue).not.toHaveBeenCalled();
     });
   });
   ```

2. Run the test (expected FAIL):

   ```
   npx vitest run src/radio/index.test.ts
   ```

   Expected failure: `Cannot find module './index.js'`.

3. Write the minimal implementation `src/radio/index.ts`:

   ```ts
   import type { AutoplaySource, QueueItem, TrackMeta } from "../types/index.js";
   import { AUTOPLAY_REQUESTER } from "../types/index.js";
   import type { YouTubeService } from "../youtube/index.js";
   import type { StationController } from "../orchestrator/index.js";

   export interface RadioDeps {
     youtube: Pick<YouTubeService, "related" | "artistTracks">;
     station: Pick<StationController, "seed" | "queue" | "enqueue">;
     settings: () => { autoplay: boolean; autoplaySource: AutoplaySource };
     recentWindow?: number;
   }

   /**
    * The always-playing station engine. When the explicit queue is draining, it fetches
    * related/artist tracks for the current seed, filters out anything recently seen (current +
    * upcoming + history + everything radio already picked) and live streams, and appends the
    * next one via station.enqueue(AUTOPLAY_REQUESTER). No hard chain cap — the station never
    * runs out (spec §4); the de-dup is a BOUNDED recent-history Set, not a permanent ban.
    */
   export class RadioEngine {
     private readonly recent = new Set<string>();
     private readonly recentOrder: string[] = [];
     private readonly recentWindow: number;

     constructor(private readonly deps: RadioDeps) {
       this.recentWindow = deps.recentWindow ?? 50;
     }

     reset(): void {
       this.recent.clear();
       this.recentOrder.length = 0;
     }

     private remember(videoId: string): void {
       if (this.recent.has(videoId)) return;
       this.recent.add(videoId);
       this.recentOrder.push(videoId);
       while (this.recentOrder.length > this.recentWindow) {
         const evicted = this.recentOrder.shift();
         if (evicted !== undefined) this.recent.delete(evicted);
       }
     }

     // Seed the de-dup window from the live queue so we never re-pick something already queued/played.
     private seenIds(): Set<string> {
       const seen = new Set<string>(this.recent);
       const snap = this.deps.station.queue.snapshot();
       const collect = (i: QueueItem | null) => {
         if (i?.meta?.videoId) seen.add(i.meta.videoId);
       };
       collect(snap.current);
       snap.upcoming.forEach(collect);
       snap.history.forEach(collect);
       return seen;
     }

     async nextCandidate(): Promise<TrackMeta | null> {
       const { autoplay, autoplaySource } = this.deps.settings();
       if (!autoplay) return null;
       const seed = this.deps.station.seed;
       if (seed === null) return null;

       let candidates: TrackMeta[];
       try {
         candidates =
           autoplaySource === "artist"
             ? await this.deps.youtube.artistTracks(seed)
             : await this.deps.youtube.related(seed.videoId);
       } catch {
         return null; // best-effort: a source error idles, never throws
       }
       const seen = this.seenIds();
       const next = candidates.find((c) => c.videoId && !c.isLive && !seen.has(c.videoId));
       if (!next) return null;
       this.remember(next.videoId);
       return next;
     }

     async ensureAhead(lowWater = 1): Promise<void> {
       // Append radio tracks until the explicit upcoming list reaches lowWater (or we run dry).
       // Bounded by lowWater so a no-candidate result terminates the loop.
       for (let guard = 0; guard < lowWater + 1; guard++) {
         const upcoming = this.deps.station.queue.snapshot().upcoming.length;
         if (upcoming >= lowWater) return;
         const next = await this.nextCandidate();
         if (!next) return;
         await this.deps.station.enqueue(next, AUTOPLAY_REQUESTER);
       }
     }
   }
   ```

4. Run the test (expected PASS):
   ```
   npx vitest run src/radio/index.test.ts
   ```
   Expected: `Tests  10 passed (10)`.

---

### Task 1.7: De-guild snapshot persistence

**Files**

- Create: `src/orchestrator/snapshot.ts`
- Test: `src/orchestrator/snapshot.test.ts`

**Interfaces**

- Consumes: 1.5 `StationController.snapshot`/`restore`; (types) `StationSnapshotFile`, `QueueItem`, `StationSettings`.
- Produces:
  ```ts
  export const STATION_SNAPSHOT_FILE = "station-snapshot.json";
  export function collectStationSnapshot(
    station: { snapshot(): StationSnapshot; settings: StationSettings; seed: TrackMeta | null },
    activePlayerDeviceId: string | null,
    now: number,
  ): StationSnapshotFile;
  export function writeStationSnapshot(dir: string, file: StationSnapshotFile): Promise<void>; // atomic tmp+rename
  export function readStationSnapshot(dir: string): Promise<StationSnapshotFile | null>; // tolerant/version-guarded
  export function restoreStationSnapshot(
    file: StationSnapshotFile,
    station: { restore(file: StationSnapshotFile): Promise<void> },
    log: Pick<Logger, "info" | "error">,
  ): Promise<void>;
  ```
  De-guilded: a SINGLE `StationSnapshotFile` (no `guilds[]` array), file name `station-snapshot.json`. `collectStationSnapshot` reads the controller's `snapshot()` to fill `seed`/`current`/`positionMs`/`queue`/`upcomingRadio`/`history`/`settings` and stamps `activePlayerDeviceId`. `readStationSnapshot` returns `null` on missing/corrupt/wrong-version. `restoreStationSnapshot` validates shape and calls `station.restore(file)` (catching/logging errors).

**Steps**

1. Write the failing test `src/orchestrator/snapshot.test.ts`:

   ```ts
   import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
   import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
   import { tmpdir } from "node:os";
   import { join } from "node:path";
   import {
     collectStationSnapshot,
     writeStationSnapshot,
     readStationSnapshot,
     restoreStationSnapshot,
     STATION_SNAPSHOT_FILE,
   } from "./snapshot.js";
   import type {
     StationSnapshot,
     StationSettings,
     TrackMeta,
     QueueItem,
     Requester,
   } from "../types/index.js";
   import { DEFAULT_SETTINGS } from "../types/index.js";

   function meta(id: string): TrackMeta {
     return {
       videoId: id,
       title: id,
       channel: "c",
       durationSec: 100,
       isLive: false,
       thumbnailUrl: null,
     };
   }
   function item(id: string, fromRadio = false): QueueItem {
     return {
       id: `q-${id}`,
       meta: meta(id),
       requester: { deviceId: "d", displayName: "u", source: "user" } as Requester,
       addedAt: 0,
       audio: null,
       fromRadio,
     };
   }
   function fakeStation(snap: Partial<StationSnapshot>): {
     snapshot(): StationSnapshot;
     settings: StationSettings;
     seed: TrackMeta | null;
   } {
     const full: StationSnapshot = {
       ...DEFAULT_SETTINGS,
       current: null,
       upcoming: [],
       upcomingRadio: [],
       history: [],
       seed: null,
       paused: false,
       preparing: null,
       activePlayerPresent: false,
       activePlayerLabel: null,
       ...snap,
     };
     return { snapshot: () => full, settings: { ...DEFAULT_SETTINGS }, seed: full.seed };
   }
   let dir: string;
   beforeEach(async () => {
     dir = await mkdtemp(join(tmpdir(), "snap-"));
   });
   afterEach(async () => {
     await rm(dir, { recursive: true, force: true });
   });

   describe("station snapshot persistence", () => {
     it("collectStationSnapshot captures seed/current/position/queue/upcomingRadio/settings + activePlayer", () => {
       const cur = { ...item("aaaaaaaaaaa"), positionMs: 4200, durationMs: 100000 };
       const station = fakeStation({
         seed: meta("aaaaaaaaaaa"),
         current: cur,
         upcoming: [item("bbbbbbbbbbb")],
         upcomingRadio: [item("rrrrrrrrrrr", true)],
         history: [item("ccccccccccc")],
       });
       const file = collectStationSnapshot(station, "dev-7", 999);
       expect(file.version).toBe(1);
       expect(file.savedAt).toBe(999);
       expect(file.seed?.videoId).toBe("aaaaaaaaaaa");
       expect(file.current?.meta.videoId).toBe("aaaaaaaaaaa");
       expect(file.positionMs).toBe(4200);
       expect(file.queue.map((i) => i.meta.videoId)).toEqual(["bbbbbbbbbbb"]);
       expect(file.upcomingRadio.map((i) => i.meta.videoId)).toEqual(["rrrrrrrrrrr"]);
       expect(file.history.map((i) => i.meta.videoId)).toEqual(["ccccccccccc"]);
       expect(file.activePlayerDeviceId).toBe("dev-7");
     });

     it("write → read round-trips to STATION_SNAPSHOT_FILE", async () => {
       const station = fakeStation({ seed: meta("aaaaaaaaaaa") });
       const file = collectStationSnapshot(station, null, 1);
       await writeStationSnapshot(dir, file);
       const raw = JSON.parse(await readFile(join(dir, STATION_SNAPSHOT_FILE), "utf8"));
       expect(raw.version).toBe(1);
       const read = await readStationSnapshot(dir);
       expect(read?.seed?.videoId).toBe("aaaaaaaaaaa");
     });

     it("readStationSnapshot returns null for missing / corrupt / wrong-version files", async () => {
       expect(await readStationSnapshot(dir)).toBeNull();
       await writeFile(join(dir, STATION_SNAPSHOT_FILE), "{not json");
       expect(await readStationSnapshot(dir)).toBeNull();
       await writeFile(join(dir, STATION_SNAPSHOT_FILE), JSON.stringify({ version: 2 }));
       expect(await readStationSnapshot(dir)).toBeNull();
     });

     it("restoreStationSnapshot calls station.restore and logs success", async () => {
       const restore = vi.fn(async () => {});
       const log = { info: vi.fn(), error: vi.fn() };
       const station = fakeStation({ seed: meta("aaaaaaaaaaa") });
       const file = collectStationSnapshot(station, null, 1);
       await restoreStationSnapshot(file, { restore }, log);
       expect(restore).toHaveBeenCalledWith(file);
       expect(log.info).toHaveBeenCalled();
       expect(log.error).not.toHaveBeenCalled();
     });

     it("restoreStationSnapshot logs (does not throw) when restore rejects", async () => {
       const restore = vi.fn(async () => {
         throw new Error("bad");
       });
       const log = { info: vi.fn(), error: vi.fn() };
       const station = fakeStation({});
       const file = collectStationSnapshot(station, null, 1);
       await expect(restoreStationSnapshot(file, { restore }, log)).resolves.toBeUndefined();
       expect(log.error).toHaveBeenCalled();
     });
   });
   ```

2. Run the test (expected FAIL):

   ```
   npx vitest run src/orchestrator/snapshot.test.ts
   ```

   Expected failure: `Cannot find module './snapshot.js'`.

3. Write the minimal implementation `src/orchestrator/snapshot.ts`:

   ```ts
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

   export async function writeStationSnapshot(
     dir: string,
     file: StationSnapshotFile,
   ): Promise<void> {
     await mkdir(dir, { recursive: true });
     const tmp = join(dir, `${STATION_SNAPSHOT_FILE}.${process.pid}.tmp`);
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
   ```

4. Run the test (expected PASS):
   ```
   npx vitest run src/orchestrator/snapshot.test.ts
   ```
   Expected: `Tests  5 passed (5)`.

---

### Task 1.8: Phase completion — full verification, adversarial debug, single squash commit

**Files**

- No new source files; this task verifies and commits all of Phase 1 (Tasks 1.1–1.7).

**Steps**

1. Run the full verification suite from the repo root (`/home/kasm-user/lan-jukebox`):

   ```
   npm run typecheck && npm run lint && npm run build && npm test
   ```

   Expected green output (shape):

   ```
   > tsc -p tsconfig.json --noEmit        # typecheck: no errors
   > eslint .                              # lint: no problems
   > tsc -p tsconfig.json && vite build    # build: dist/ emitted, web bundle built
   > vitest run
    ✓ src/queue/index.test.ts (9)
    ✓ src/orchestrator/settings.test.ts (6)
    ✓ src/orchestrator/browser-player-sink.test.ts (7)
    ✓ src/orchestrator/index.test.ts (11)
    ✓ src/radio/index.test.ts (10)
    ✓ src/orchestrator/snapshot.test.ts (5)
    Test Files  6 passed (6)
         Tests  48 passed (48)
   ```

   If anything is red, fix it before proceeding — do NOT commit on red.

2. Run a full adversarial multi-agent `/debug` pass over the Phase 1 changed files. Fan out finder agents across:
   - `src/queue/index.ts`, `src/orchestrator/settings.ts`, `src/orchestrator/browser-player-sink.ts`, `src/orchestrator/index.ts`, `src/radio/index.ts`, `src/orchestrator/snapshot.ts`
   - Reliability lenses to assign the finders:
     - **Advance-exactly-once correctness:** can an `error` + `trackEnd` pair (or a stale post-detach signal) ever double-advance? Verify the `playGeneration` guard is bumped on every play/seek/detach/skip and checked under the lock.
     - **Never-stops invariant (spec §3/§4):** confirm there is NO idle timer, NO `'idle'` event, NO teardown/stop path anywhere; a queue-dry with no radio MUST hold paused with `current`/`seed`/`position` preserved, not clear state.
     - **Seed semantics (spec §4):** only `requester.source === "user"` updates the seed; `AUTOPLAY_REQUESTER` adds must NOT reset it; cold start (`seed === null`) yields no radio.
     - **Radio de-dup boundedness:** the recent-history `Set` is bounded (evicts past `recentWindow`); `nextCandidate` never throws; `ensureAhead` terminates when no candidate is available (no infinite loop).
     - **Atomic persistence:** tmp+rename is used for the station snapshot; reads are tolerant of missing/corrupt/wrong-version; restore validates per-item shape (skips malformed) and never aborts the whole restore.
     - **Concurrency:** the controller's `lock` serializes advance/play/skip/jump so they cannot interleave; the queue's `Mutex` serializes its own mutations.
   - Adversarially verify EACH finding (reproduce with a focused failing test before accepting it as a real bug; reject non-reproducing/speculative findings).
   - Fix all CONFIRMED bugs, adding a regression test for each, and re-run `npm test` until green again.

3. After the debug pass is green, make EXACTLY ONE squash commit for the whole phase (this one-commit-per-phase-after-debug rule overrides the skill default of per-task commits). Confirm the working branch is not the default branch first; if on `master`, the bot's workflow pushes to `master` directly per project convention, so commit there:
   ```
   git add src/queue src/orchestrator src/radio
   git commit -m "$(cat <<'EOF'
   Phase 1: station orchestrator & radio engine

   De-guild + de-Discord the queue and orchestrator into a single
   never-stopping StationController whose audio sink is a browser-player
   adapter (BrowserPlayerSink, ServerPlayerMessage over WS). Build the
   RadioEngine on YouTubeService.related/artistTracks with seed tracking,
   bounded recent-history de-dup, keep-ahead, cold-start-waits-for-seed,
   and NO idle timeout. Wire de-guilded settings/snapshot.

   - queue: GuildQueue → Queue, add() gains fromRadio, QueueItem.audio/fromRadio
   - settings: pruned to repeat/autoplay/autoplaySource/volume/maxTrackDuration
   - browser-player-sink: VoiceSession-shaped WS sink, no idle timer
   - orchestrator: StationController, advance-exactly-once guard, no stop path
   - radio: RadioEngine seed→related/artist→de-dup→keep-ahead→never-empty
   - snapshot: single StationSnapshotFile, atomic write, tolerant read/restore

   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   EOF
   )"
   ```
   Expected: one commit created containing all Phase 1 files. Do NOT push unless the user asks.

---

## Phase 2:Audio streaming route — Audio streaming route

**Goal:** Serve `GET /audio/:trackId` with correct HTTP range/206 semantics — resolve `trackId` (= `videoId`) to a cached file (downloading + transcoding/remuxing first via `YouTubeService.download` + `AudioCache` if missing), choose `Content-Type` from the file's `AudioInfo`, and support full (200) + partial (206) responses with `Accept-Ranges` / `Content-Range` / `Content-Length`, 404 on unresolvable, 416 on an unsatisfiable range.

**Parallelization:**

- **Parallel-safe (fully disjoint, no shared-hub edits):** `src/audio/format.ts` (+ `src/audio/format.test.ts`) and `src/audio/index.ts` (+ `src/audio/index.test.ts`). The whole `src/audio/` module is a standalone Fastify plugin; nothing else in the tree imports it until `server/app.ts` registers it in Phase 4.
- **Sequential _within_ this phase:** Task 2.2 consumes `chooseDelivery` from Task 2.1, so author 2.1 before 2.2. There are no shared hub files to edit in this phase (`sharedHubFiles: none`).
- Both tasks only import from the already-frozen backbone: `src/types/index.ts` (Task 0.1), `src/cache/index.ts` (Task 0.6), `src/youtube/index.ts` (Task 0.4), `src/util/semaphore.ts` (Task 0.3). Those modules must exist (Phase 0/1) before this phase runs.

ESM/NodeNext: every relative import uses the `.js` extension. `noUncheckedIndexedAccess` and `strict` are on. Tests are Vitest (node env), run with `npx vitest run <path>`.

---

### Task 2.1: Audio format / delivery policy

Pure, dependency-free decision function: given the file's real `AudioInfo` (or `null` when unknown) plus the on-disk file extension, decide the HTTP `Content-Type` and whether the file must be transcoded before serving. Per spec §8: opus/webm and aac/m4a are broadly browser-playable → serve as-is; anything else → transcode to AAC `.m4a` (`audio/mp4`). Also exposes a transcode helper that remuxes/transcodes a source file to a clean `.m4a` via ffmpeg.

**Files**

- Create: `src/audio/format.ts`
- Test: `src/audio/format.test.ts`

**Interfaces**

Consumes (Task 0.1, `src/types/index.ts`):

```ts
export interface AudioInfo {
  codec: string; // yt-dlp acodec, e.g. "opus", "aac", "mp4a.40.2", "vorbis", "mp3", "ac-3"
  bitrateKbps: number;
  sampleRateHz: number;
}
```

Produces (`src/audio/format.ts`):

```ts
export interface Delivery {
  contentType: string; // a value from MIME_BY_EXT or "audio/mp4" for the transcode target
  needsTranscode: boolean;
}

/** MIME map for the containers we serve as-is, plus the transcode target. */
export const MIME_BY_EXT: Readonly<Record<string, string>>;
//  { webm:"audio/webm", m4a:"audio/mp4", mp4:"audio/mp4", opus:"audio/ogg", ogg:"audio/ogg" }

export const TRANSCODE_CONTENT_TYPE = "audio/mp4";

/**
 * Decide how to serve a cached file.
 * Serve-as-is when the REAL codec is browser-playable in a clean container:
 *   - opus / vorbis in a webm|ogg|opus container  -> audio/webm | audio/ogg
 *   - aac (acodec "aac" or "mp4a*") in an m4a|mp4 container -> audio/mp4
 * Everything else (mp3, ac-3, flac, unknown codec, or a playable codec in a
 * mismatched/unknown container) -> needsTranscode:true, contentType audio/mp4.
 * When `audio` is null (format never captured) we can't prove it's safe -> transcode.
 */
export function chooseDelivery(audio: AudioInfo | null, ext: string): Delivery;

/**
 * Transcode/remux `srcPath` to a clean AAC `.m4a` at `destPath` via ffmpeg
 * (`-i src -vn -c:a aac -b:a 192k -movflags +faststart -f mp4 dest`).
 * Resolves on exit code 0; rejects with the ffmpeg stderr tail otherwise.
 * Injectable spawn for tests (default = node:child_process spawn).
 */
export function transcodeToM4a(
  srcPath: string,
  destPath: string,
  spawnFn?: typeof import("node:child_process").spawn,
): Promise<void>;
```

**Steps**

1. **Write the failing test — extension + codec matrix.** Create `src/audio/format.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { chooseDelivery, transcodeToM4a, MIME_BY_EXT, TRANSCODE_CONTENT_TYPE } from "./format.js";
import type { AudioInfo } from "../types/index.js";

const opus: AudioInfo = { codec: "opus", bitrateKbps: 160, sampleRateHz: 48000 };
const aac: AudioInfo = { codec: "mp4a.40.2", bitrateKbps: 128, sampleRateHz: 44100 };
const mp3: AudioInfo = { codec: "mp3", bitrateKbps: 128, sampleRateHz: 44100 };

describe("chooseDelivery", () => {
  it("serves opus/webm as-is with audio/webm", () => {
    expect(chooseDelivery(opus, "webm")).toEqual({
      contentType: "audio/webm",
      needsTranscode: false,
    });
  });

  it("serves opus in an .opus/.ogg container as audio/ogg as-is", () => {
    expect(chooseDelivery(opus, "opus")).toEqual({
      contentType: "audio/ogg",
      needsTranscode: false,
    });
    expect(chooseDelivery(opus, "ogg")).toEqual({
      contentType: "audio/ogg",
      needsTranscode: false,
    });
  });

  it("serves aac/m4a (and aac/mp4) as-is with audio/mp4", () => {
    expect(chooseDelivery(aac, "m4a")).toEqual({
      contentType: "audio/mp4",
      needsTranscode: false,
    });
    expect(chooseDelivery(aac, "mp4")).toEqual({
      contentType: "audio/mp4",
      needsTranscode: false,
    });
  });

  it("transcodes mp3 to audio/mp4 even though mp3 is in an mp3 container", () => {
    expect(chooseDelivery(mp3, "mp3")).toEqual({
      contentType: TRANSCODE_CONTENT_TYPE,
      needsTranscode: true,
    });
  });

  it("transcodes a playable codec stuck in a mismatched/unknown container", () => {
    // opus codec but the file landed as .m4a -> not a clean opus container -> transcode
    expect(chooseDelivery(opus, "m4a")).toEqual({
      contentType: TRANSCODE_CONTENT_TYPE,
      needsTranscode: true,
    });
    // aac codec in a webm container -> transcode
    expect(chooseDelivery(aac, "webm")).toEqual({
      contentType: TRANSCODE_CONTENT_TYPE,
      needsTranscode: true,
    });
  });

  it("transcodes when AudioInfo is null (format unknown — can't prove safe)", () => {
    expect(chooseDelivery(null, "webm")).toEqual({
      contentType: TRANSCODE_CONTENT_TYPE,
      needsTranscode: true,
    });
  });

  it("is case-insensitive on the extension (leading dot tolerated)", () => {
    expect(chooseDelivery(opus, ".WEBM")).toEqual({
      contentType: "audio/webm",
      needsTranscode: false,
    });
  });

  it("exposes the MIME map and transcode constant", () => {
    expect(MIME_BY_EXT.webm).toBe("audio/webm");
    expect(MIME_BY_EXT.m4a).toBe("audio/mp4");
    expect(TRANSCODE_CONTENT_TYPE).toBe("audio/mp4");
  });
});
```

2. **Run it (expect FAIL).** `npx vitest run src/audio/format.test.ts`
   Expected: `Error: Failed to resolve import "./format.js"` (module does not exist yet) — the whole suite errors / fails to collect.

3. **Minimal implementation — the decision function.** Create `src/audio/format.ts`:

```ts
import type { AudioInfo } from "../types/index.js";

export interface Delivery {
  contentType: string;
  needsTranscode: boolean;
}

/** Containers we can hand to a browser <audio> unchanged, mapped to their MIME type. */
export const MIME_BY_EXT: Readonly<Record<string, string>> = {
  webm: "audio/webm",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  opus: "audio/ogg",
  ogg: "audio/ogg",
};

/** The container we transcode unplayable/unknown audio into (AAC in MP4). */
export const TRANSCODE_CONTENT_TYPE = "audio/mp4";

function normExt(ext: string): string {
  return ext.replace(/^\./, "").toLowerCase();
}

function isOpusFamily(codec: string): boolean {
  const c = codec.toLowerCase();
  return c === "opus" || c === "vorbis";
}

function isAacFamily(codec: string): boolean {
  const c = codec.toLowerCase();
  // yt-dlp emits "aac" or an ISO codec string like "mp4a.40.2".
  return c === "aac" || c.startsWith("mp4a");
}

export function chooseDelivery(audio: AudioInfo | null, ext: string): Delivery {
  // No captured format -> we can't prove the bytes are browser-safe -> transcode.
  if (!audio) {
    return { contentType: TRANSCODE_CONTENT_TYPE, needsTranscode: true };
  }
  const e = normExt(ext);
  // opus/vorbis in a webm|ogg|opus container -> serve as-is.
  if (isOpusFamily(audio.codec) && (e === "webm" || e === "ogg" || e === "opus")) {
    return { contentType: MIME_BY_EXT[e]!, needsTranscode: false };
  }
  // aac in an m4a|mp4 container -> serve as-is.
  if (isAacFamily(audio.codec) && (e === "m4a" || e === "mp4")) {
    return { contentType: MIME_BY_EXT[e]!, needsTranscode: false };
  }
  // Anything else (mp3, ac-3, flac, codec/container mismatch, unknown) -> transcode.
  return { contentType: TRANSCODE_CONTENT_TYPE, needsTranscode: true };
}
```

4. **Run it (expect PASS for `chooseDelivery`; FAIL on the transcode import).** `npx vitest run src/audio/format.test.ts`
   Expected: the `chooseDelivery` tests pass, but the import of `transcodeToM4a` is still unresolved if you reference it — at this point the file does not export `transcodeToM4a`, so collection fails with `transcodeToM4a is not a function` (or an unresolved named import). Proceed to step 5.

5. **Write the failing test — transcode spawns ffmpeg with the right args.** Append to `src/audio/format.test.ts`:

```ts
describe("transcodeToM4a", () => {
  function fakeFf(exitCode: number) {
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const spawnFn = vi.fn(() => {
      // resolve/reject on the next tick so listeners are attached first
      queueMicrotask(() => {
        child.stderr.emit("data", Buffer.from("ffmpeg log line\n"));
        child.emit("close", exitCode);
      });
      return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
    });
    return { child, spawnFn };
  }

  it("invokes ffmpeg with -c:a aac, faststart, mp4 muxer and resolves on exit 0", async () => {
    const { spawnFn } = fakeFf(0);
    await expect(
      transcodeToM4a("/in/a.mp3", "/out/a.m4a", spawnFn as never),
    ).resolves.toBeUndefined();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnFn.mock.calls[0]!;
    expect(cmd).toBe("ffmpeg");
    const a = args as string[];
    expect(a).toEqual(expect.arrayContaining(["-i", "/in/a.mp3", "/out/a.m4a"]));
    expect(a).toEqual(expect.arrayContaining(["-c:a", "aac"]));
    expect(a).toEqual(expect.arrayContaining(["-movflags", "+faststart"]));
    expect(a).toEqual(expect.arrayContaining(["-f", "mp4"]));
    expect(a).toContain("-vn");
  });

  it("rejects with the ffmpeg stderr tail on a non-zero exit", async () => {
    const { spawnFn } = fakeFf(1);
    await expect(transcodeToM4a("/in/a.mp3", "/out/a.m4a", spawnFn as never)).rejects.toThrow(
      /ffmpeg/i,
    );
  });
});
```

6. **Run it (expect FAIL).** `npx vitest run src/audio/format.test.ts`
   Expected: `TypeError: transcodeToM4a is not a function` (not yet exported).

7. **Minimal implementation — the transcode helper.** Append to `src/audio/format.ts`:

```ts
import { spawn as nodeSpawn } from "node:child_process";

export function transcodeToM4a(
  srcPath: string,
  destPath: string,
  spawnFn: typeof nodeSpawn = nodeSpawn,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      srcPath,
      "-vn", // audio only — drop any embedded cover-art video stream
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart", // moov atom up front so range requests work without a full read
      "-f",
      "mp4",
      destPath,
    ];
    const ff = spawnFn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let errTail = "";
    ff.stderr?.on("data", (d: Buffer) => {
      errTail = (errTail + d.toString()).slice(-2000);
    });
    ff.on("error", (err) => reject(err));
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg transcode failed (exit ${code}): ${errTail.trim()}`));
    });
  });
}
```

Move the `import { spawn as nodeSpawn } from "node:child_process";` to the top of the file with the other imports (one import block).

8. **Run it (expect PASS).** `npx vitest run src/audio/format.test.ts`
   Expected: all `chooseDelivery` + `transcodeToM4a` tests green, e.g. `Test Files 1 passed`, `Tests 11 passed`.

---

### Task 2.2: `GET /audio/:trackId` range route

The streaming route. Validates the `trackId` (= a YouTube `videoId`), ensures the audio file exists in the cache (download-if-missing through the semaphore, register + pin), decides delivery via `chooseDelivery`, transcodes once if needed (caching the transcoded `.m4a`), parses the `Range` header, and streams 200 (full) or 206 (partial) with `Accept-Ranges: bytes`, `Content-Length`, and (for 206) `Content-Range`. 404 when the track can't be resolved/downloaded; 416 on an unsatisfiable range.

**Files**

- Create: `src/audio/index.ts`
- Test: `src/audio/index.test.ts`

**Interfaces**

Consumes:

- Task 0.6 `src/cache/index.ts` — `AudioCache`:
  ```ts
  has(videoId: string): boolean;
  get(videoId: string): string | null;          // bumps LRU; returns filePath or null
  getAudio(videoId: string): AudioInfo | null;
  register(videoId: string, filePath: string, audio?: AudioInfo | null): void;
  pin(videoId: string): void;
  ```
- Task 0.4 `src/youtube/index.ts` — `YouTubeService`:
  ```ts
  download(videoId: string, outDir: string, opts?: DownloadOptions): Promise<DownloadResult>;
  // DownloadResult = { path: string; audio: AudioInfo | null }
  ```
- Task 0.3 `src/util/semaphore.ts` — `Semaphore`: `run<T>(fn: () => Promise<T> | T): Promise<T>`.
- Task 2.1 `src/audio/format.ts` — `chooseDelivery`, `transcodeToM4a`, `MIME_BY_EXT`.
- Task 0.1 `src/types/index.ts` — `trackId` is a `videoId`; `AudioInfo`.

Produces (`src/audio/index.ts`):

```ts
import type { FastifyInstance } from "fastify";
import type { AudioCache } from "../cache/index.js";
import type { YouTubeService } from "../youtube/index.js";
import type { Semaphore } from "../util/semaphore.js";

export interface AudioRouteDeps {
  cache: AudioCache;
  youtube: Pick<YouTubeService, "download">;
  cacheDir: string;
  downloads: Semaphore;
}

/** Registers GET /audio/:trackId on `app`. Standalone plugin; server/app.ts wires it. */
export function registerAudioRoute(app: FastifyInstance, deps: AudioRouteDeps): void;

/** Exported for unit testing. Parses an HTTP Range header against a known size.
 *  Returns null when there is no Range; {unsatisfiable:true} on a bad/out-of-bounds range. */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | { unsatisfiable: true } | null;
```

**Steps**

1. **Write the failing test — `parseRange` unit.** Create `src/audio/index.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioCache } from "../cache/index.js";
import { Semaphore } from "../util/semaphore.js";
import { registerAudioRoute, parseRange } from "./index.js";

describe("parseRange", () => {
  it("returns null when there is no Range header", () => {
    expect(parseRange(undefined, 1000)).toBeNull();
    expect(parseRange("", 1000)).toBeNull();
  });

  it("parses a bounded range", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=100-199", 1000)).toEqual({ start: 100, end: 199 });
  });

  it("clamps an open-ended range to the last byte", () => {
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
  });

  it("parses a suffix range (last N bytes)", () => {
    expect(parseRange("bytes=-200", 1000)).toEqual({ start: 800, end: 999 });
  });

  it("clamps an end past EOF to size-1", () => {
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("flags an unsatisfiable range (start >= size)", () => {
    expect(parseRange("bytes=1000-1100", 1000)).toEqual({ unsatisfiable: true });
  });

  it("flags malformed ranges as unsatisfiable", () => {
    expect(parseRange("bytes=abc-def", 1000)).toEqual({ unsatisfiable: true });
    expect(parseRange("bytes=50-10", 1000)).toEqual({ unsatisfiable: true }); // start > end
  });

  it("ignores multi-range requests (only the first byte-range form supported) -> unsatisfiable", () => {
    expect(parseRange("bytes=0-10,20-30", 1000)).toEqual({ unsatisfiable: true });
  });
});
```

2. **Run it (expect FAIL).** `npx vitest run src/audio/index.test.ts`
   Expected: `Failed to resolve import "./index.js"` — the module / `parseRange` export does not exist.

3. **Minimal implementation — `parseRange`.** Create `src/audio/index.ts` (just the parser + imports for now):

```ts
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AudioCache } from "../cache/index.js";
import type { YouTubeService } from "../youtube/index.js";
import type { Semaphore } from "../util/semaphore.js";
import { chooseDelivery, transcodeToM4a } from "./format.js";

export interface AudioRouteDeps {
  cache: AudioCache;
  youtube: Pick<YouTubeService, "download">;
  cacheDir: string;
  downloads: Semaphore;
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | { unsatisfiable: true } | null {
  if (!header) return null;
  const trimmed = header.trim();
  // Only the single-range "bytes=" form is supported. Anything else (multi-range,
  // other units) is treated as unsatisfiable so we don't silently mis-serve.
  const m = /^bytes=(\d*)-(\d*)$/.exec(trimmed);
  if (!m) return { unsatisfiable: true };
  const [, startRaw, endRaw] = m;
  if (startRaw === "" && endRaw === "") return { unsatisfiable: true };

  let start: number;
  let end: number;
  if (startRaw === "") {
    // suffix range: last N bytes
    const n = Number.parseInt(endRaw!, 10);
    if (n <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number.parseInt(startRaw, 10);
    end = endRaw === "" ? size - 1 : Number.parseInt(endRaw, 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { unsatisfiable: true };
  if (start >= size) return { unsatisfiable: true };
  if (start > end) return { unsatisfiable: true };
  if (end >= size) end = size - 1;
  return { start, end };
}
```

4. **Run it (expect PASS for `parseRange`).** `npx vitest run src/audio/index.test.ts -t parseRange`
   Expected: the `parseRange` describe block passes (`8 passed`). The route tests below don't exist yet.

5. **Write the failing test — bad trackId → 404 / 400, route registers.** Append the route harness + first test to `src/audio/index.test.ts`:

```ts
describe("GET /audio/:trackId", () => {
  let dir: string;
  let app: FastifyInstance;
  let cache: AudioCache;

  // 11-char valid YouTube id used across tests
  const ID = "dQw4w9WgXcQ";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "audio-"));
    cache = new AudioCache(dir, 10_000_000);
    await cache.init();
  });

  afterEach(async () => {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  });

  function build(youtube: { download: ReturnType<typeof vi.fn> }) {
    app = Fastify();
    registerAudioRoute(app, {
      cache,
      youtube: youtube as never,
      cacheDir: dir,
      downloads: new Semaphore(2),
    });
    return app;
  }

  it("404s when trackId is not a valid YouTube id (download never attempted)", async () => {
    const download = vi.fn();
    build({ download });
    const res = await app.inject({ method: "GET", url: "/audio/not-an-id" });
    expect(res.statusCode).toBe(404);
    expect(download).not.toHaveBeenCalled();
  });

  it("404s when the track cannot be downloaded (download throws)", async () => {
    const download = vi.fn().mockRejectedValue(new Error("unavailable"));
    build({ download });
    const res = await app.inject({ method: "GET", url: `/audio/${ID}` });
    expect(res.statusCode).toBe(404);
    expect(download).toHaveBeenCalledTimes(1);
  });
});
```

6. **Run it (expect FAIL).** `npx vitest run src/audio/index.test.ts -t "GET /audio"`
   Expected: `TypeError: registerAudioRoute ... is not a function` or `404` assertions fail because the route is not registered (Fastify returns 404 with no handler, but `download.not.toHaveBeenCalled` may pass by accident; the second test fails because download is never wired). Net: at least the second test fails / collection errors on the missing route logic.

7. **Implement — `ensureFile` + route skeleton (404 paths).** Append to `src/audio/index.ts`:

```ts
/**
 * Resolve a videoId to a ready-to-serve file path + Content-Type.
 * Downloads if missing (through the semaphore), registers+pins in the cache,
 * and transcodes once to a clean .m4a when the source isn't browser-playable.
 * Returns null when the track can't be produced (caller -> 404).
 */
async function ensureFile(
  deps: AudioRouteDeps,
  videoId: string,
): Promise<{ path: string; contentType: string } | null> {
  // Fast path: already cached.
  let path = deps.cache.get(videoId);
  let audio = deps.cache.getAudio(videoId);

  if (!path) {
    try {
      const result = await deps.downloads.run(() => deps.youtube.download(videoId, deps.cacheDir));
      deps.cache.register(videoId, result.path, result.audio);
      deps.cache.pin(videoId);
      path = result.path;
      audio = result.audio;
    } catch {
      return null;
    }
  }

  const ext = extname(path).replace(/^\./, "").toLowerCase();
  const delivery = chooseDelivery(audio, ext);
  if (!delivery.needsTranscode) {
    return { path, contentType: delivery.contentType };
  }

  // Transcode once to a sibling .m4a, then cache + pin THAT under a derived key so
  // the original key still maps to the (now superseded) source until evicted.
  const m4aKey = `${videoId}.m4a`;
  const cachedTranscode = deps.cache.get(m4aKey);
  if (cachedTranscode) {
    return { path: cachedTranscode, contentType: "audio/mp4" };
  }
  const destPath = join(deps.cacheDir, `${videoId}.transcoded.m4a`);
  try {
    await deps.downloads.run(() => transcodeToM4a(path!, destPath));
    deps.cache.register(m4aKey, destPath, { codec: "aac", bitrateKbps: 192, sampleRateHz: 48000 });
    deps.cache.pin(m4aKey);
    return { path: destPath, contentType: "audio/mp4" };
  } catch {
    return null;
  }
}

export function registerAudioRoute(app: FastifyInstance, deps: AudioRouteDeps): void {
  app.get<{ Params: { trackId: string } }>("/audio/:trackId", async (req, reply) => {
    const { trackId } = req.params;
    if (!VIDEO_ID_RE.test(trackId)) {
      return reply.code(404).send({ error: "not_found" });
    }
    const file = await ensureFile(deps, trackId);
    if (!file) {
      return reply.code(404).send({ error: "not_found" });
    }
    return serveFile(reply, file.path, file.contentType, req.headers.range);
  });
}
```

Add a temporary stub so the file compiles:

```ts
async function serveFile(
  reply: FastifyReply,
  _path: string,
  _contentType: string,
  _range: string | undefined,
): Promise<FastifyReply> {
  return reply.code(500).send({ error: "not_implemented" });
}
```

8. **Run it (expect PASS for the two 404 tests).** `npx vitest run src/audio/index.test.ts -t "GET /audio"`
   Expected: both 404 tests pass; `parseRange` still green.

9. **Write the failing test — full body (200) + content-type from a cached opus/webm file.** Append inside the `describe("GET /audio/:trackId")` block:

```ts
async function seedCached(id: string, ext: string, body: Buffer, codec = "opus") {
  const p = join(dir, `${id}.${ext}`);
  await writeFile(p, body);
  cache.register(id, p, { codec, bitrateKbps: 160, sampleRateHz: 48000 });
}

it("serves the full body (200) with Accept-Ranges + Content-Length + Content-Type", async () => {
  const body = Buffer.from("0123456789abcdef"); // 16 bytes
  await seedCached(ID, "webm", body);
  const download = vi.fn(); // must NOT be called — already cached
  build({ download });

  const res = await app.inject({ method: "GET", url: `/audio/${ID}` });
  expect(res.statusCode).toBe(200);
  expect(res.headers["accept-ranges"]).toBe("bytes");
  expect(res.headers["content-type"]).toBe("audio/webm");
  expect(res.headers["content-length"]).toBe("16");
  expect(res.rawPayload.equals(body)).toBe(true);
  expect(download).not.toHaveBeenCalled();
});
```

10. **Run it (expect FAIL).** `npx vitest run src/audio/index.test.ts -t "serves the full body"`
    Expected: `expected 500 to be 200` (the `serveFile` stub returns 500).

11. **Implement — `serveFile` full-body path.** Replace the `serveFile` stub in `src/audio/index.ts`:

```ts
async function serveFile(
  reply: FastifyReply,
  path: string,
  contentType: string,
  range: string | undefined,
): Promise<FastifyReply> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return reply.code(404).send({ error: "not_found" });
  }

  reply.header("Accept-Ranges", "bytes");
  reply.header("Content-Type", contentType);

  const parsed = parseRange(range, size);
  if (parsed && "unsatisfiable" in parsed) {
    reply.header("Content-Range", `bytes */${size}`);
    return reply.code(416).send({ error: "range_not_satisfiable" });
  }

  if (!parsed) {
    // Full body.
    reply.header("Content-Length", String(size));
    reply.code(200);
    return reply.send(createReadStream(path));
  }

  // Partial body.
  const { start, end } = parsed;
  reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
  reply.header("Content-Length", String(end - start + 1));
  reply.code(206);
  return reply.send(createReadStream(path, { start, end }));
}
```

12. **Run it (expect PASS).** `npx vitest run src/audio/index.test.ts -t "serves the full body"`
    Expected: 200 test green (correct content-type, length, body, no download).

13. **Write the failing test — partial body (206) + Content-Range; and 416 on a bad range.** Append:

```ts
it("serves a partial body (206) with Content-Range for a Range request", async () => {
  const body = Buffer.from("0123456789abcdef"); // 16 bytes
  await seedCached(ID, "webm", body);
  build({ download: vi.fn() });

  const res = await app.inject({
    method: "GET",
    url: `/audio/${ID}`,
    headers: { range: "bytes=4-9" },
  });
  expect(res.statusCode).toBe(206);
  expect(res.headers["content-range"]).toBe("bytes 4-9/16");
  expect(res.headers["content-length"]).toBe("6");
  expect(res.headers["accept-ranges"]).toBe("bytes");
  expect(res.rawPayload.equals(Buffer.from("456789"))).toBe(true);
});

it("416s with Content-Range bytes */size on an unsatisfiable range", async () => {
  const body = Buffer.from("0123456789abcdef"); // 16 bytes
  await seedCached(ID, "webm", body);
  build({ download: vi.fn() });

  const res = await app.inject({
    method: "GET",
    url: `/audio/${ID}`,
    headers: { range: "bytes=100-200" },
  });
  expect(res.statusCode).toBe(416);
  expect(res.headers["content-range"]).toBe("bytes */16");
});
```

14. **Run it (expect PASS — logic already implemented in step 11).** `npx vitest run src/audio/index.test.ts -t "partial body"` then `-t "unsatisfiable range"`
    Expected: both green. (These exercise the 206 + 416 branches already written; if either fails, the bug is in `serveFile`, fix there.)

15. **Write the failing test — download-if-missing path (resolve → register → pin → serve).** Append:

```ts
it("downloads, registers + pins, then serves when the track is not cached", async () => {
  const body = Buffer.from("transcode-me-not-opus"); // arbitrary bytes
  // download() writes the file into cacheDir and returns its real path + AudioInfo
  const download = vi.fn(async (videoId: string, outDir: string) => {
    const p = join(outDir, `${videoId}.webm`);
    await writeFile(p, body);
    return { path: p, audio: { codec: "opus", bitrateKbps: 160, sampleRateHz: 48000 } };
  });
  build({ download });

  expect(cache.has(ID)).toBe(false);
  const res = await app.inject({ method: "GET", url: `/audio/${ID}` });
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toBe("audio/webm");
  expect(res.rawPayload.equals(body)).toBe(true);
  expect(download).toHaveBeenCalledTimes(1);
  expect(download).toHaveBeenCalledWith(ID, dir);
  // registered + pinned: a second request must NOT re-download.
  expect(cache.has(ID)).toBe(true);
  const res2 = await app.inject({ method: "GET", url: `/audio/${ID}` });
  expect(res2.statusCode).toBe(200);
  expect(download).toHaveBeenCalledTimes(1);
});
```

16. **Run it (expect PASS — `ensureFile` already implements this in step 7).** `npx vitest run src/audio/index.test.ts -t "downloads, registers"`
    Expected: green — confirms the download-once + register + pin + second-request-from-cache behavior.

17. **Write the failing test — transcode path: non-playable source served as audio/mp4.** Append (inject a fake `transcodeToM4a` by spying on the module is heavy; instead seed a cached source whose codec forces a transcode and assert the route invokes ffmpeg via a mock at the `format` boundary). Use `vi.mock`:

```ts

```

Add at the TOP of `src/audio/index.test.ts` (module-level), before the imports of `./index.js`:

```ts
vi.mock("./format.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./format.js")>();
  return {
    ...actual,
    // Simulate a successful transcode by copying the source bytes to destPath,
    // so the route can stat + stream a real file without spawning ffmpeg.
    transcodeToM4a: vi.fn(async (src: string, dest: string) => {
      const { copyFile } = await import("node:fs/promises");
      await copyFile(src, dest);
    }),
  };
});
```

Then append the test:

```ts
it("transcodes a non-playable source and serves it as audio/mp4", async () => {
  const body = Buffer.from("fake-mp3-bytes");
  // mp3 codec in an mp3 container -> chooseDelivery returns needsTranscode:true
  await seedCached(ID, "mp3", body, "mp3");
  build({ download: vi.fn() });

  const res = await app.inject({ method: "GET", url: `/audio/${ID}` });
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toBe("audio/mp4");
  // body is the copied-through transcode output (our mock copies bytes 1:1)
  expect(res.rawPayload.equals(body)).toBe(true);

  const { transcodeToM4a } = await import("./format.js");
  expect(transcodeToM4a).toHaveBeenCalledTimes(1);

  // second request reuses the cached transcode (no second ffmpeg call)
  const res2 = await app.inject({
    method: "GET",
    url: `/audio/${ID}`,
    headers: { range: "bytes=0-3" },
  });
  expect(res2.statusCode).toBe(206);
  expect(res2.headers["content-type"]).toBe("audio/mp4");
  expect((transcodeToM4a as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
});
```

18. **Run it (expect PASS — transcode branch already implemented in step 7).** `npx vitest run src/audio/index.test.ts -t "transcodes a non-playable"`
    Expected: green — confirms one transcode, served as `audio/mp4`, range works on the transcoded file, no re-transcode on the second request. If the transcoded-file reuse fails, check the `m4aKey` reuse branch in `ensureFile`.

19. **Run the whole file (expect all PASS).** `npx vitest run src/audio/index.test.ts`
    Expected: `Test Files 1 passed`, all `parseRange` + route tests green (≈ 14 tests).

---

### Phase completion

This single task closes the phase: one full verification, one adversarial debug pass, one squash commit. **Do NOT commit in any earlier task.**

1. **Full verification (expect all green).** Run from the repo root:

```bash
npm run typecheck && npm run lint && npm run build && npm test
```

Expected output (shape):

- `tsc --noEmit` (typecheck) — no errors.
- `eslint .` — no errors/warnings (the `noUncheckedIndexedAccess` non-null assertions in `format.ts`/`index.ts` are intentional and pass).
- `tsc -p tsconfig.json` / `vite build` (build) — emits `dist/` with no errors.
- `vitest run` — `src/audio/format.test.ts` + `src/audio/index.test.ts` both pass; full suite green, e.g. `Test Files N passed`, `Tests M passed`.
  If anything is red, fix it before continuing — do not commit on red.

2. **Adversarial multi-agent debug pass.** Invoke the `/debug` flow over the files changed in this phase:
   - **Changed files:** `src/audio/format.ts`, `src/audio/format.test.ts`, `src/audio/index.ts`, `src/audio/index.test.ts`.
   - **Fan out finder agents**, one per file plus these reliability lenses applied across all four:
     - _Range/HTTP correctness:_ off-by-one in `Content-Range`/`Content-Length` (end inclusive), suffix-range `bytes=-N` with `N > size`, `bytes=0-` open range, `bytes=0-0` (1 byte), zero-length file, `start === size` boundary, multi-range rejection, header casing.
     - _Resource leaks:_ `createReadStream` not destroyed when the client aborts mid-stream; ffmpeg child not killed on a failed/abandoned transcode; partial `.transcoded.m4a` left on disk after a transcode error (should not be registered — verify `register` skips a missing/0-byte file per `statSyncSafe`).
     - _Concurrency:_ two simultaneous requests for the same uncached `trackId` both calling `download` (thundering herd) — is a per-videoId in-flight guard needed, or is double-download tolerable because `register` is idempotent? Confirm `Semaphore` bounds concurrency but does NOT dedupe; decide + document.
     - _Cache/path safety:_ `trackId` path traversal (guarded by `VIDEO_ID_RE` — verify the regex is anchored `^...$`), `extname` on a dotless filename, transcoded key (`<id>.m4a`) colliding with a real `videoId` cache key.
     - _Error mapping:_ `YtError` from `download` → 404 (not 500); `stat` race (file evicted between `cache.get` and `stat`) → 404 not a 500 crash.
   - **Adversarially verify each finding** with a failing test before fixing (write the red test, confirm it reproduces, then fix, then green). Reject findings that can't be reproduced.
   - **Fix all confirmed bugs**, re-running `npx vitest run src/audio/` after each fix, then re-run the full verification command from step 1 to confirm still-green.

3. **One squash commit for the whole phase.** After verification is green and all confirmed debug findings are fixed:

```bash
git add src/audio/format.ts src/audio/format.test.ts src/audio/index.ts src/audio/index.test.ts
git commit -m "$(cat <<'EOF'
feat(audio): GET /audio/:trackId range streaming route + delivery policy

Phase 2 — audio streaming. Adds the standalone src/audio/ plugin:
- format.ts: chooseDelivery(AudioInfo|null, ext) -> serve-as-is for
  opus/webm + aac/m4a (spec §8), else transcode to AAC .m4a (audio/mp4);
  transcodeToM4a ffmpeg helper (faststart mp4, injectable spawn).
- index.ts: registerAudioRoute — resolve trackId(=videoId) to a cached
  file (download-if-missing via Semaphore + YouTubeService.download,
  register+pin), parse Range, 200 full / 206 partial with
  Accept-Ranges/Content-Range/Content-Length, 404 unresolvable,
  416 unsatisfiable; parseRange unit-tested.

Parallel-safe module; wired into server/app.ts in phase 4.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

Per the one-commit-per-phase rule (overrides the skill's per-task default): exactly this one commit closes Phase 2. Do not push unless the user asks.

---

## Phase 3:Active-player, device memory & WS protocol — Active-player, device memory & WS protocol

**Goal:** Build the persisted device registry + active-player state machine (manual designate, auto-select remembered speaker, disconnect→null→preserve-paused) and the WS layer: `StationBroadcaster` (state to all subscribers), targeted player-command send (`load`/`play`/`pause`/`seek`/`setVolume` to the one active Player), and the client→server protocol (`hello`/`becomePlayer`/`relinquishPlayer`/`position`/`trackEnded`/`playbackError`) wired to the `StationController` sink + the `PlayerRegistry`.

### Parallelization

- **Parallel-safe (build first, disjoint from `ws.ts`):** `src/players/persist.ts` (Task 3.1) and `src/players/registry.ts` + `src/players/registry.test.ts` (Task 3.2). These touch only the `src/players/` directory and consume the already-frozen shared types (`DeviceRecord`, `DeviceRegistryFile` from §0.1) plus the `StationController` public surface (`attachSink`/`detachSink`/`resume`/`pause`/`snapshot` from §1.5). Two agents can own 3.1 and 3.2 concurrently — 3.2 imports 3.1, so the 3.2 agent stubs the persist signatures from this plan until 3.1 lands (the signatures are fixed below).
- **Sequential (shared hub — single owner, in order):** `src/server/ws.ts` is edited by **Task 3.3** (add the `StationBroadcaster` + origin helper) and then **Task 3.4** (add the `/ws` handler + protocol wiring). Do 3.3 fully, then 3.4, in the same file. Do **not** parallelize 3.3/3.4.
- **Coordination with Phase 1:** `src/orchestrator/index.ts` is only touched in this phase if `attachSink`/`detachSink` need an adjustment — none is expected (the Phase 1 `StationController` already exposes `attachSink(sink)`, `detachSink()`, `resume()`, `pause()`, `snapshot()`, and emits `'changed'`). If a mismatch surfaces during 3.2/3.4, fix it in Phase 1's file with a single coordinated edit and re-run Phase 1 tests; do not duplicate sink logic here.

---

### Task 3.1: Device registry persistence

**Files**

- Create: `src/players/persist.ts`
- Test: covered indirectly by `src/players/registry.test.ts` (3.2) and directly by inline cases added below; create `src/players/persist.test.ts`

**Interfaces**

- Consumes (from §0.1 `src/types/index.ts`):
  - `interface DeviceRecord { deviceId: string; label: string; lastSeen: number; isPreferredSpeaker: boolean }`
  - `interface DeviceRegistryFile { version: 1; savedAt: number; devices: DeviceRecord[] }`
- Produces:
  - `export async function writeDeviceRegistry(dir: string, file: DeviceRegistryFile): Promise<void>` — atomic `tmp`+`rename` into `${dir}/device-registry.json`.
  - `export async function readDeviceRegistry(dir: string): Promise<DeviceRegistryFile | null>` — tolerant (missing/corrupt → `null`) and version-guarded (`version === 1 && Array.isArray(devices)`).
  - `export const DEVICE_REGISTRY_FILE = "device-registry.json"` (the on-disk filename constant).

**Steps**

1. **Write the FAILING test (round-trip).** Create `src/players/persist.test.ts`:

   ```ts
   import { mkdtemp, readFile, rm } from "node:fs/promises";
   import { tmpdir } from "node:os";
   import { join } from "node:path";
   import { afterEach, beforeEach, describe, expect, it } from "vitest";
   import type { DeviceRegistryFile } from "../types/index.js";
   import { DEVICE_REGISTRY_FILE, readDeviceRegistry, writeDeviceRegistry } from "./persist.js";

   let dir: string;
   beforeEach(async () => {
     dir = await mkdtemp(join(tmpdir(), "lj-persist-"));
   });
   afterEach(async () => {
     await rm(dir, { recursive: true, force: true });
   });

   const sample: DeviceRegistryFile = {
     version: 1,
     savedAt: 1000,
     devices: [
       { deviceId: "d1", label: "Living Room PC", lastSeen: 900, isPreferredSpeaker: true },
       { deviceId: "d2", label: "Phone", lastSeen: 800, isPreferredSpeaker: false },
     ],
   };

   describe("device-registry persist", () => {
     it("writes then reads back the identical file", async () => {
       await writeDeviceRegistry(dir, sample);
       const back = await readDeviceRegistry(dir);
       expect(back).toEqual(sample);
     });

     it("writes to the documented filename", async () => {
       await writeDeviceRegistry(dir, sample);
       const raw = await readFile(join(dir, DEVICE_REGISTRY_FILE), "utf8");
       expect(JSON.parse(raw)).toEqual(sample);
     });
   });
   ```

2. **Run it — expect FAIL.** Command: `npx vitest run src/players/persist.test.ts`. Expected failure: `Failed to resolve import "./persist.js"` / `Cannot find module './persist.js'` (file does not exist yet).

3. **Minimal implementation (write + filename).** Create `src/players/persist.ts`:

   ```ts
   import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
   import { join } from "node:path";
   import type { DeviceRegistryFile } from "../types/index.js";

   export const DEVICE_REGISTRY_FILE = "device-registry.json";

   /** Atomic write: stage to a tmp sibling, then rename over the target. */
   export async function writeDeviceRegistry(dir: string, file: DeviceRegistryFile): Promise<void> {
     await mkdir(dir, { recursive: true });
     const target = join(dir, DEVICE_REGISTRY_FILE);
     const tmp = `${target}.tmp`;
     await writeFile(tmp, JSON.stringify(file));
     await rename(tmp, target); // atomic swap
   }

   export async function readDeviceRegistry(_dir: string): Promise<DeviceRegistryFile | null> {
     return null;
   }
   ```

4. **Run it — round-trip still fails, filename passes.** Command: `npx vitest run src/players/persist.test.ts`. Expected: the "writes to the documented filename" test PASSES; the "writes then reads back" test FAILS with `expected null to deeply equal { version: 1, ... }` (read is stubbed to `null`).

5. **Implement the tolerant, version-guarded read.** Replace the `readDeviceRegistry` body in `src/players/persist.ts`:

   ```ts
   export async function readDeviceRegistry(dir: string): Promise<DeviceRegistryFile | null> {
     try {
       const raw = await readFile(join(dir, DEVICE_REGISTRY_FILE), "utf8");
       const parsed = JSON.parse(raw) as DeviceRegistryFile;
       if (parsed.version === 1 && Array.isArray(parsed.devices)) return parsed;
       return null;
     } catch {
       return null;
     }
   }
   ```

6. **Run it — expect PASS.** Command: `npx vitest run src/players/persist.test.ts`. Expected: both tests PASS (`2 passed`).

7. **Write FAILING tolerance tests (missing file, corrupt JSON, wrong version).** Append to `src/players/persist.test.ts`:

   ```ts
   import { writeFile } from "node:fs/promises";

   describe("device-registry tolerant read", () => {
     it("returns null when the file is absent", async () => {
       expect(await readDeviceRegistry(dir)).toBeNull();
     });

     it("returns null on corrupt JSON", async () => {
       await writeFile(join(dir, DEVICE_REGISTRY_FILE), "{not json");
       expect(await readDeviceRegistry(dir)).toBeNull();
     });

     it("returns null on an unknown version", async () => {
       await writeFile(
         join(dir, DEVICE_REGISTRY_FILE),
         JSON.stringify({ version: 2, savedAt: 1, devices: [] }),
       );
       expect(await readDeviceRegistry(dir)).toBeNull();
     });
   });
   ```

8. **Run it — expect PASS.** Command: `npx vitest run src/players/persist.test.ts`. Expected: all 5 tests PASS — the implementation from step 5 already satisfies these (this confirms tolerance was implemented, not bolted on). If any FAIL, the `catch`/version guard is wrong; fix and re-run.

---

### Task 3.2: DeviceRegistry + PlayerStateMachine

**Files**

- Create: `src/players/registry.ts`
- Test: `src/players/registry.test.ts`

**Interfaces**

- Consumes:
  - 3.1: `writeDeviceRegistry(dir, file)`, `readDeviceRegistry(dir)`.
  - §0.1: `DeviceRecord`, `DeviceRegistryFile`, `AUTOPLAY_REQUESTER` (not used here), `StationSnapshot`.
  - §1.5: `StationController` — this module depends only on the narrow slice `Pick<StationController, "attachSink" | "detachSink" | "resume" | "pause" | "snapshot">`. `attachSink(sink: BrowserPlayerSink)` swaps the active audio sink; `detachSink()` clears it; `resume()`/`pause()` toggle playback; `snapshot(): StationSnapshot`.
  - §1.4: `BrowserPlayerSink` (the per-socket sink object passed into `claim`/`onConnect`). Treated structurally — registry only stores/forwards it to `station.attachSink`, plus calls `sink.relinquish()` on the previous player so it stops its `<audio>` (the sink emits the `relinquishPlayer`-equivalent server command). Type it as `interface SinkLike { relinquish(): void }` plus whatever `attachSink` accepts, intersected.
- Produces — `export class PlayerRegistry`:
  ```ts
  interface StationLike {
    attachSink(sink: BrowserPlayerSink): void;
    detachSink(): void;
    resume(): void;
    pause(): void;
    snapshot(): StationSnapshot;
  }
  interface PlayerRegistryDeps {
    dir: string;
    station: StationLike;
    now?: () => number; // injectable clock; defaults to Date.now
  }
  class PlayerRegistry {
    constructor(deps: PlayerRegistryDeps);
    init(): Promise<void>; // load persisted registry from dir
    touch(deviceId: string, label: string): void; // upsert lastSeen + label
    get activePlayerDeviceId(): string | null;
    get activePlayerLabel(): string | null; // label of the active device, or null
    claim(deviceId: string, sink: BrowserPlayerSink): void; // manual designate (WS path — needs the socket sink)
    release(deviceId: string): { activePlayerDeviceId: string | null }; // active device steps down (REST-callable, no sink)
    remember(deviceId: string): { activePlayerDeviceId: string | null }; // isPreferredSpeaker = true, persist (REST-callable)
    forget(deviceId: string): { activePlayerDeviceId: string | null }; // isPreferredSpeaker = false, persist (REST-callable)
    onConnect(deviceId: string, sink: BrowserPlayerSink): void; // auto-select if preferred & none active
    onDisconnect(deviceId: string): void; // active -> null, station preserved paused
    isSpeaker(deviceId: string): boolean;
  }
  ```
  > `claim` requires the per-socket `BrowserPlayerSink`, so it is reachable only from the WS `becomePlayer` handler (Task 3.4) — NOT from REST (`/api/speaker` has no socket sink). `release`/`remember`/`forget` need no sink and return `{ activePlayerDeviceId }`, so they back BOTH the WS handler and the REST `/api/speaker` route (Task 4.2). The REST "claim" action is therefore satisfied by the UI sending the WS `becomePlayer` frame, not a REST call.
  ```ts

  ```
  **Invariant:** at most one active player. Every `claim`/`onConnect`-that-auto-selects first relinquishes the previous active sink (`prevSink.relinquish()`) and calls `station.detachSink()` before `station.attachSink(newSink)`.

**Steps**

1. **Write FAILING test — touch upserts a device.** Create `src/players/registry.test.ts`:

   ```ts
   import { mkdtemp, rm } from "node:fs/promises";
   import { tmpdir } from "node:os";
   import { join } from "node:path";
   import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
   import type { StationSnapshot } from "../types/index.js";
   import { readDeviceRegistry } from "./persist.js";
   import { PlayerRegistry } from "./registry.js";

   function makeStation() {
     return {
       attachSink: vi.fn(),
       detachSink: vi.fn(),
       resume: vi.fn(),
       pause: vi.fn(),
       snapshot: vi.fn<[], StationSnapshot>(),
     };
   }
   function makeSink() {
     return { relinquish: vi.fn() };
   }

   let dir: string;
   beforeEach(async () => {
     dir = await mkdtemp(join(tmpdir(), "lj-registry-"));
   });
   afterEach(async () => {
     await rm(dir, { recursive: true, force: true });
   });

   describe("PlayerRegistry.touch", () => {
     it("upserts a device with label + lastSeen and persists it", async () => {
       const reg = new PlayerRegistry({ dir, station: makeStation(), now: () => 5000 });
       await reg.init();
       reg.touch("d1", "Living Room PC");
       const file = await readDeviceRegistry(dir);
       expect(file?.devices).toEqual([
         { deviceId: "d1", label: "Living Room PC", lastSeen: 5000, isPreferredSpeaker: false },
       ]);
     });
   });
   ```

2. **Run it — expect FAIL.** Command: `npx vitest run src/players/registry.test.ts`. Expected: `Cannot find module './registry.js'`.

3. **Minimal implementation — constructor/init/touch + persist.** Create `src/players/registry.ts`:

   ```ts
   import type { DeviceRecord, DeviceRegistryFile, StationSnapshot } from "../types/index.js";
   import { readDeviceRegistry, writeDeviceRegistry } from "./persist.js";

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
       void writeDeviceRegistry(this.dir, this.toFile());
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

     claim(_deviceId: string, _sink: RegistrySink): void {}
     release(_deviceId: string): { activePlayerDeviceId: string | null } {
       return { activePlayerDeviceId: this._activeDeviceId };
     }
     remember(_deviceId: string): { activePlayerDeviceId: string | null } {
       return { activePlayerDeviceId: this._activeDeviceId };
     }
     forget(_deviceId: string): { activePlayerDeviceId: string | null } {
       return { activePlayerDeviceId: this._activeDeviceId };
     }
     onConnect(_deviceId: string, _sink: RegistrySink): void {}
     onDisconnect(_deviceId: string): void {}
     isSpeaker(deviceId: string): boolean {
       return this._activeDeviceId === deviceId;
     }
   }
   ```

   > Note: `BrowserPlayerSink` (§1.4) is structurally compatible with `RegistrySink` (it exposes `relinquish()`); 3.4 passes the real sink. `persist()` is fire-and-forget (`void`) so `touch` stays synchronous per the interface.

4. **Run it — expect PASS.** Command: `npx vitest run src/players/registry.test.ts`. Expected: the touch test PASSES (`1 passed`).

5. **Write FAILING test — manual `claim` designates and loads.** Append:

   ```ts
   describe("PlayerRegistry.claim (manual designate)", () => {
     it("attaches the new sink, resumes, and exposes the active device + label", async () => {
       const station = makeStation();
       const reg = new PlayerRegistry({ dir, station, now: () => 1 });
       await reg.init();
       reg.touch("d1", "Speaker PC");
       const sink = makeSink();
       reg.claim("d1", sink);
       expect(reg.activePlayerDeviceId).toBe("d1");
       expect(reg.activePlayerLabel).toBe("Speaker PC");
       expect(reg.isSpeaker("d1")).toBe(true);
       expect(station.attachSink).toHaveBeenCalledWith(sink);
       expect(station.resume).toHaveBeenCalledTimes(1);
     });

     it("tells the previous player to relinquish and detaches before reattaching", async () => {
       const station = makeStation();
       const reg = new PlayerRegistry({ dir, station, now: () => 1 });
       await reg.init();
       const sinkA = makeSink();
       const sinkB = makeSink();
       reg.claim("dA", sinkA);
       reg.claim("dB", sinkB);
       expect(sinkA.relinquish).toHaveBeenCalledTimes(1);
       expect(sinkB.relinquish).not.toHaveBeenCalled();
       expect(station.detachSink).toHaveBeenCalled();
       expect(reg.activePlayerDeviceId).toBe("dB");
       expect(reg.isSpeaker("dA")).toBe(false);
     });
   });
   ```

6. **Run it — expect FAIL.** Command: `npx vitest run src/players/registry.test.ts`. Expected: FAIL — `expected "spy" to be called with arguments: [ {...} ]` / `expected null to be 'd1'` (claim is a no-op stub).

7. **Implement `claim`.** Replace the `claim` stub in `src/players/registry.ts`:

   ```ts
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
   ```

8. **Run it — expect PASS.** Command: `npx vitest run src/players/registry.test.ts`. Expected: all claim tests PASS.

9. **Write FAILING test — `release` clears + preserves paused, `remember`/`forget` persist.** Append:

   ```ts
   describe("PlayerRegistry.release / remember / forget", () => {
     it("release clears the active player and pauses the station (preserved)", async () => {
       const station = makeStation();
       const reg = new PlayerRegistry({ dir, station, now: () => 1 });
       await reg.init();
       const sink = makeSink();
       reg.claim("d1", sink);
       reg.release("d1");
       expect(reg.activePlayerDeviceId).toBeNull();
       expect(reg.activePlayerLabel).toBeNull();
       expect(sink.relinquish).toHaveBeenCalledTimes(1);
       expect(station.detachSink).toHaveBeenCalled();
       expect(station.pause).toHaveBeenCalled();
     });

     it("release by a non-active device is a no-op", async () => {
       const station = makeStation();
       const reg = new PlayerRegistry({ dir, station, now: () => 1 });
       await reg.init();
       reg.claim("d1", makeSink());
       station.pause.mockClear();
       reg.release("dX");
       expect(reg.activePlayerDeviceId).toBe("d1");
       expect(station.pause).not.toHaveBeenCalled();
     });

     it("remember sets isPreferredSpeaker and persists; forget clears it", async () => {
       const reg = new PlayerRegistry({ dir, station: makeStation(), now: () => 7 });
       await reg.init();
       reg.touch("d1", "PC");
       reg.remember("d1");
       expect((await readDeviceRegistry(dir))?.devices[0]?.isPreferredSpeaker).toBe(true);
       reg.forget("d1");
       expect((await readDeviceRegistry(dir))?.devices[0]?.isPreferredSpeaker).toBe(false);
     });
   });
   ```

10. **Run it — expect FAIL.** Command: `npx vitest run src/players/registry.test.ts`. Expected: FAIL — `expected "spy" to be called` (pause/detach not invoked) and `expected undefined to be true` (remember is a stub).

11. **Implement `release`, `remember`, `forget`.** Replace those three stubs in `src/players/registry.ts`:

    ```ts
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
    ```

    > The return value powers the REST `/api/speaker` response (`SpeakerResponse { ok, activePlayerDeviceId }`, Task 4.2); the WS handler ignores it. `remember`/`forget` of an unknown device is a no-op that still reports the current active player.

12. **Run it — expect PASS.** Command: `npx vitest run src/players/registry.test.ts`. Expected: all release/remember/forget tests PASS.

13. **Write FAILING test — `onConnect` auto-selects a remembered speaker only when none active.** Append:

    ```ts
    describe("PlayerRegistry.onConnect (auto-select device memory)", () => {
      it("auto-designates a preferred speaker when no player is active", async () => {
        const station = makeStation();
        const reg = new PlayerRegistry({ dir, station, now: () => 1 });
        await reg.init();
        reg.touch("d1", "Speaker PC");
        reg.remember("d1");
        const sink = makeSink();
        reg.onConnect("d1", sink);
        expect(reg.activePlayerDeviceId).toBe("d1");
        expect(station.attachSink).toHaveBeenCalledWith(sink);
        expect(station.resume).toHaveBeenCalled();
      });

      it("does NOT auto-select a non-preferred device", async () => {
        const station = makeStation();
        const reg = new PlayerRegistry({ dir, station, now: () => 1 });
        await reg.init();
        reg.touch("d2", "Phone");
        reg.onConnect("d2", makeSink());
        expect(reg.activePlayerDeviceId).toBeNull();
        expect(station.attachSink).not.toHaveBeenCalled();
      });

      it("does NOT steal the player when one is already active", async () => {
        const station = makeStation();
        const reg = new PlayerRegistry({ dir, station, now: () => 1 });
        await reg.init();
        reg.touch("d1", "Speaker PC");
        reg.remember("d1");
        reg.touch("d3", "Other PC");
        reg.remember("d3");
        reg.claim("d3", makeSink()); // d3 already playing
        station.attachSink.mockClear();
        reg.onConnect("d1", makeSink()); // d1 preferred, but a player is active
        expect(reg.activePlayerDeviceId).toBe("d3");
        expect(station.attachSink).not.toHaveBeenCalled();
      });

      it("survives a restart: init() reloads isPreferredSpeaker so the next connect auto-selects", async () => {
        const station1 = makeStation();
        const reg1 = new PlayerRegistry({ dir, station: station1, now: () => 1 });
        await reg1.init();
        reg1.touch("d1", "Speaker PC");
        reg1.remember("d1");
        // fresh process
        const station2 = makeStation();
        const reg2 = new PlayerRegistry({ dir, station: station2, now: () => 2 });
        await reg2.init();
        reg2.onConnect("d1", makeSink());
        expect(reg2.activePlayerDeviceId).toBe("d1");
        expect(station2.attachSink).toHaveBeenCalled();
      });
    });
    ```

14. **Run it — expect FAIL.** Command: `npx vitest run src/players/registry.test.ts`. Expected: FAIL — `expected null to be 'd1'` (onConnect is a no-op stub).

15. **Implement `onConnect`.** Replace the stub in `src/players/registry.ts`:

    ```ts
      onConnect(deviceId: string, sink: RegistrySink): void {
        const rec = this.devices.get(deviceId);
        if (!rec || !rec.isPreferredSpeaker) return; // not a remembered speaker
        if (this._activeDeviceId !== null) return; // a player is already active
        // Auto-designate: same path as a manual claim.
        this.claim(deviceId, sink);
      }
    ```

16. **Run it — expect PASS.** Command: `npx vitest run src/players/registry.test.ts`. Expected: all onConnect tests PASS.

17. **Write FAILING test — `onDisconnect` nulls the active player and preserves a paused station.** Append:

    ```ts
    describe("PlayerRegistry.onDisconnect", () => {
      it("active player disconnect -> null + station paused (preserved)", async () => {
        const station = makeStation();
        const reg = new PlayerRegistry({ dir, station, now: () => 1 });
        await reg.init();
        reg.claim("d1", makeSink());
        station.detachSink.mockClear();
        reg.onDisconnect("d1");
        expect(reg.activePlayerDeviceId).toBeNull();
        expect(station.detachSink).toHaveBeenCalled();
        expect(station.pause).toHaveBeenCalled();
      });

      it("does NOT relinquish on disconnect (the socket is already gone)", async () => {
        const reg = new PlayerRegistry({ dir, station: makeStation(), now: () => 1 });
        await reg.init();
        const sink = makeSink();
        reg.claim("d1", sink);
        sink.relinquish.mockClear();
        reg.onDisconnect("d1");
        expect(sink.relinquish).not.toHaveBeenCalled();
      });

      it("disconnect of a non-active device is a no-op", async () => {
        const station = makeStation();
        const reg = new PlayerRegistry({ dir, station, now: () => 1 });
        await reg.init();
        reg.claim("d1", makeSink());
        station.pause.mockClear();
        reg.onDisconnect("dX");
        expect(reg.activePlayerDeviceId).toBe("d1");
        expect(station.pause).not.toHaveBeenCalled();
      });
    });
    ```

18. **Run it — expect FAIL.** Command: `npx vitest run src/players/registry.test.ts`. Expected: FAIL — `expected 'd1' to be null` (onDisconnect is a no-op stub).

19. **Implement `onDisconnect`.** Replace the stub in `src/players/registry.ts`:

    ```ts
      onDisconnect(deviceId: string): void {
        if (this._activeDeviceId !== deviceId) return;
        // The socket is already closed: do NOT call relinquish() (would throw / no-op).
        if (this._activeDeviceId !== null) this.station.detachSink();
        this.activeSink = null;
        this._activeDeviceId = null;
        this.station.pause(); // preserve seed/current/position; resumes on reconnect via onConnect
      }
    ```

20. **Run it — expect PASS.** Command: `npx vitest run src/players/registry.test.ts`. Expected: all disconnect tests PASS (whole file green, e.g. `12 passed`).

---

### Task 3.3: StationBroadcaster + targeted player send

**Files**

- Create: `src/server/ws.ts` (the broadcaster portion only; the `/ws` handler is added in 3.4)
- Test: `src/server/ws.test.ts` (broadcaster unit cases; the `boot()` WS integration cases come in 3.4)

**Interfaces**

- Consumes:
  - §0.1: `StationSnapshot`, `ServerBroadcastMessage` (`{type:'state',state}` | `{type:'trackError',...}`), `ServerPlayerMessage` (`load`/`play`/`pause`/`seek`/`setVolume`), `ServerWsMessage = ServerBroadcastMessage | ServerPlayerMessage`.
  - §1.5: `StationController` — emits `'changed'` and exposes `snapshot(): StationSnapshot`.
- Produces:
  ```ts
  export type Send = (m: ServerWsMessage) => void;
  export function isAllowedOrigin(origin: string | undefined, allowed: readonly string[]): boolean;
  export class StationBroadcaster {
    subscribe(send: Send): void;
    unsubscribe(send: Send): void;
    broadcast(msg: ServerBroadcastMessage): void; // to all subscribers
    attach(station: StationLike): void; // wire station 'changed' -> broadcast state
  }
  ```
  Targeted player send is NOT a broadcaster method — a single active Player's `Send` is held by the registry's sink (3.2/3.4); `ServerPlayerMessage`s go straight down that one socket. The broadcaster only fans out `ServerBroadcastMessage`.

**Steps**

1. **Write FAILING test — origin allow-list helper.** Create `src/server/ws.test.ts`:

   ```ts
   import { describe, expect, it, vi } from "vitest";
   import type { StationSnapshot } from "../types/index.js";
   import { isAllowedOrigin, StationBroadcaster, type Send } from "./ws.js";

   const SNAP: StationSnapshot = {
     repeat: "off",
     autoplay: true,
     autoplaySource: "radio",
     volume: 100,
     maxTrackDurationSec: 0,
     current: null,
     upcoming: [],
     upcomingRadio: [],
     history: [],
     seed: null,
     paused: true,
     preparing: null,
     activePlayerPresent: false,
     activePlayerLabel: null,
   };

   describe("isAllowedOrigin", () => {
     it("accepts an exact match", () => {
       expect(isAllowedOrigin("https://radio.example.com", ["https://radio.example.com"])).toBe(
         true,
       );
     });
     it("rejects a mismatch and undefined", () => {
       expect(isAllowedOrigin("https://evil.example", ["https://radio.example.com"])).toBe(false);
       expect(isAllowedOrigin(undefined, ["https://radio.example.com"])).toBe(false);
     });
   });
   ```

2. **Run it — expect FAIL.** Command: `npx vitest run src/server/ws.test.ts`. Expected: `Cannot find module './ws.js'`.

3. **Minimal implementation — origin helper + empty broadcaster.** Create `src/server/ws.ts`:

   ```ts
   import type {
     ServerBroadcastMessage,
     ServerWsMessage,
     StationSnapshot,
   } from "../types/index.js";

   export type Send = (m: ServerWsMessage) => void;

   export function isAllowedOrigin(
     origin: string | undefined,
     allowed: readonly string[],
   ): boolean {
     return !!origin && allowed.includes(origin);
   }

   export interface StationLike {
     snapshot(): StationSnapshot;
     on(event: "changed", listener: () => void): unknown;
   }

   export class StationBroadcaster {
     private readonly subs = new Set<Send>();
     private attached = false;

     subscribe(_send: Send): void {}
     unsubscribe(_send: Send): void {}
     broadcast(_msg: ServerBroadcastMessage): void {}
     attach(_station: StationLike): void {}
   }
   ```

4. **Run it — expect PASS.** Command: `npx vitest run src/server/ws.test.ts`. Expected: both `isAllowedOrigin` tests PASS.

5. **Write FAILING test — subscribe/broadcast/unsubscribe fan-out.** Append:

   ```ts
   describe("StationBroadcaster fan-out", () => {
     it("broadcasts to every subscriber and stops after unsubscribe", () => {
       const b = new StationBroadcaster();
       const a = vi.fn<Parameters<Send>, void>();
       const c = vi.fn<Parameters<Send>, void>();
       b.subscribe(a);
       b.subscribe(c);
       b.broadcast({ type: "trackError", videoId: "v1", title: "T", reason: "blocked" });
       expect(a).toHaveBeenCalledWith({
         type: "trackError",
         videoId: "v1",
         title: "T",
         reason: "blocked",
       });
       expect(c).toHaveBeenCalledTimes(1);
       b.unsubscribe(a);
       b.broadcast({ type: "trackError", videoId: "v2", title: "T2", reason: "x" });
       expect(a).toHaveBeenCalledTimes(1); // not called again
       expect(c).toHaveBeenCalledTimes(2);
     });
   });
   ```

6. **Run it — expect FAIL.** Command: `npx vitest run src/server/ws.test.ts`. Expected: FAIL — `expected "spy" to be called with arguments` (subscribe/broadcast are no-ops).

7. **Implement subscribe/unsubscribe/broadcast.** Replace those three method bodies in `src/server/ws.ts`:

   ```ts
     subscribe(send: Send): void {
       this.subs.add(send);
     }
     unsubscribe(send: Send): void {
       this.subs.delete(send);
     }
     broadcast(msg: ServerBroadcastMessage): void {
       for (const send of this.subs) send(msg);
     }
   ```

8. **Run it — expect PASS.** Command: `npx vitest run src/server/ws.test.ts`. Expected: fan-out test PASSES.

9. **Write FAILING test — `attach` wires `'changed'` to a state broadcast, once.** Append:

   ```ts
   import { EventEmitter } from "node:events";

   describe("StationBroadcaster.attach", () => {
     it("broadcasts {type:'state'} on each station 'changed', once per attach", () => {
       const station = new EventEmitter() as EventEmitter & { snapshot: () => StationSnapshot };
       station.snapshot = () => SNAP;
       const b = new StationBroadcaster();
       const sub = vi.fn<Parameters<Send>, void>();
       b.subscribe(sub);
       b.attach(station as never);
       b.attach(station as never); // idempotent — must not double-wire
       station.emit("changed");
       expect(sub).toHaveBeenCalledTimes(1);
       expect(sub).toHaveBeenCalledWith({ type: "state", state: SNAP });
     });
   });
   ```

10. **Run it — expect FAIL.** Command: `npx vitest run src/server/ws.test.ts`. Expected: FAIL — `expected "spy" to be called 1 times, but got 0` (attach is a no-op).

11. **Implement `attach` (idempotent).** Replace the `attach` body in `src/server/ws.ts`:

    ```ts
      attach(station: StationLike): void {
        if (this.attached) return;
        this.attached = true;
        station.on("changed", () => {
          this.broadcast({ type: "state", state: station.snapshot() });
        });
      }
    ```

12. **Run it — expect PASS.** Command: `npx vitest run src/server/ws.test.ts`. Expected: whole file green (`5 passed`).

---

### Task 3.4: /ws handler wiring protocol to registry + sink

**Files**

- Modify: `src/server/ws.ts` (add `registerWebsocket`)
- Test: `src/server/ws.test.ts` (add `boot()` integration cases against a mock Player)

**Interfaces**

- Consumes:
  - 3.3: `StationBroadcaster`, `isAllowedOrigin`, `Send`.
  - 3.2: `PlayerRegistry` (`touch`/`onConnect`/`claim`/`release`/`onDisconnect`/`isSpeaker`/`activePlayerDeviceId`).
  - §1.4: `BrowserPlayerSink` — created per active socket; `setSend(send)` points the sink's outbound `ServerPlayerMessage`s at this socket; `emit('trackEnd')` / `emit('error', msg)` feed the station; `relinquish()` tells the browser to stop.
  - §0.1: `ClientWsMessage` (`hello`/`becomePlayer`/`relinquishPlayer`/`position`/`trackEnded`/`playbackError`), `ServerPlayerMessage`.
  - §0.5 (config): `allowedWsOrigins` (the resolved `[publicBaseUrl]` array).
- Produces:
  ```ts
  export interface WsDeps {
    broadcaster: StationBroadcaster;
    registry: PlayerRegistry;
    allowedOrigins: readonly string[];
    makeSink: (send: Send) => BrowserPlayerSink; // factory injected from the composition root
    station: StationLike & { reportPosition(ms: number): void };
  }
  export function registerWebsocket(app: FastifyInstance, deps: WsDeps): void;
  ```
  Behavior: `onRequest` origin 403 guard for `/ws`; `/ws` requires `req.session.authed` (close `1008`); each socket gets a `Send` (`socket.send(JSON.stringify(m))`) and a per-socket sink (`deps.makeSink(send)`); handlers — `hello{deviceId}` → `registry.touch(deviceId, label)` + `registry.onConnect(deviceId, sink)` (auto-select); `becomePlayer` → `registry.claim(deviceId, sink)`; `relinquishPlayer` → `registry.release(deviceId)`; `position{ms}` → `station.reportPosition(ms)`; `trackEnded` → `sink.emit('trackEnd')`; `playbackError{message}` → `sink.emit('error', new Error(message))`; `close` → `registry.onDisconnect(deviceId)` + `broadcaster.unsubscribe(send)`. **No 30s revalidation interval.** Every subscriber gets an immediate `{type:'state'}` after a successful `hello`.

**Steps**

1. **Write FAILING test — origin 403 + unauthenticated close.** Append to `src/server/ws.test.ts` a `boot()` helper that builds a minimal Fastify app with `@fastify/websocket` registered, a fake session decorator, the broadcaster/registry/sink wired, then opens a real client socket via the `ws` package:

   ```ts
   import Fastify, { type FastifyInstance } from "fastify";
   import fastifyWebsocket from "@fastify/websocket";
   import WebSocket from "ws";
   import { afterEach, beforeEach } from "vitest";
   import { PlayerRegistry } from "../players/registry.js";
   import { registerWebsocket, type Send } from "./ws.js";

   // Minimal sink stub matching BrowserPlayerSink's structural surface used by the handler.
   function makeFakeSinkFactory() {
     const sinks: Array<{
       send: Send;
       emit: ReturnType<typeof vi.fn>;
       relinquish: ReturnType<typeof vi.fn>;
     }> = [];
     const factory = (send: Send) => {
       const sink = { send, emit: vi.fn(), relinquish: vi.fn(), setSend: vi.fn() };
       sinks.push(sink);
       return sink as never;
     };
     return { factory, sinks };
   }

   async function boot(opts: { authed: boolean }) {
     const app = Fastify();
     await app.register(fastifyWebsocket);
     // fake session: decorate request.session before the ws handler runs
     app.addHook("onRequest", async (req) => {
       (
         req as { session?: { authed?: boolean; deviceId?: string; displayName?: string } }
       ).session = {
         authed: opts.authed,
         deviceId: "d1",
         displayName: "PC",
       };
     });
     const station = Object.assign(new EventEmitter(), {
       snapshot: () => SNAP,
       attachSink: vi.fn(),
       detachSink: vi.fn(),
       resume: vi.fn(),
       pause: vi.fn(),
       reportPosition: vi.fn(),
     });
     const b = new StationBroadcaster();
     const registry = new PlayerRegistry({ dir: ".", station: station as never, now: () => 1 });
     await registry.init();
     const sinkFactory = makeFakeSinkFactory();
     registerWebsocket(app as never, {
       broadcaster: b,
       registry,
       allowedOrigins: ["http://localhost"],
       makeSink: sinkFactory.factory,
       station: station as never,
     });
     await app.listen({ port: 0, host: "127.0.0.1" });
     const addr = app.server.address();
     const port = typeof addr === "object" && addr ? addr.port : 0;
     return { app, url: `ws://127.0.0.1:${port}/ws`, station, registry, sinkFactory };
   }

   describe("registerWebsocket integration", () => {
     let h: Awaited<ReturnType<typeof boot>> | null = null;
     afterEach(async () => {
       await h?.app.close();
       h = null;
     });

     it("rejects a bad Origin with 403 (handshake fails)", async () => {
       h = await boot({ authed: true });
       const ws = new WebSocket(h.url, { headers: { origin: "https://evil.example" } });
       const code = await new Promise<number | string>((resolve) => {
         ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
         ws.on("error", (e) => resolve(String(e)));
         ws.on("open", () => resolve("open"));
       });
       expect(code).toBe(403);
     });

     it("closes an unauthenticated socket with 1008", async () => {
       h = await boot({ authed: false });
       const ws = new WebSocket(h.url, { headers: { origin: "http://localhost" } });
       const closeCode = await new Promise<number>((resolve) => {
         ws.on("close", (c) => resolve(c));
       });
       expect(closeCode).toBe(1008);
     });
   });
   ```

2. **Run it — expect FAIL.** Command: `npx vitest run src/server/ws.test.ts`. Expected: FAIL — `registerWebsocket is not a function` / `Cannot read properties of undefined` (the export does not exist yet).

3. **Minimal implementation — exports, origin guard, auth gate.** Add to `src/server/ws.ts` the imports and the skeleton handler:

   ```ts
   import type { FastifyInstance, FastifyRequest } from "fastify";
   import type { WebSocket as WsWebSocket } from "@fastify/websocket";
   import type { ClientWsMessage } from "../types/index.js";
   import type { PlayerRegistry } from "../players/registry.js";
   import type { BrowserPlayerSink } from "../orchestrator/browser-player-sink.js";

   export interface WsDeps {
     broadcaster: StationBroadcaster;
     registry: PlayerRegistry;
     allowedOrigins: readonly string[];
     makeSink: (send: Send) => BrowserPlayerSink;
     station: StationLike & { reportPosition(ms: number): void };
   }

   export function registerWebsocket(app: FastifyInstance, deps: WsDeps): void {
     app.addHook("onRequest", async (req, reply) => {
       if (req.url.startsWith("/ws")) {
         if (!isAllowedOrigin(req.headers.origin, deps.allowedOrigins)) {
           await reply.code(403).send({ error: "bad_origin" });
         }
       }
     });

     deps.broadcaster.attach(deps.station);

     app.get("/ws", { websocket: true }, (socket: WsWebSocket, req: FastifyRequest) => {
       const session = req.session as
         { authed?: boolean; deviceId?: string; displayName?: string } | undefined;
       if (!session?.authed) {
         socket.close(1008, "unauthenticated");
         return;
       }
       const deviceId = session.deviceId ?? "unknown";
       const label = session.displayName ?? deviceId;
       const send: Send = (m) => socket.send(JSON.stringify(m));
       const sink = deps.makeSink(send);

       deps.broadcaster.subscribe(send);
       send({ type: "state", state: deps.station.snapshot() });

       socket.on("message", (raw: Buffer) => {
         let parsed: unknown;
         try {
           parsed = JSON.parse(raw.toString());
         } catch {
           return;
         }
         if (typeof parsed !== "object" || parsed === null) return;
         const msg = parsed as ClientWsMessage;
         switch (msg.type) {
           case "hello":
             deps.registry.touch(deviceId, label);
             deps.registry.onConnect(deviceId, sink);
             break;
           case "becomePlayer":
             deps.registry.claim(deviceId, sink);
             break;
           case "relinquishPlayer":
             deps.registry.release(deviceId);
             break;
           case "position":
             deps.station.reportPosition(msg.ms);
             break;
           case "trackEnded":
             sink.emit("trackEnd");
             break;
           case "playbackError":
             sink.emit("error", new Error(msg.message));
             break;
         }
       });

       socket.on("close", () => {
         deps.registry.onDisconnect(deviceId);
         deps.broadcaster.unsubscribe(send);
       });
     });
   }
   ```

   > `BrowserPlayerSink` (§1.4) extends `EventEmitter`, so `sink.emit("trackEnd")` / `sink.emit("error", err)` are the documented sink events. The composition root supplies `makeSink` so the sink can target the per-socket `send`.

4. **Run it — expect PASS (guard + auth tests).** Command: `npx vitest run src/server/ws.test.ts`. Expected: the 403 and 1008 tests PASS (broadcaster unit tests from 3.3 still PASS).

5. **Write FAILING test — `hello` touches + auto-selects + sends initial state.** Append inside the integration `describe`:

   ```ts
   function openHello(url: string): Promise<WebSocket> {
     return new Promise((resolve, reject) => {
       const ws = new WebSocket(url, { headers: { origin: "http://localhost" } });
       ws.on("open", () => {
         ws.send(JSON.stringify({ type: "hello", deviceId: "d1", role: "remote" }));
         resolve(ws);
       });
       ws.on("error", reject);
     });
   }

   it("hello touches the device, runs auto-select, and the socket received an initial state", async () => {
     h = await boot({ authed: true });
     const seen: unknown[] = [];
     const ws = await openHello(h.url);
     ws.on("message", (d) => seen.push(JSON.parse(d.toString())));
     await new Promise((r) => setTimeout(r, 50));
     // touch persisted the device with the session label
     expect(h.registry.activePlayerDeviceId).toBeNull(); // d1 not preferred yet -> no auto-select
     // initial state frame was pushed on subscribe
     ws.close();
     await new Promise((r) => setTimeout(r, 20));
     expect(seen.some((m) => (m as { type?: string }).type === "state")).toBe(true);
   });

   it("becomePlayer claims the active player and attaches the socket sink", async () => {
     h = await boot({ authed: true });
     const ws = await openHello(h.url);
     ws.send(JSON.stringify({ type: "becomePlayer" }));
     await new Promise((r) => setTimeout(r, 50));
     expect(h.registry.activePlayerDeviceId).toBe("d1");
     expect(h.station.attachSink).toHaveBeenCalledWith(h.sinkFactory.sinks[0]);
     ws.close();
   });

   it("trackEnded emits 'trackEnd' on the per-socket sink", async () => {
     h = await boot({ authed: true });
     const ws = await openHello(h.url);
     ws.send(JSON.stringify({ type: "trackEnded" }));
     await new Promise((r) => setTimeout(r, 50));
     expect(h.sinkFactory.sinks[0]?.emit).toHaveBeenCalledWith("trackEnd");
     ws.close();
   });

   it("position telemetry reaches station.reportPosition", async () => {
     h = await boot({ authed: true });
     const ws = await openHello(h.url);
     ws.send(JSON.stringify({ type: "position", ms: 4242 }));
     await new Promise((r) => setTimeout(r, 50));
     expect(h.station.reportPosition).toHaveBeenCalledWith(4242);
     ws.close();
   });

   it("close runs onDisconnect + unsubscribe (no further broadcasts to the dead socket)", async () => {
     h = await boot({ authed: true });
     const ws = await openHello(h.url);
     ws.send(JSON.stringify({ type: "becomePlayer" }));
     await new Promise((r) => setTimeout(r, 30));
     ws.close();
     await new Promise((r) => setTimeout(r, 50));
     expect(h.registry.activePlayerDeviceId).toBeNull(); // disconnect nulled the active player
   });
   ```

6. **Run it — expect PASS.** Command: `npx vitest run src/server/ws.test.ts`. Expected: all integration tests PASS — the step-3 implementation already covers `hello`/`becomePlayer`/`trackEnded`/`position`/`close`. If `becomePlayer` fails because the sink instance differs, confirm `makeSink` is called once per socket (cache the sink in the handler closure, as written).

7. **Write FAILING test — `relinquishPlayer` releases.** Append:

   ```ts
   it("relinquishPlayer releases the active player back to null", async () => {
     h = await boot({ authed: true });
     const ws = await openHello(h.url);
     ws.send(JSON.stringify({ type: "becomePlayer" }));
     await new Promise((r) => setTimeout(r, 30));
     expect(h.registry.activePlayerDeviceId).toBe("d1");
     ws.send(JSON.stringify({ type: "relinquishPlayer" }));
     await new Promise((r) => setTimeout(r, 30));
     expect(h.registry.activePlayerDeviceId).toBeNull();
     ws.close();
   });
   ```

8. **Run it — expect PASS.** Command: `npx vitest run src/server/ws.test.ts`. Expected: PASS (the `relinquishPlayer` case in the step-3 switch already calls `registry.release`). This case exists to lock the behavior against regressions.

9. **Write FAILING test — no revalidation interval leaks a timer.** Append:

   ```ts
   it("registers no recurring interval (no 30s revalidation)", async () => {
     const spy = vi.spyOn(global, "setInterval");
     h = await boot({ authed: true });
     const ws = await openHello(h.url);
     await new Promise((r) => setTimeout(r, 30));
     // Only Fastify/ws internals may set intervals; our handler must add none keyed to /ws auth.
     const ourIntervals = spy.mock.calls.filter(([, ms]) => ms === 30000 || ms === 30_000);
     expect(ourIntervals).toHaveLength(0);
     ws.close();
     spy.mockRestore();
   });
   ```

10. **Run it — expect PASS.** Command: `npx vitest run src/server/ws.test.ts`. Expected: PASS (we never call `setInterval`). This is a guard that the deleted bot's 30s revalidation did not creep back in.

11. **Run the whole Phase-3 surface together.** Command: `npx vitest run src/players/ src/server/ws.test.ts`. Expected: all Phase-3 test files green (persist + registry + ws).

---

### Task 3.5: Phase completion — full verification, adversarial /debug, single squash commit

**Files**

- No new source files. Final gate + one commit for the whole phase.

**Steps**

1. **Run the full verification suite.** Command:

   ```bash
   npm run typecheck && npm run lint && npm run build && npm test
   ```

   Expected green output (shape):
   - `tsc --noEmit -p tsconfig.json` → no output, exit 0.
   - `eslint .` → no output (or `0 problems`), exit 0.
   - `tsc -p tsconfig.json` + `vite build` → `dist/` emitted, web bundle written, exit 0.
   - `vitest run` → all suites pass, e.g. `Test Files  N passed (N)` / `Tests  M passed (M)`, exit 0.
     If any step fails, fix it and re-run the FULL command before proceeding — do not commit on a partial pass.

2. **Run an adversarial multi-agent `/debug` pass over the phase's changed files.** Fan out finder agents across `src/players/persist.ts`, `src/players/registry.ts`, `src/server/ws.ts` (and their tests), one agent per reliability lens, then adversarially verify every finding before fixing. Lenses to assign:
   - **Single-active-player invariant:** can two sockets ever both be the active player? Check the `claim` while a different device is already active (must `stepDownActive` first), `onConnect` racing a `becomePlayer`, and same-device re-claim with a _new_ socket/sink (a page reload: same `deviceId`, fresh `send`/sink — `claim` must replace the stale sink, not early-return on the `deviceId === active` branch while the sink differs).
   - **Disconnect/relinquish asymmetry:** `onDisconnect` must NOT call `sink.relinquish()` (socket already gone), but `claim`/`release` MUST relinquish the previous/own sink. Verify `release` of a non-active device and double-`onDisconnect` are no-ops.
   - **Persistence durability:** `writeDeviceRegistry` atomicity (tmp+rename on the same filesystem/dir), `readDeviceRegistry` tolerance (missing/corrupt/wrong-version → null), and that fire-and-forget `persist()` in `touch`/`remember`/`forget` cannot drop a write under rapid successive calls (last-write-wins is acceptable; a lost `remember` is not — verify the in-memory map is updated synchronously so a later read after `init()` reflects it).
   - **WS auth/origin ordering:** origin 403 guard fires for `/ws` before the upgrade; the `1008` close path runs when `session.authed` is falsy; the subscribe-after-close race (close handler runs `unsubscribe`; ensure no orphaned `send` remains in the broadcaster if the socket closes during/just after `hello`).
   - **Broadcast safety:** iterating `this.subs` while a `send` throws (one dead socket must not abort the fan-out to the rest); `attach` idempotency (no double-wired `'changed'` listener leaking duplicate state frames).
   - **Resource/lifecycle:** no `setInterval`/timer left running per socket (the deleted 30s revalidation); listeners on the per-socket sink are cleaned up on close so a long-lived station EventEmitter doesn't accumulate dead sink listeners.
     For each confirmed bug, write a failing regression test first, then fix, then re-run that test plus `npm test`. Discard findings that adversarial verification cannot reproduce. Re-run the full step-1 command after all fixes; it must be green.

3. **Make EXACTLY ONE squash commit for the entire phase** (per the project's one-commit-per-phase-after-debug rule; this overrides the skill's per-task commit default). Commands:
   ```bash
   git add -A
   git commit -m "$(cat <<'EOF'
   Phase 3: active-player registry, device memory & WS protocol

   - players/persist.ts: atomic device-registry.json read/write (tolerant, version-guarded)
   - players/registry.ts: PlayerRegistry state machine — manual claim/release, auto-select
     remembered speaker on connect, disconnect -> null + preserve-paused, single-active invariant
   - server/ws.ts: StationBroadcaster (state fan-out + 'changed' wiring) and the /ws handler
     (origin 403 guard, session 1008 gate, hello/becomePlayer/relinquish/position/trackEnded/
     playbackError wired to the registry + per-socket BrowserPlayerSink); no revalidation interval
   - tests: persist round-trip/tolerance, registry designate/auto-select/disconnect, ws
     origin/auth/protocol integration against a mock Player

   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   EOF
   )"
   ```
   Expected: a single new commit containing only the Phase-3 files. Verify with `git show --stat HEAD` that the changed-files list is exactly `src/players/persist.ts`, `src/players/persist.test.ts`, `src/players/registry.ts`, `src/players/registry.test.ts`, `src/server/ws.ts`, `src/server/ws.test.ts` (plus any regression-test edits from step 2). Do **not** push unless the user asks.

---

## Phase 4:Auth & REST API — Auth & REST API

**Goal:** Shared-password auth (login/logout, timing-safe compare, session-fixation fix) + a `requireSession` guard (single shared password — anyone authenticated may control everything); the flat de-guilded REST surface (state/add/pick/control/speaker/lyrics) with the bot's hardened error-mapping; and `buildApp` wiring cookie/session/websocket/static + `/healthz` + SPA fallback + the audio route + ws; finally the composition root `main()`.

### Parallelization

- **Parallel-safe (build first, nothing else touches it):** `src/auth/password.ts` (+ `password.test.ts`) — Task 4.1. It only consumes `WebConfig`, `MemorySessionStore`, and the `LoginRequest`/`SessionInfo` types + the Fastify `Session` augmentation, all from earlier phases. No other Phase-4 file writes to it.
- **Sequential (shared hubs — parallel edits clobber):** `src/server/rest.ts` (Task 4.2) **then** `src/server/app.ts` (Task 4.3) **then** `src/index.ts` (Task 4.4). `rest.ts` consumes 4.1; `app.ts` consumes 4.1 + 4.2; `index.ts` consumes 4.3. Do these strictly in order, one editor at a time.

All backend files are ESM/NodeNext: relative imports use the `.js` extension. Strict TS, `noUncheckedIndexedAccess`. Test command for a single file: `npx vitest run <path>`.

---

### Task 4.1: Shared-password auth

**Files**

- Create: `src/auth/password.ts`
- Test: `src/auth/password.test.ts`

**Interfaces**

Consumes:

- `WebConfig` from `../config.js` — fields used: `viewerPassword: string`, `allowNoPassword: boolean`.
- `MemorySessionStore` from `./session-store.js` (already verbatim from Phase 0.6) — only relevant here because `req.sessionStore.destroy(oldId, cb)` is called after `regenerate()`.
- From `../types/index.js`: `LoginRequest { password; displayName; deviceId }`, `SessionInfo { displayName; deviceId }`, and the `declare module "fastify"` Session augmentation (`authed?`, `displayName?`, `deviceId?`).

Produces (exact signatures):

```ts
export function verifyPassword(input: string, expected: string): boolean;
export function registerAuthRoutes(app: FastifyInstance, cfg: WebConfig): void;
export async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<boolean>;
export function sessionInfo(req: FastifyRequest): SessionInfo | null;
```

Behavior:

- `POST /api/login` `{ password, displayName, deviceId }` → verify against `cfg.viewerPassword` (timing-safe). On success: `await req.session.regenerate()` (fixation fix), destroy the old store entry, set `session.authed = true`, `session.displayName`, `session.deviceId`. Returns `SessionInfo`.
- `POST /api/logout` → `await req.session.destroy()`, clear the `sid` cookie, `204`.
- `requireSession` → `401 { error: "unauthenticated" }` when `!session.authed`. Single shared password: any authenticated user may perform any action (no admin/elevation tier).
- `sessionInfo` → `null` when not authed, else `{ displayName, deviceId }`.

#### Steps

1. **Write failing test — `verifyPassword` is correct and length-guarded.** Create `src/auth/password.test.ts`:

   ```ts
   import { describe, it, expect } from "vitest";
   import { verifyPassword } from "./password.js";

   describe("verifyPassword", () => {
     it("returns true for an exact match", () => {
       expect(verifyPassword("hunter2", "hunter2")).toBe(true);
     });
     it("returns false for a mismatch of equal length", () => {
       expect(verifyPassword("hunterX", "hunter2")).toBe(false);
     });
     it("returns false (no throw) when lengths differ", () => {
       expect(verifyPassword("short", "a-much-longer-password")).toBe(false);
     });
     it("returns false for an empty input against a real password", () => {
       expect(verifyPassword("", "hunter2")).toBe(false);
     });
   });
   ```

2. **Run it — expect FAIL.** `npx vitest run src/auth/password.test.ts`
   Expected: fails to resolve / `Cannot find module './password.js'` (file does not exist yet).

3. **Minimal implementation — `verifyPassword`.** Create `src/auth/password.ts`:

   ```ts
   import { timingSafeEqual } from "node:crypto";
   import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
   import type { WebConfig } from "../config.js";
   import type { LoginRequest, SessionInfo } from "../types/index.js";

   /**
    * Constant-time string comparison. timingSafeEqual throws on unequal lengths, so we
    * guard with Buffer.byteLength first and return false (a length mismatch is already a
    * non-match; the early return leaks only length, never content).
    */
   export function verifyPassword(input: string, expected: string): boolean {
     const a = Buffer.from(input, "utf8");
     const b = Buffer.from(expected, "utf8");
     if (a.length !== b.length) return false;
     return timingSafeEqual(a, b);
   }
   ```

4. **Run it — expect PASS.** `npx vitest run src/auth/password.test.ts`
   Expected: 4 passed.

5. **Write failing test — login verifies, regenerates, sets session.** Append to `password.test.ts`. Use a real Fastify app wired exactly like `buildApp` will wire it (cookie + session + the routes) so the session roundtrip is real:

   ```ts
   import Fastify, { type FastifyInstance } from "fastify";
   import cookie from "@fastify/cookie";
   import session from "@fastify/session";
   import { MemorySessionStore } from "./session-store.js";
   import { registerAuthRoutes, requireSession, sessionInfo } from "./password.js";
   import type { WebConfig } from "../config.js";

   function cfg(over: Partial<WebConfig> = {}): WebConfig {
     return {
       publicBaseUrl: "https://j",
       viewerPassword: "letmein",
       allowNoPassword: false,
       sessionSecret: "x".repeat(32),
       port: 8080,
       host: "0.0.0.0",
       allowedWsOrigins: ["https://j"],
       nodeEnv: "test",
       secureCookies: false,
       ...over,
     };
   }

   async function buildAuthApp(c: WebConfig): Promise<FastifyInstance> {
     const app = Fastify({ logger: false });
     await app.register(cookie);
     await app.register(session, {
       secret: c.sessionSecret,
       cookieName: "sid",
       store: new MemorySessionStore({ sweepMs: 0 }) as never,
       saveUninitialized: false,
       rolling: true,
       cookie: { path: "/", httpOnly: true, secure: false, sameSite: "lax", maxAge: 1000 },
     });
     registerAuthRoutes(app, c);
     // A probe route to exercise requireSession/sessionInfo behind the same session.
     app.get("/probe/session", async (req, reply) => {
       if (!(await requireSession(req, reply))) return;
       return reply.send({ info: sessionInfo(req) });
     });
     return app;
   }

   function sid(res: { headers: Record<string, unknown> }): string {
     const set = res.headers["set-cookie"];
     const raw = Array.isArray(set) ? (set[0] as string) : (set as string);
     return raw.split(";")[0]!; // "sid=<value>"
   }

   describe("registerAuthRoutes /api/login", () => {
     it("accepts the right password, sets the session, returns SessionInfo", async () => {
       const app = await buildAuthApp(cfg());
       const res = await app.inject({
         method: "POST",
         url: "/api/login",
         payload: { password: "letmein", displayName: "Ada", deviceId: "dev-1" },
       });
       expect(res.statusCode).toBe(200);
       expect(res.json()).toEqual({ displayName: "Ada", deviceId: "dev-1" });
       expect(res.headers["set-cookie"]).toBeTruthy();
       await app.close();
     });

     it("rejects a wrong password with 401 and no session cookie value persists", async () => {
       const app = await buildAuthApp(cfg());
       const res = await app.inject({
         method: "POST",
         url: "/api/login",
         payload: { password: "WRONG", displayName: "Ada", deviceId: "dev-1" },
       });
       expect(res.statusCode).toBe(401);
       expect(res.json().error).toBe("invalid_password");
       await app.close();
     });

     it("rejects a missing displayName/deviceId with 400", async () => {
       const app = await buildAuthApp(cfg());
       const res = await app.inject({
         method: "POST",
         url: "/api/login",
         payload: { password: "letmein", displayName: "", deviceId: "" },
       });
       expect(res.statusCode).toBe(400);
       await app.close();
     });
   });
   ```

6. **Run it — expect FAIL.** `npx vitest run src/auth/password.test.ts`
   Expected: the `verifyPassword` block still passes; the new block fails — `registerAuthRoutes is not a function` / `requireSession is not exported`.

7. **Implement `registerAuthRoutes` + `sessionInfo` + `requireSession`.** Append to `password.ts`:

   ```ts
   export function sessionInfo(req: FastifyRequest): SessionInfo | null {
     const s = req.session;
     if (!s.authed || !s.deviceId || !s.displayName) return null;
     return { displayName: s.displayName, deviceId: s.deviceId };
   }

   export async function requireSession(
     req: FastifyRequest,
     reply: FastifyReply,
   ): Promise<boolean> {
     if (req.session.authed === true) return true;
     await reply.code(401).send({ error: "unauthenticated" });
     return false;
   }

   export function registerAuthRoutes(app: FastifyInstance, cfg: WebConfig): void {
     app.post<{ Body: Partial<LoginRequest> }>("/api/login", async (req, reply) => {
       const password = (req.body?.password ?? "").toString();
       const displayName = (req.body?.displayName ?? "").toString().trim();
       const deviceId = (req.body?.deviceId ?? "").toString().trim();
       if (!displayName || !deviceId) {
         return reply.code(400).send({ error: "displayName and deviceId are required" });
       }
       if (!verifyPassword(password, cfg.viewerPassword)) {
         return reply.code(401).send({ error: "invalid_password" });
       }
       // Rotate the session id to defeat fixation, then destroy the consumed pre-login
       // record. regenerate() replaces req.session in place but leaves the old store entry,
       // so capture its id first and destroy it explicitly.
       const oldId = req.session.sessionId;
       await req.session.regenerate();
       if (oldId && oldId !== req.session.sessionId) {
         await new Promise<void>((res) => req.sessionStore.destroy(oldId, () => res()));
       }
       req.session.authed = true;
       req.session.displayName = displayName;
       req.session.deviceId = deviceId;
       return reply.send({ displayName, deviceId } satisfies SessionInfo);
     });

     app.post("/api/logout", async (req, reply) => {
       await req.session.destroy();
       return reply.clearCookie("sid", { path: "/" }).code(204).send();
     });
   }
   ```

8. **Run it — expect PASS.** `npx vitest run src/auth/password.test.ts`
   Expected: all login + verifyPassword tests pass.

9. **Write failing test — session guard + logout.** Append:

   ```ts
   describe("requireSession + logout", () => {
     async function login(app: FastifyInstance, c = cfg()): Promise<string> {
       const res = await app.inject({
         method: "POST",
         url: "/api/login",
         payload: { password: c.viewerPassword, displayName: "Ada", deviceId: "dev-1" },
       });
       expect(res.statusCode).toBe(200);
       return sid(res);
     }

     it("requireSession 401s when logged out, 200s when logged in", async () => {
       const app = await buildAuthApp(cfg());
       expect((await app.inject({ method: "GET", url: "/probe/session" })).statusCode).toBe(401);
       const cookie = await login(app);
       const res = await app.inject({ method: "GET", url: "/probe/session", headers: { cookie } });
       expect(res.statusCode).toBe(200);
       expect(res.json().info).toEqual({ displayName: "Ada", deviceId: "dev-1" });
       await app.close();
     });

     it("logout destroys the session (subsequent guarded call 401s)", async () => {
       const app = await buildAuthApp(cfg());
       const cookie = await login(app);
       const out = await app.inject({ method: "POST", url: "/api/logout", headers: { cookie } });
       expect(out.statusCode).toBe(204);
       const after = await app.inject({
         method: "GET",
         url: "/probe/session",
         headers: { cookie },
       });
       expect(after.statusCode).toBe(401);
       await app.close();
     });
   });
   ```

10. **Run it — expect PASS.** `npx vitest run src/auth/password.test.ts`
    Expected: all auth tests green (verifyPassword + login + session-guard/logout).

---

### Task 4.2: Flat REST routes

**Files**

- Create: `src/server/rest.ts`
- Test: `src/server/rest.test.ts`

**Interfaces**

Consumes:

- `requireSession`, `sessionInfo` from `../auth/password.js` (4.1).
- `StationController` from `../orchestrator/index.js` (1.5) — methods used (exact names per Task 1.5): `snapshot(): StationSnapshot`, `enqueue(meta, requester): Promise<QueueItem>` (returns the QueueItem whose `.id` the route surfaces), `pause()`, `resume()`, `skip()`, `seek(ms): Promise<boolean>`, `setVolume(pct): StationSettings`, `shuffle(rng?): Promise<void>`, `clear(): Promise<void>`, `remove(itemId): Promise<boolean>`, `reorder(itemId, toIndex): Promise<boolean>`, `jump(itemId): Promise<boolean>`, `updateSettings(patch): StationSettings` (repeat is set via `updateSettings({ repeat })` — there is NO separate `setRepeat`). The seed is set inside `enqueue` for `source:"user"` adds (there is no `setSeed`).
- `RadioEngine` from `../radio/index.js` (1.6) — `reset(): void` (clears the recent-history de-dup window; invoked when a user adds a track so the fresh seed gets a clean run). There is NO `reseed` method — the seed itself is set inside `StationController.enqueue` for `source:"user"` adds; the REST layer only triggers the radio's window `reset()`.
- `PlayerRegistry` from `../players/registry.js` (3.2) — `isSpeaker(deviceId): boolean`, `activePlayerDeviceId: string | null`, and the REST-callable (sink-free) `release(deviceId)`/`remember(deviceId)`/`forget(deviceId)`, each returning `{ activePlayerDeviceId: string | null }`. `claim` is NOT REST-callable (it needs the per-socket sink); the UI claims the player via the WS `becomePlayer` frame (Task 3.4).
- `YouTubeService` (0.4): `resolve(videoId): Promise<TrackMeta>`, `search(q, n): Promise<TrackMeta[]>`; `parseInput` from `../youtube/url-parser.js`; `YtError` from `../youtube/errors.js`; `fetchLyrics` + `LyricsResult` from `../youtube/lyrics.js`.
- REST DTOs from `../types/index.js`: `AddRequest`, `AddResponse`, `PickRequest`, `PickResponse`, `ControlRequest`, `ControlResponse`, `ControlAction`, `SpeakerRequest`, `SpeakerResponse`, `SpeakerAction`, `LyricsResult`, `StationStateResponse`, `Requester`, `TrackMeta`, `RepeatMode`, `StationSettings`.
- `WebConfig` from `../config.js` (carried on `RestDeps` for surface symmetry; the single shared password means no per-route admin/elevation gating).

Produces (exact signature):

```ts
export interface RestDeps {
  station: StationController;
  youtube: Pick<YouTubeService, "resolve" | "search">;
  lyrics?: (meta: TrackMeta) => Promise<LyricsResult>;
  registry: PlayerRegistry;
  searchLimit: number;
  cfg: WebConfig;
}
export function registerRest(app: FastifyInstance, deps: RestDeps): void;
```

Routes & error idioms (preserved from the bot):

- `GET /api/state` → `StationStateResponse` = `station.snapshot()` + `isThisDeviceSpeaker: registry.isSpeaker(session.deviceId)`.
- `POST /api/add` `{ urlOrQuery }`: `input.length > 2000` → `400`; `parseInput` → `reject` → `400 { error: reason }`; `query` → `{ candidates }` (YtError → `400 { error: kind }`); `link` → resolve+enqueue (the seed is set inside `enqueue`; then `radio.reset()` clears the de-dup window) → `{ queued: { id, title } }`. Resolve YtError → `400 { error: kind }`; enqueue YtError → `400 { error: message }`; other enqueue failure → `500 { error: "enqueue_failed" }`.
- `POST /api/pick` `{ candidateId }`: validate 11-char videoId else `400`; enqueue (same idioms as add-link).
- `POST /api/control` `{ action, value? }`: `requireSession` (any authenticated user may control — single shared password, no elevation tier). Validate per-action value: `seek` value must be a non-negative finite number, `409` nothing playing, `400` out-of-range; `volume` 0..VOLUME_MAX; `repeat` ∈ RepeatMode; `remove`/`jump` require `itemId` (400 if missing); `reorder` requires `itemId` + non-negative integer `toIndex`; `settings` → `updateSettings(patch)`. Returns `{ ok }`.
- `POST /api/speaker` `{ action }`: `requireSession`; dispatch `release`/`remember`/`forget` keyed on the session deviceId; returns `SpeakerResponse { ok, activePlayerDeviceId }`. The `claim` action is `400`ed here — claiming the Player is the WS `becomePlayer` path (it needs the per-socket sink).
- `GET /api/lyrics?trackId=`: `requireSession`; if no current track → `{ lyrics: null, source: "lyrics.ovh" }`; else `lyricsOf(current.meta)`.

#### Steps

1. **Write failing test — state requires a session and returns the snapshot + isThisDeviceSpeaker.** Create `src/server/rest.test.ts` with a fake controller/registry, mounted behind a real session so the auth guards run:

   ```ts
   import { describe, it, expect, vi, beforeEach } from "vitest";
   import Fastify, { type FastifyInstance } from "fastify";
   import cookie from "@fastify/cookie";
   import session from "@fastify/session";
   import { MemorySessionStore } from "../auth/session-store.js";
   import { registerAuthRoutes } from "../auth/password.js";
   import { registerRest, type RestDeps } from "./rest.js";
   import { YtError } from "../youtube/errors.js";
   import type { WebConfig } from "../config.js";

   const meta = (id: string, title = id) => ({
     videoId: id,
     title,
     channel: "c",
     durationSec: 100,
     isLive: false,
     thumbnailUrl: null,
   });

   function cfg(over: Partial<WebConfig> = {}): WebConfig {
     return {
       publicBaseUrl: "https://j",
       viewerPassword: "letmein",
       allowNoPassword: false,
       sessionSecret: "x".repeat(32),
       port: 8080,
       host: "0.0.0.0",
       allowedWsOrigins: ["https://j"],
       nodeEnv: "test",
       secureCookies: false,
       ...over,
     };
   }

   function fakeStation() {
     return {
       snapshot: vi.fn(() => ({
         repeat: "off",
         autoplay: true,
         autoplaySource: "radio",
         volume: 100,
         maxTrackDurationSec: 0,
         current: null,
         upcoming: [],
         upcomingRadio: [],
         history: [],
         seed: null,
         paused: false,
         preparing: null,
         activePlayerPresent: false,
         activePlayerLabel: null,
       })),
       enqueue: vi.fn(async () => ({ id: "i1" })),
       pause: vi.fn(),
       resume: vi.fn(),
       skip: vi.fn(),
       seek: vi.fn(async () => true),
       setVolume: vi.fn(),
       shuffle: vi.fn(async () => {}),
       clear: vi.fn(async () => {}),
       remove: vi.fn(async () => true),
       reorder: vi.fn(async () => true),
       jump: vi.fn(async () => true),
       updateSettings: vi.fn((p: Record<string, unknown>) => ({
         repeat: "off",
         autoplay: true,
         autoplaySource: "radio",
         volume: 100,
         maxTrackDurationSec: 0,
         ...p,
       })),
     };
   }
   function fakeRegistry() {
     // REST /api/speaker reaches only the sink-free actions; claim is WS-only (needs a socket sink).
     return {
       activePlayerDeviceId: null as string | null,
       isSpeaker: vi.fn((d: string) => d === "dev-1"),
       release: vi.fn(() => ({ activePlayerDeviceId: null })),
       remember: vi.fn((d: string) => ({ activePlayerDeviceId: d })),
       forget: vi.fn(() => ({ activePlayerDeviceId: null })),
     };
   }
   function fakeRadio() {
     return { reset: vi.fn() };
   }

   async function build(over: Partial<RestDeps> = {}, c = cfg()) {
     const station = fakeStation();
     const registry = fakeRegistry();
     const youtube = {
       resolve: vi.fn(async (id: string) => meta(id)),
       search: vi.fn(async () => [meta("aaaaaaaaaaa")]),
     };
     const app = Fastify({ logger: false });
     await app.register(cookie);
     await app.register(session, {
       secret: c.sessionSecret,
       cookieName: "sid",
       store: new MemorySessionStore({ sweepMs: 0 }) as never,
       saveUninitialized: false,
       rolling: true,
       cookie: { path: "/", httpOnly: true, secure: false, sameSite: "lax", maxAge: 1000 },
     });
     registerAuthRoutes(app, c);
     const deps = {
       station,
       youtube,
       registry,
       radio: fakeRadio(),
       searchLimit: 5,
       cfg: c,
       ...over,
     } as unknown as RestDeps;
     registerRest(app, deps);
     return { app, station, registry, youtube, deps };
   }

   async function login(app: FastifyInstance, c = cfg(), deviceId = "dev-1"): Promise<string> {
     const res = await app.inject({
       method: "POST",
       url: "/api/login",
       payload: { password: c.viewerPassword, displayName: "Ada", deviceId },
     });
     const set = res.headers["set-cookie"];
     const raw = Array.isArray(set) ? (set[0] as string) : (set as string);
     return raw.split(";")[0]!;
   }

   describe("GET /api/state", () => {
     it("401s when logged out", async () => {
       const { app } = await build();
       expect((await app.inject({ method: "GET", url: "/api/state" })).statusCode).toBe(401);
       await app.close();
     });
     it("returns the snapshot + isThisDeviceSpeaker for the session device", async () => {
       const { app, registry } = await build();
       const c = await login(app);
       const res = await app.inject({ method: "GET", url: "/api/state", headers: { cookie: c } });
       expect(res.statusCode).toBe(200);
       const body = res.json();
       expect(body.seed).toBeNull();
       expect(body.isThisDeviceSpeaker).toBe(true);
       expect(registry.isSpeaker).toHaveBeenCalledWith("dev-1");
       await app.close();
     });
   });
   ```

2. **Run it — expect FAIL.** `npx vitest run src/server/rest.test.ts`
   Expected: `Cannot find module './rest.js'` / `registerRest is not a function`.

3. **Implement the skeleton + `GET /api/state`.** Create `src/server/rest.ts`:

   ```ts
   import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
   import { parseInput } from "../youtube/url-parser.js";
   import { YtError } from "../youtube/errors.js";
   import { fetchLyrics, type LyricsResult } from "../youtube/lyrics.js";
   import { requireSession, sessionInfo } from "../auth/password.js";
   import type { YouTubeService } from "../youtube/index.js";
   import type { StationController } from "../orchestrator/index.js";
   import type { RadioEngine } from "../radio/index.js";
   import type { PlayerRegistry } from "../players/registry.js";
   import type { WebConfig } from "../config.js";
   import {
     AUTOPLAY_REQUESTER,
     VOLUME_MAX,
     type Requester,
     type TrackMeta,
     type RepeatMode,
     type StationSettings,
     type ControlAction,
     type SpeakerAction,
     type SpeakerResponse,
     type StationStateResponse,
   } from "../types/index.js";

   export interface RestDeps {
     station: StationController;
     youtube: Pick<YouTubeService, "resolve" | "search">;
     lyrics?: (meta: TrackMeta) => Promise<LyricsResult>;
     registry: PlayerRegistry;
     radio: Pick<RadioEngine, "reset">;
     searchLimit: number;
     cfg: WebConfig;
   }

   const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
   const REPEAT_MODES: ReadonlySet<string> = new Set<RepeatMode>(["off", "one", "all"]);

   export function registerRest(app: FastifyInstance, deps: RestDeps): void {
     const lyricsOf = deps.lyrics ?? fetchLyrics;

     app.get("/api/state", async (req, reply) => {
       if (!(await requireSession(req, reply))) return;
       const info = sessionInfo(req);
       const snap = deps.station.snapshot();
       const body: StationStateResponse = {
         ...snap,
         isThisDeviceSpeaker: info ? deps.registry.isSpeaker(info.deviceId) : false,
       };
       return reply.send(body);
     });
   }
   ```

   (Subsequent steps add routes INSIDE `registerRest`, before its closing brace; the `enqueue` helper and per-action validators are nested functions.)

4. **Run it — expect PASS.** `npx vitest run src/server/rest.test.ts`
   Expected: the two state tests pass.

5. **Write failing test — add (link / query / too-long / reject / YtError).** Append:

   ```ts
   describe("POST /api/add", () => {
     it("queues a YouTube link, resets the radio de-dup window, returns queued", async () => {
       const { app, station, youtube, deps } = await build();
       const c = await login(app);
       const res = await app.inject({
         method: "POST",
         url: "/api/add",
         headers: { cookie: c },
         payload: { urlOrQuery: "https://youtu.be/dQw4w9WgXcQ" },
       });
       expect(res.statusCode).toBe(200);
       expect(res.json().queued).toEqual({ id: "i1", title: "dQw4w9WgXcQ" });
       expect(youtube.resolve).toHaveBeenCalledWith("dQw4w9WgXcQ");
       expect(station.enqueue).toHaveBeenCalledOnce();
       expect(
         (deps as unknown as { radio: { reset: ReturnType<typeof vi.fn> } }).radio.reset,
       ).toHaveBeenCalledOnce();
       await app.close();
     });
     it("returns search candidates for a free-text query", async () => {
       const { app } = await build();
       const c = await login(app);
       const res = await app.inject({
         method: "POST",
         url: "/api/add",
         headers: { cookie: c },
         payload: { urlOrQuery: "lofi beats" },
       });
       expect(res.statusCode).toBe(200);
       expect(Array.isArray(res.json().candidates)).toBe(true);
       await app.close();
     });
     it("400s an over-long input", async () => {
       const { app } = await build();
       const c = await login(app);
       const res = await app.inject({
         method: "POST",
         url: "/api/add",
         headers: { cookie: c },
         payload: { urlOrQuery: "x".repeat(2001) },
       });
       expect(res.statusCode).toBe(400);
       await app.close();
     });
     it("400s a search YtError with the kind (not stderr)", async () => {
       const { app } = await build();
       const c = await login(app);
       await (async () => {})();
       const { youtube } = await build({}, cfg());
       youtube.search.mockRejectedValueOnce(new YtError("private", "raw stderr"));
       // rebuild with this youtube so the route uses it:
       const b = await build({ youtube });
       const bc = await login(b.app);
       const res = await b.app.inject({
         method: "POST",
         url: "/api/add",
         headers: { cookie: bc },
         payload: { urlOrQuery: "anything" },
       });
       expect(res.statusCode).toBe(400);
       expect(res.json().error).toBe("private");
       await app.close();
       await b.app.close();
     });
   });
   ```

   (Note: adjust `YtError` constructor args to the verbatim signature from Phase 0 — `kind` first, message second, per `youtube/errors.ts`.)

6. **Run it — expect FAIL.** `npx vitest run src/server/rest.test.ts`
   Expected: add tests fail — `POST /api/add` returns 404 (route not registered).

7. **Implement `POST /api/add` + the `enqueueVideo` helper.** Add inside `registerRest`:

   ```ts
   async function enqueueVideo(req: FastifyRequest, reply: FastifyReply, videoId: string) {
     const info = sessionInfo(req);
     if (!info) return reply.code(401).send({ error: "unauthenticated" });
     let meta: TrackMeta;
     try {
       meta = await deps.youtube.resolve(videoId);
     } catch (err) {
       return reply.code(400).send({ error: err instanceof YtError ? err.kind : "resolve_failed" });
     }
     const requester: Requester = {
       deviceId: info.deviceId,
       displayName: info.displayName,
       source: "user",
     };
     let item: { id: string };
     try {
       item = await deps.station.enqueue(meta, requester);
     } catch (err) {
       if (err instanceof YtError) return reply.code(400).send({ error: err.message });
       return reply.code(500).send({ error: "enqueue_failed" });
     }
     // A user add is the new station seed (set inside enqueue); clear the radio's recent-history
     // de-dup window so the fresh seed's related/artist run starts clean.
     deps.radio.reset();
     return reply.send({ queued: { id: item.id, title: meta.title } });
   }

   app.post<{ Body: { urlOrQuery?: string } }>("/api/add", async (req, reply) => {
     if (!(await requireSession(req, reply))) return;
     const input = (req.body?.urlOrQuery ?? "").toString();
     if (input.length > 2000) return reply.code(400).send({ error: "input too long" });
     const parsed = parseInput(input);
       if (parsed.kind === "reject") return reply.code(400).send({ error: parsed.reason });
       if (parsed.kind === "query") {
         try {
           return reply.send({
             candidates: await deps.youtube.search(parsed.query, deps.searchLimit),
           });
         } catch (err) {
           if (err instanceof YtError) return reply.code(400).send({ error: err.kind });
           throw err;
         }
       }
       return enqueueVideo(req, reply, parsed.videoId);
   });
   ```

8. **Run it — expect PASS.** `npx vitest run src/server/rest.test.ts`
   Expected: state + add tests pass. (Confirm the `parseInput` discriminant fields — `kind: "link" | "query" | "reject"`, `videoId`, `query`, `reason` — match Phase 0's verbatim `url-parser.ts`; adjust `parsed.videoId`/`parsed.kind === "link"` accordingly if the verbatim union names the link case differently.)

9. **Write failing test — pick validates the candidateId.** Append:

   ```ts
   describe("POST /api/pick", () => {
     it("400s a malformed candidateId", async () => {
       const { app } = await build();
       const c = await login(app);
       const res = await app.inject({
         method: "POST",
         url: "/api/pick",
         headers: { cookie: c },
         payload: { candidateId: "nope" },
       });
       expect(res.statusCode).toBe(400);
       await app.close();
     });
     it("enqueues a valid candidateId", async () => {
       const { app, station } = await build();
       const c = await login(app);
       const res = await app.inject({
         method: "POST",
         url: "/api/pick",
         headers: { cookie: c },
         payload: { candidateId: "dQw4w9WgXcQ" },
       });
       expect(res.statusCode).toBe(200);
       expect(res.json().queued.id).toBe("i1");
       expect(station.enqueue).toHaveBeenCalledOnce();
       await app.close();
     });
   });
   ```

10. **Run it — expect FAIL, then implement `POST /api/pick`.** Run `npx vitest run src/server/rest.test.ts` (pick tests 404). Add inside `registerRest`:

    ```ts
    app.post<{ Body: { candidateId?: string } }>("/api/pick", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const candidateId = (req.body?.candidateId ?? "").toString();
      if (!VIDEO_ID.test(candidateId)) return reply.code(400).send({ error: "bad candidateId" });
      return enqueueVideo(req, reply, candidateId);
    });
    ```

    Re-run — expect PASS.

11. **Write failing test — control (pause/skip ok; seek 409/400; volume/repeat validation).** Append:

    ```ts
    describe("POST /api/control", () => {
      it("pause/resume/skip return ok and call the station", async () => {
        const { app, station } = await build();
        const c = await login(app);
        for (const action of ["pause", "play", "skip"] as const) {
          const res = await app.inject({
            method: "POST",
            url: "/api/control",
            headers: { cookie: c },
            payload: { action },
          });
          expect(res.statusCode).toBe(200);
          expect(res.json().ok).toBe(true);
        }
        expect(station.pause).toHaveBeenCalled();
        expect(station.resume).toHaveBeenCalled();
        expect(station.skip).toHaveBeenCalled();
        await app.close();
      });
      it("seek 409s when nothing is playing", async () => {
        const { app } = await build();
        const c = await login(app);
        const res = await app.inject({
          method: "POST",
          url: "/api/control",
          headers: { cookie: c },
          payload: { action: "seek", value: 1000 },
        });
        expect(res.statusCode).toBe(409);
        await app.close();
      });
      it("seek 400s past the track duration", async () => {
        const station = fakeStation();
        station.snapshot.mockReturnValue({
          repeat: "off",
          autoplay: true,
          autoplaySource: "radio",
          volume: 100,
          maxTrackDurationSec: 0,
          current: {
            id: "x",
            meta: meta("vvvvvvvvvvv"),
            requester: { deviceId: "d", displayName: "n", source: "user" },
            addedAt: 0,
            audio: null,
            fromRadio: false,
            positionMs: 0,
            durationMs: 100000,
          },
          upcoming: [],
          upcomingRadio: [],
          history: [],
          seed: null,
          paused: false,
          preparing: null,
          activePlayerPresent: true,
          activePlayerLabel: "PC",
        });
        const { app } = await build({ station } as never);
        const c = await login(app);
        const res = await app.inject({
          method: "POST",
          url: "/api/control",
          headers: { cookie: c },
          payload: { action: "seek", value: 999999 },
        });
        expect(res.statusCode).toBe(400);
        await app.close();
      });
      it("400s an out-of-range volume", async () => {
        const { app } = await build();
        const c = await login(app);
        const res = await app.inject({
          method: "POST",
          url: "/api/control",
          headers: { cookie: c },
          payload: { action: "volume", value: 9999 },
        });
        expect(res.statusCode).toBe(400);
        await app.close();
      });
      it("400s an invalid repeat value", async () => {
        const { app } = await build();
        const c = await login(app);
        const res = await app.inject({
          method: "POST",
          url: "/api/control",
          headers: { cookie: c },
          payload: { action: "repeat", value: "weird" },
        });
        expect(res.statusCode).toBe(400);
        await app.close();
      });
      it("400s remove/jump with a missing itemId", async () => {
        const { app } = await build();
        const c = await login(app);
        for (const action of ["remove", "jump"] as const) {
          const res = await app.inject({
            method: "POST",
            url: "/api/control",
            headers: { cookie: c },
            payload: { action },
          });
          expect(res.statusCode).toBe(400);
        }
        await app.close();
      });
    });
    ```

12. **Run it — expect FAIL, then implement `POST /api/control`.** Run the suite (control tests 404). Add inside `registerRest`:

    ```ts
    app.post<{ Body: { action?: ControlAction; value?: unknown } }>(
      "/api/control",
      async (req, reply) => {
        // Single shared password: any authenticated user may control everything.
        if (!(await requireSession(req, reply))) return;
        const action = req.body?.action;
        const value = req.body?.value;
        const station = deps.station;
        switch (action) {
          case "play":
            station.resume();
            return reply.send({ ok: true });
          case "pause":
            station.pause();
            return reply.send({ ok: true });
          case "skip":
            station.skip();
            return reply.send({ ok: true });
          case "shuffle":
            await station.shuffle();
            return reply.send({ ok: true });
          case "clear":
            await station.clear();
            return reply.send({ ok: true });
          case "seek": {
            const ms = Number(value);
            if (!Number.isFinite(ms) || ms < 0) {
              return reply.code(400).send({ error: "seek value must be a non-negative number" });
            }
            const current = station.snapshot().current;
            if (!current) return reply.code(409).send({ error: "nothing is playing" });
            if (current.durationMs > 0 && ms > current.durationMs) {
              return reply.code(400).send({ error: "seek exceeds track duration" });
            }
            const ok = await station.seek(Math.round(ms));
            return reply.send({ ok });
          }
          case "volume": {
            const pct = Number(value);
            if (!Number.isFinite(pct) || pct < 0 || pct > VOLUME_MAX) {
              return reply.code(400).send({ error: `volume must be 0..${VOLUME_MAX}` });
            }
            station.setVolume(Math.round(pct));
            return reply.send({ ok: true });
          }
          case "repeat": {
            if (typeof value !== "string" || !REPEAT_MODES.has(value)) {
              return reply.code(400).send({ error: "invalid repeat mode" });
            }
            station.updateSettings({ repeat: value as RepeatMode });
            return reply.send({ ok: true });
          }
          case "remove":
          case "jump": {
            const itemId = (value as { itemId?: string } | undefined)?.itemId;
            if (!itemId) return reply.code(400).send({ error: "itemId is required" });
            const ok =
              action === "remove" ? await station.remove(itemId) : await station.jump(itemId);
            return reply.send({ ok });
          }
          case "reorder": {
            const v = value as { itemId?: string; toIndex?: number } | undefined;
            if (!v?.itemId) return reply.code(400).send({ error: "itemId is required" });
            if (!Number.isInteger(v.toIndex) || (v.toIndex as number) < 0) {
              return reply.code(400).send({ error: "toIndex must be a non-negative integer" });
            }
            const ok = await station.reorder(v.itemId, v.toIndex as number);
            return reply.send({ ok });
          }
          case "settings": {
            const patch = (value ?? {}) as Partial<StationSettings>;
            station.updateSettings(patch as Record<string, unknown>);
            return reply.send({ ok: true });
          }
          default:
            return reply.code(400).send({ error: "unknown action" });
        }
      },
    );
    ```

13. **Run it — expect PASS.** `npx vitest run src/server/rest.test.ts`
    Expected: control tests pass.

14. **Write failing test — speaker + lyrics.** Append:

    ```ts
    describe("POST /api/speaker", () => {
      it("remember returns ok + the active player id, keyed on the session device", async () => {
        const { app, registry } = await build();
        const c = await login(app, cfg(), "dev-9");
        const res = await app.inject({
          method: "POST",
          url: "/api/speaker",
          headers: { cookie: c },
          payload: { action: "remember" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true, activePlayerDeviceId: "dev-9" });
        expect(registry.remember).toHaveBeenCalledWith("dev-9");
        await app.close();
      });
      it("release/forget dispatch to the registry keyed on the session device", async () => {
        const { app, registry } = await build();
        const c = await login(app, cfg(), "dev-9");
        for (const action of ["release", "forget"] as const) {
          const res = await app.inject({
            method: "POST",
            url: "/api/speaker",
            headers: { cookie: c },
            payload: { action },
          });
          expect(res.statusCode).toBe(200);
          expect(res.json().ok).toBe(true);
        }
        expect(registry.release).toHaveBeenCalledWith("dev-9");
        expect(registry.forget).toHaveBeenCalledWith("dev-9");
        await app.close();
      });
      it("400s the WS-only 'claim' action (claim happens over the WS becomePlayer frame)", async () => {
        const { app } = await build();
        const c = await login(app);
        const res = await app.inject({
          method: "POST",
          url: "/api/speaker",
          headers: { cookie: c },
          payload: { action: "claim" },
        });
        expect(res.statusCode).toBe(400);
        await app.close();
      });
      it("400s an unknown speaker action", async () => {
        const { app } = await build();
        const c = await login(app);
        const res = await app.inject({
          method: "POST",
          url: "/api/speaker",
          headers: { cookie: c },
          payload: { action: "zonk" },
        });
        expect(res.statusCode).toBe(400);
        await app.close();
      });
    });

    describe("GET /api/lyrics", () => {
      it("returns {lyrics:null} when nothing is playing", async () => {
        const { app } = await build();
        const c = await login(app);
        const res = await app.inject({
          method: "GET",
          url: "/api/lyrics?trackId=abc",
          headers: { cookie: c },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ lyrics: null, source: "lyrics.ovh" });
        await app.close();
      });
      it("calls the injected lyrics resolver for the current track", async () => {
        const station = fakeStation();
        station.snapshot.mockReturnValue({
          repeat: "off",
          autoplay: true,
          autoplaySource: "radio",
          volume: 100,
          maxTrackDurationSec: 0,
          current: {
            id: "x",
            meta: meta("vvvvvvvvvvv", "Song"),
            requester: { deviceId: "d", displayName: "n", source: "user" },
            addedAt: 0,
            audio: null,
            fromRadio: false,
            positionMs: 0,
            durationMs: 1000,
          },
          upcoming: [],
          upcomingRadio: [],
          history: [],
          seed: null,
          paused: false,
          preparing: null,
          activePlayerPresent: true,
          activePlayerLabel: "PC",
        });
        const lyrics = vi.fn(async () => ({ lyrics: "la la", source: "lyrics.ovh" }));
        const { app } = await build({ station, lyrics } as never);
        const c = await login(app);
        const res = await app.inject({
          method: "GET",
          url: "/api/lyrics?trackId=vvvvvvvvvvv",
          headers: { cookie: c },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().lyrics).toBe("la la");
        expect(lyrics).toHaveBeenCalledWith(expect.objectContaining({ videoId: "vvvvvvvvvvv" }));
        await app.close();
      });
    });
    ```

15. **Run it — expect FAIL, then implement `POST /api/speaker` + `GET /api/lyrics`.** Run the suite (speaker/lyrics 404). Add inside `registerRest`:

    ```ts
    app.post<{ Body: { action?: SpeakerAction } }>("/api/speaker", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const info = sessionInfo(req);
      if (!info) return reply.code(401).send({ error: "unauthenticated" });
      const action = req.body?.action;
      let result: { activePlayerDeviceId: string | null };
      switch (action) {
        // "claim" is intentionally NOT handled here: designating the Player needs the per-socket
        // BrowserPlayerSink, which only the WS becomePlayer handler (Task 3.4) holds. The UI
        // sends { type: "becomePlayer" } over /ws to claim; REST only does the sink-free actions.
        case "release":
          result = deps.registry.release(info.deviceId);
          break;
        case "remember":
          result = deps.registry.remember(info.deviceId);
          break;
        case "forget":
          result = deps.registry.forget(info.deviceId);
          break;
        case "claim":
          return reply
            .code(400)
            .send({ error: "claim is performed over the websocket (becomePlayer)" });
        default:
          return reply.code(400).send({ error: "unknown speaker action" });
      }
      const body: SpeakerResponse = { ok: true, activePlayerDeviceId: result.activePlayerDeviceId };
      return reply.send(body);
    });

    app.get<{ Querystring: { trackId?: string } }>("/api/lyrics", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const current = deps.station.snapshot().current;
      if (!current)
        return reply.send({ lyrics: null, source: "lyrics.ovh" } satisfies LyricsResult);
      return reply.send(await lyricsOf(current.meta));
    });
    ```

    Re-run — expect PASS. (`AUTOPLAY_REQUESTER` is imported for type-completeness of the requester surface; if eslint flags it as unused after wiring, remove it from the import — radio adds use it inside the engine, not here.)

16. **Run the whole file — expect PASS.** `npx vitest run src/server/rest.test.ts`
    Expected: every state/add/pick/control/speaker/lyrics test green.

---

### Task 4.3: buildApp wiring

**Files**

- Create: `src/server/app.ts`
- Test: `src/server/app.test.ts`

**Interfaces**

Consumes:

- `WebConfig` from `../config.js` (0.5).
- `MemorySessionStore` from `../auth/session-store.js` (0.6).
- `registerAuthRoutes` from `../auth/password.js` (4.1).
- `registerRest`, `RestDeps` from `./rest.js` (4.2).
- `registerAudioRoute` from `../audio/index.js` (2.2) — `registerAudioRoute(app, { cache, youtube, downloads }): void`.
- `registerWebsocket` + `StationBroadcaster` from `./ws.js` (3.3/3.4).
- `StationController` (1.5), `YouTubeService` (0.4), `PlayerRegistry` (3.2), `AudioCache` (0.6), `Semaphore` (0.3).

Produces (exact signature):

```ts
export interface AppDeps {
  cfg: WebConfig;
  station: StationController;
  youtube: YouTubeService;
  registry: PlayerRegistry;
  broadcaster: StationBroadcaster;
  cache: AudioCache;
  downloads: Semaphore;
  lyrics?: RestDeps["lyrics"];
  radio: RestDeps["radio"];
  searchLimit: number;
}
export function buildApp(deps: AppDeps): Promise<FastifyInstance>;
```

Behavior: construct the Fastify instance with `trustProxy: true` unconditionally (the app is always behind the user's HTTPS proxy/tunnel, which sets `X-Forwarded-Proto`; trusting it is required for correct scheme detection + secure cookies + real client IP — it is a fixed behavior, not a configurable knob). Register `@fastify/cookie`, `@fastify/session` (`MemorySessionStore`, cookieName `sid`, `secure: cfg.secureCookies`, `rolling: true`, `maxAge: 7d`, `sameSite: lax`, `saveUninitialized: false`), `@fastify/websocket`, `@fastify/static` (the web `public` dir). `setErrorHandler`: `URIError` → `400 bad_request`, `>=500` → `500 internal_error`, else preserve the status with `err.message`. `GET /healthz` → `{ ok: true, uptimeSec }`. `setNotFoundHandler` SPA fallback (GET, not `/api`/`/ws`/`/audio` → `index.html`, else `404 not_found`). Wire `registerAuthRoutes`, `registerRest`, `registerAudioRoute`, `registerWebsocket`.

#### Steps

1. **Write failing test — /healthz, login-guard, SPA fallback, error handler.** Create `src/server/app.test.ts`:

   ```ts
   import { describe, it, expect, vi } from "vitest";
   import { EventEmitter } from "node:events";
   import { buildApp, type AppDeps } from "./app.js";
   import type { WebConfig } from "../config.js";

   function cfg(over: Partial<WebConfig> = {}): WebConfig {
     return {
       publicBaseUrl: "https://j",
       viewerPassword: "letmein",
       allowNoPassword: false,
       sessionSecret: "x".repeat(32),
       port: 8080,
       host: "0.0.0.0",
       allowedWsOrigins: ["https://j"],
       nodeEnv: "test",
       secureCookies: false,
       ...over,
     };
   }

   function deps(over: Partial<AppDeps> = {}): AppDeps {
     return {
       cfg: cfg(),
       station: Object.assign(new EventEmitter(), {
         snapshot: vi.fn(() => ({
           repeat: "off",
           autoplay: true,
           autoplaySource: "radio",
           volume: 100,
           maxTrackDurationSec: 0,
           current: null,
           upcoming: [],
           upcomingRadio: [],
           history: [],
           seed: null,
           paused: false,
           preparing: null,
           activePlayerPresent: false,
           activePlayerLabel: null,
         })),
         reportPosition: vi.fn(),
       }),
       youtube: { resolve: vi.fn(), search: vi.fn(), download: vi.fn() },
       registry: {
         isSpeaker: vi.fn(() => false),
         activePlayerDeviceId: null,
         touch: vi.fn(),
         claim: vi.fn(),
         release: vi.fn(() => ({ activePlayerDeviceId: null })),
         remember: vi.fn(() => ({ activePlayerDeviceId: null })),
         forget: vi.fn(() => ({ activePlayerDeviceId: null })),
         onConnect: vi.fn(),
         onDisconnect: vi.fn(),
       },
       broadcaster: {
         attach: vi.fn(),
         broadcast: vi.fn(),
         subscribe: vi.fn(),
         unsubscribe: vi.fn(),
       },
       cache: {
         get: vi.fn(() => null),
         getAudio: vi.fn(() => null),
         has: vi.fn(() => false),
         register: vi.fn(),
         pin: vi.fn(),
       },
       cacheDir: "/tmp/lan-jukebox-test-cache",
       downloads: { run: vi.fn(async (f: () => Promise<unknown>) => f()) },
       radio: { reset: vi.fn() },
       searchLimit: 5,
       ...over,
     } as unknown as AppDeps;
   }

   describe("buildApp", () => {
     it("serves /healthz with ok + uptimeSec", async () => {
       const app = await buildApp(deps());
       const res = await app.inject({ method: "GET", url: "/healthz" });
       const body = res.json() as { ok: boolean; uptimeSec: number };
       expect(body.ok).toBe(true);
       expect(typeof body.uptimeSec).toBe("number");
       await app.close();
     });
     it("guards /api/state when logged out (401)", async () => {
       const app = await buildApp(deps());
       expect((await app.inject({ method: "GET", url: "/api/state" })).statusCode).toBe(401);
       await app.close();
     });
     it("login then /api/state returns 200 through the real session", async () => {
       const app = await buildApp(deps());
       const login = await app.inject({
         method: "POST",
         url: "/api/login",
         payload: { password: "letmein", displayName: "Ada", deviceId: "dev-1" },
       });
       expect(login.statusCode).toBe(200);
       const set = login.headers["set-cookie"];
       const cookie = (Array.isArray(set) ? (set[0] as string) : (set as string)).split(";")[0]!;
       const res = await app.inject({ method: "GET", url: "/api/state", headers: { cookie } });
       expect(res.statusCode).toBe(200);
       await app.close();
     });
     it("falls back to index.html for an unknown non-API GET (SPA)", async () => {
       const app = await buildApp(deps());
       const res = await app.inject({ method: "GET", url: "/some/spa/route" });
       // index.html may not exist in the test cwd; the fallback path is what we assert:
       // it is NOT the JSON 404 the API path returns.
       expect(res.json?.()?.error).not.toBe("not_found");
       await app.close();
     });
     it("returns JSON 404 for an unknown /api route", async () => {
       const app = await buildApp(deps());
       const res = await app.inject({ method: "GET", url: "/api/does-not-exist" });
       expect(res.statusCode).toBe(404);
       expect(res.json().error).toBe("not_found");
       await app.close();
     });
   });
   ```

   (If `index.html` is absent in the test cwd, `sendFile` 404s with Fastify's default body, not `{error:"not_found"}` — the assertion above tolerates that; the SPA-vs-API divergence is the real contract under test.)

2. **Run it — expect FAIL.** `npx vitest run src/server/app.test.ts`
   Expected: `Cannot find module './app.js'`.

3. **Implement `buildApp`.** Create `src/server/app.ts`:

   ```ts
   import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
   import cookie from "@fastify/cookie";
   import session from "@fastify/session";
   import websocket from "@fastify/websocket";
   import fastifyStatic from "@fastify/static";
   import path from "node:path";
   import { fileURLToPath } from "node:url";
   import { MemorySessionStore } from "../auth/session-store.js";
   import { registerAuthRoutes } from "../auth/password.js";
   import { registerRest, type RestDeps } from "./rest.js";
   import { registerAudioRoute } from "../audio/index.js";
   import { registerWebsocket, StationBroadcaster } from "./ws.js";
   import { BrowserPlayerSink } from "../orchestrator/browser-player-sink.js";
   import type { WebConfig } from "../config.js";
   import type { StationController } from "../orchestrator/index.js";
   import type { YouTubeService } from "../youtube/index.js";
   import type { PlayerRegistry } from "../players/registry.js";
   import type { AudioCache } from "../cache/index.js";
   import type { Semaphore } from "../util/semaphore.js";

   export interface AppDeps {
     cfg: WebConfig;
     station: StationController;
     youtube: YouTubeService;
     registry: PlayerRegistry;
     broadcaster: StationBroadcaster;
     cache: AudioCache;
     cacheDir: string; // = media.cacheDir; the audio route downloads/transcodes into it
     downloads: Semaphore;
     lyrics?: RestDeps["lyrics"];
     radio: RestDeps["radio"];
     searchLimit: number;
   }

   export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
     // trustProxy is always true: the app is always behind the user's HTTPS proxy/tunnel,
     // which sets X-Forwarded-Proto. Trusting it is required for correct scheme detection,
     // secure cookies, and the real client IP. This is a fixed behavior, not a config knob.
     const app = Fastify({ trustProxy: true, logger: false });

     // Never let an unexpected throw leak raw internals (yt-dlp stderr, fs paths, stacks).
     // URIError (e.g. a bad percent-encoding) -> 400; genuine 5xx -> a stable generic body.
     app.setErrorHandler((err: FastifyError, _req, reply) => {
       if (err instanceof URIError) return reply.code(400).send({ error: "bad_request" });
       const status = err.statusCode ?? 500;
       if (status >= 500) return reply.code(500).send({ error: "internal_error" });
       return reply.code(status).send({ error: err.message });
     });

     await app.register(cookie);
     await app.register(session, {
       secret: deps.cfg.sessionSecret,
       cookieName: "sid",
       store: new MemorySessionStore() as never,
       saveUninitialized: false,
       rolling: true,
       cookie: {
         path: "/",
         httpOnly: true,
         secure: deps.cfg.secureCookies,
         sameSite: "lax",
         maxAge: 7 * 24 * 60 * 60 * 1000,
       },
     });
     await app.register(websocket);

     app.get("/healthz", () => ({ ok: true, uptimeSec: Math.floor(process.uptime()) }));

     registerAuthRoutes(app, deps.cfg);
     registerRest(app, {
       station: deps.station,
       youtube: deps.youtube,
       lyrics: deps.lyrics,
       registry: deps.registry,
       radio: deps.radio,
       searchLimit: deps.searchLimit,
       cfg: deps.cfg,
     });
     registerAudioRoute(app, {
       cache: deps.cache,
       youtube: deps.youtube,
       cacheDir: deps.cacheDir,
       downloads: deps.downloads,
     });
     registerWebsocket(app, {
       broadcaster: deps.broadcaster ?? new StationBroadcaster(),
       station: deps.station,
       registry: deps.registry,
       allowedOrigins: deps.cfg.allowedWsOrigins,
       // Per-socket sink factory: a fresh BrowserPlayerSink whose ServerPlayerMessages target
       // THIS socket's send. ws.ts caches it per connection and feeds it to registry.claim/onConnect.
       makeSink: (send) => {
         const sink = new BrowserPlayerSink();
         sink.setSend(send);
         return sink;
       },
     });

     const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
     await app.register(fastifyStatic, { root: publicDir, prefix: "/", wildcard: false });
     app.setNotFoundHandler((req, reply) => {
       if (
         req.method === "GET" &&
         !req.url.startsWith("/api") &&
         !req.url.startsWith("/ws") &&
         !req.url.startsWith("/audio")
       ) {
         return reply.sendFile("index.html");
       }
       return reply.code(404).send({ error: "not_found" });
     });

     return app;
   }
   ```

   (Match `registerAudioRoute` / `registerWebsocket` argument shapes to whatever Phases 2.2 and 3.3/3.4 actually produced; the names above mirror this plan's backbone — adjust the deps object keys if those tasks named them differently.)

4. **Run it — expect PASS.** `npx vitest run src/server/app.test.ts`
   Expected: healthz / login-guard / login-roundtrip / SPA-vs-API tests pass.

---

### Task 4.4: Composition root main()

**Files**

- Create: `src/index.ts`
- Test: none (composition root; verified by typecheck + build + the canary path being exercised in 0.3 tests). The phase verification (`npm run build` + the full suite) is the gate.

**Interfaces**

Consumes:

- `loadConfig` from `./config.js` (0.5) → `AppConfig { media, station, web }`.
- `createLogger`, `setRootLogger` from `./util/logger.js`; `installCrashHandlers`, `installSignalHandlers` from `./lifecycle.js`; `startupCanary` from `./canary.js` (0.3).
- `YouTubeService` (0.4), `AudioCache` (0.6), `Semaphore` (0.3), `StationController` (1.5), `RadioEngine` (1.6), snapshot helpers `collectStationSnapshot`/`writeStationSnapshot`/`readStationSnapshot`/`restoreStationSnapshot` (1.7), `PlayerRegistry` (3.2), `StationBroadcaster` (3.3), `buildApp` (4.3).

Produces: `async function main(): Promise<void>` + the `main().catch(...)` bootstrap.

Behavior: load config; `setRootLogger`; `installCrashHandlers`; init cache + device registry; build `RadioEngine`, `StationController`, `PlayerRegistry`, `StationBroadcaster.attach(station)`; `buildApp` + `listen` immediately (no gateway wait); restore station + device snapshots; `installSignalHandlers([flush snapshots, app.close], { graceMs: 8000 })`; debounced snapshot writer on the controller's `changed` event; `startupCanary`. `main().catch(-> exit(1))`.

#### Steps

1. **Write `src/index.ts`.** (No unit test; the build + typecheck verify wiring. Each consumed symbol is real from earlier phases.) Create:

   ```ts
   import { loadConfig } from "./config.js";
   import { YouTubeService } from "./youtube/index.js";
   import { AudioCache } from "./cache/index.js";
   import { Semaphore } from "./util/semaphore.js";
   import { StationController } from "./orchestrator/index.js";
   import { DEFAULT_SETTINGS } from "./types/index.js";
   import { RadioEngine } from "./radio/index.js";
   import { PlayerRegistry } from "./players/registry.js";
   import { buildApp } from "./server/app.js";
   import { StationBroadcaster } from "./server/ws.js";
   import { createLogger, setRootLogger } from "./util/logger.js";
   import { installCrashHandlers, installSignalHandlers } from "./lifecycle.js";
   import { startupCanary } from "./canary.js";
   import {
     collectStationSnapshot,
     writeStationSnapshot,
     readStationSnapshot,
     restoreStationSnapshot,
   } from "./orchestrator/snapshot.js";

   async function main(): Promise<void> {
     const cfg = loadConfig();
     const { media, station: stationCfg, web } = cfg;
     const log = createLogger(stationCfg.logLevel);
     // Publish the configured logger as the process-wide root so module-scope consumers log
     // at LOG_LEVEL instead of their own default-"info" instance.
     setRootLogger(log);
     installCrashHandlers(log);

     const youtube = new YouTubeService(media);
     const cache = new AudioCache(media.cacheDir, media.cacheMaxBytes);
     await cache.init();
     const downloads = new Semaphore(stationCfg.maxConcurrentDownloads);

     // Debounced snapshot writer — defined before the controller so its 'changed' handler
     // (wired below) closes over it. Coalesces bursts of queue/settings changes into one write.
     // collectStationSnapshot(station, activePlayerDeviceId, now) per snapshot.ts (Task 1.7);
     // the active-player id comes off the registry, not the orchestrator.
     let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
     const scheduleSnapshot = (): void => {
       if (snapshotTimer) clearTimeout(snapshotTimer);
       snapshotTimer = setTimeout(() => {
         snapshotTimer = null;
         writeStationSnapshot(
           media.cacheDir,
           collectStationSnapshot(station, registry.activePlayerDeviceId, Date.now()),
         ).catch((err) => log.error({ err }, "station snapshot write failed"));
       }, 3000);
     };

     const broadcaster = new StationBroadcaster();

     // StationController owns the queue + sink; its deps are the download fn + cache pin/unpin +
     // settings + onSettingsChanged (see StationControllerDeps, Task 1.5). It does NOT take the
     // youtube/radio objects directly — the radio plugs in via setRadioContinuation / setRadioTopUp.
     const station = new StationController({
       download: (videoId, opts) => youtube.download(videoId, media.cacheDir, opts),
       // Register the freshly-downloaded file in the LRU cache, then pin it so the audio route
       // can serve it and it is not evicted while it is the current track.
       pin: (videoId, path) => {
         cache.register(videoId, path);
         cache.pin(videoId);
       },
       unpin: (videoId) => cache.unpin(videoId),
       prefetch: (videoId) =>
         downloads.run(() => youtube.download(videoId, media.cacheDir)).then(() => {}),
       settings: { ...DEFAULT_SETTINGS, maxTrackDurationSec: media.maxTrackDurationSec ?? 0 },
       onSettingsChanged: () => scheduleSnapshot(),
     });
     // Persist queue/settings/playback changes (debounced) so the station survives a restart.
     station.on("changed", scheduleSnapshot);

     // RadioEngine deps are { youtube, station, settings } (Task 1.6). Wire it into the controller
     // via the continuation hooks so a drained queue pulls the next related/artist track forever.
     const radio = new RadioEngine({
       youtube,
       station,
       settings: () => ({
         autoplay: station.settings.autoplay,
         autoplaySource: station.settings.autoplaySource,
       }),
     });
     station.setRadioContinuation(() => radio.nextCandidate());
     station.setRadioTopUp(() => {
       void radio.ensureAhead(stationCfg.prefetchDepth);
     });

     // Active-player + device memory. PlayerRegistry deps are { dir, station } (Task 3.2); init
     // reads the persisted device registry. The broadcaster pushes 'state' to all sockets.
     const registry = new PlayerRegistry({ dir: media.cacheDir, station });
     await registry.init();
     broadcaster.attach(station);

     // Build + listen IMMEDIATELY — there is no gateway/login to wait for (unlike the bot).
     const app = await buildApp({
       cfg: web,
       station,
       youtube,
       registry,
       broadcaster,
       cache,
       cacheDir: media.cacheDir,
       downloads,
       radio,
       searchLimit: media.searchResultCount,
     });
     await app.listen({ port: web.port, host: web.host });
     log.info({ host: web.host, port: web.port }, "lan-jukebox listening");

     // Restore the persisted station (current/queue/seed/position/settings). restoreStationSnapshot
     // is (file, station, log) per Task 1.7 — the active-player id is reattached when the speaker
     // reconnects via PlayerRegistry.onConnect, so it is not replayed here.
     const snap = await readStationSnapshot(media.cacheDir);
     if (snap) await restoreStationSnapshot(snap, station, log);

     // Register signal handlers AFTER listen so a SIGTERM flushes the live snapshot and closes
     // the app. Every task is guarded so it is safe even if a signal arrives mid-startup.
     installSignalHandlers(
       [
         async () => {
           if (snapshotTimer) {
             clearTimeout(snapshotTimer);
             snapshotTimer = null;
           }
           await writeStationSnapshot(
             media.cacheDir,
             collectStationSnapshot(station, registry.activePlayerDeviceId, Date.now()),
           );
         },
         async () => {
           await app.close();
         },
       ],
       { graceMs: 8000 },
       log,
     );

     // Startup canary — log only, never abort.
     await startupCanary(youtube, log);
   }

   // A fatal startup rejection (bad config, EADDRINUSE on listen, …) must crash-and-exit
   // non-zero so the supervisor restarts/alerts — NOT get swallowed by the lenient
   // unhandledRejection policy. Log through pino when possible; some failures happen before
   // the logger exists (a bad env thrown from loadConfig), so fall back to console.error.
   main().catch((err) => {
     try {
       createLogger().fatal({ err }, "startup failed");
     } catch {
       console.error("startup failed", err);
     }
     process.exit(1);
   });
   ```

   (The constructor/option shapes above are reconciled with the exact exports of Phases 1.5/1.6/1.7/3.2/3.3: `StationControllerDeps` = `{ download, pin?, unpin?, prefetch?, settings?, onSettingsChanged?, now?, queue? }`; `RadioDeps` = `{ youtube, station, settings, recentWindow? }`; `PlayerRegistryDeps` = `{ dir, station, now? }`; `collectStationSnapshot(station, activePlayerDeviceId, now)` + `restoreStationSnapshot(file, station, log)`. The radio is wired into the controller through `setRadioContinuation`/`setRadioTopUp` (no circular import); do not pass `radio` into the `StationController` constructor.)

2. **Typecheck the composition root.** `npm run typecheck`
   Expected: no errors. If `collectStationSnapshot`/`restoreStationSnapshot`/constructor arities differ from earlier phases, fix the call sites here (this is the integration seam — it surfaces any drift between the modules).

3. **Build to confirm the entrypoint compiles + emits.** `npm run build`
   Expected: `dist/index.js` emitted, web bundle built, exit 0.

---

### Task 4.5: Phase completion — full verification, adversarial debug, single squash commit

**Files**

- No new files. This task gates the phase.

#### Steps

1. **Full verification — typecheck + lint + build + tests.** Run:

   ```
   npm run typecheck && npm run lint && npm run build && npm test
   ```

   Expected GREEN output (shape):

   ```
   > tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit && tsc -p web/tsconfig.json
   (no output, exit 0)

   > eslint . && prettier --check .
   All matched files use Prettier code style!

   > npm run build:web && tsc -p tsconfig.json
   ✓ built in NNNms        (web)
   (tsc exit 0)

   > vitest run
   ✓ src/auth/password.test.ts        (verifyPassword + login + admin/guards/logout)
   ✓ src/server/rest.test.ts          (state/add/pick/control/speaker/lyrics)
   ✓ src/server/app.test.ts           (healthz/login-guard/login-roundtrip/SPA-vs-API)
   ... (all earlier-phase suites still green)
   Test Files  N passed (N)
        Tests  M passed (M)
   ```

   If anything is red, fix it before proceeding — do NOT commit a partial phase.

2. **Adversarial multi-agent /debug pass.** Fan out finder subagents across this phase's changed files — `src/auth/password.ts`, `src/server/rest.ts`, `src/server/app.ts`, `src/index.ts` — each through a reliability lens, then adversarially verify every finding before fixing. Lenses to assign:
   - **Auth / session correctness:** does `login` rotate the session id and destroy the old store entry (fixation)? Is `verifyPassword` length-guarded so `timingSafeEqual` never throws? Single shared password — does any authed user pass `requireSession` on every route (no elevation tier)? Does `logout` truly destroy the session (subsequent guarded call 401s)?
   - **REST error-mapping:** is every `YtError` mapped to a 4xx (kind for resolve/search, message for enqueue) and never an unhandled 500 leaking yt-dlp stderr? Is the `input>2000` guard before `parseInput`? Does `seek` return 409 (nothing playing) vs 400 (out-of-range) correctly? Are `remove`/`jump`/`reorder` value-shape validated (missing `itemId` → 400, non-integer `toIndex` → 400)? Is `volume` clamped to `0..VOLUME_MAX`? Is `repeat` checked against the real RepeatMode set?
   - **Attribution & seed:** does an `/api/add` link/pick build a `Requester` with `source:"user"` and the session deviceId/displayName, and call `radio.reset()` exactly once on success (and never on a search-candidates response)? Is the seed itself set inside `StationController.enqueue` (not via a non-existent `setSeed`/`reseed`)?
   - **buildApp hardening:** is the Fastify instance constructed with `trustProxy: true` (always, since the app is behind the user's HTTPS proxy/tunnel)? Does the error handler map URIError→400 and >=500→internal_error while preserving explicit 4xx? Does the SPA fallback exclude `/api`, `/ws`, `/audio`? Are cookies `httpOnly`, `sameSite:lax`, `secure:cfg.secureCookies`?
   - **Composition root:** is `buildApp`+`listen` done immediately (no gateway wait)? Is the snapshot flushed on SIGTERM and `app.close()` called within `graceMs`? Is the debounced writer timer cleared in the shutdown task so it can't fire post-close? Does `main().catch` exit(1) on a fatal startup error?
   - **WS origin guard reachability:** confirm `buildApp` passes `cfg.allowedWsOrigins` (which the config layer pins to `[publicBaseUrl]`) into `registerWebsocket` so the origin guard is actually armed.
     Verify each candidate finding against the code/tests; fix ALL confirmed bugs (add a regression test for each behavioral fix); discard the false positives. Re-run the full verification from step 1 until green.

3. **Exactly ONE squash commit for the whole phase** (after debug is clean — per the one-commit-per-phase rule, overriding any per-task commit default). The repo is under `Atvriders`, branch `master`, no `gh` CLI:
   ```
   git -C /home/kasm-user/lan-jukebox add -A
   git -C /home/kasm-user/lan-jukebox commit -m "$(cat <<'EOF'
   Phase 4: shared-password auth + flat REST API + buildApp wiring + composition root

   - auth/password.ts: timing-safe verifyPassword (length-guarded), registerAuthRoutes
     (/api/login with session.regenerate fixation fix + old-entry destroy, /api/logout),
     requireSession/sessionInfo guards (single shared password, no elevation tier).
   - server/rest.ts: flat de-guilded /api surface (state/add/pick/control/speaker/lyrics)
     with the bot's hardened error-mapping (input>2000 -> 400, parseInput reject -> 400,
     YtError -> 400 kind/message, enqueue fail -> 500, seek 409/400, missing itemId -> 400);
     user adds reset the radio de-dup window; any authed user may control everything.
   - server/app.ts: buildApp wiring cookie/session(MemorySessionStore,7d,rolling)/websocket/
     static + /healthz + SPA fallback + audio route + ws; trustProxy:true always;
     error handler URIError->400, >=500->internal_error.
   - index.ts: composition root main() — load config, init cache/registry, wire
     radio+station+broadcaster, buildApp+listen immediately, restore snapshots, debounced
     snapshot writer, graceful signal handlers (graceMs 8000), startup canary.

   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   EOF
   )"
   ```
   Push only if the user asks (per the no-auto-push workflow). Confirm a single commit: `git -C /home/kasm-user/lan-jukebox log --oneline -1`.

---

## Phase 5:Web UI (frontend-design) — Web UI (frontend-design)

**Goal:** Author a cohesive professional design system with the `frontend-design` skill, then build the SPA: shared-password `LoginGate`, `deviceId` bootstrap, `useStationState` WS hook, `usePlayerRole` hidden-`<audio>` sink, `PlayerPanel`, and the de-guilded/de-Discorded panels (`AddBar`/`Controls`/`NowPlaying`/`Queue`/`History`/`Lyrics`/`Settings`) with the station-live/waiting-for-seed status.

### Parallelization

- **Sequential (shared hubs — edit one task at a time, never in parallel):**
  - `web/src/components/App.tsx` — the root that wires every panel; only Task 5.6 touches it.
  - `web/src/lib/useStationState.ts` — the WS hub hook; only Task 5.2 touches it.
  - `web/src/index.css` — the design system is authored ONCE in Task 5.1 (via the `frontend-design` skill) and then frozen; later tasks only reference its tokens/classes, never re-author it.
- **Parallel-safe (disjoint files once 5.1's design system + `web/src/types.ts` (Phase 0) + `web/src/lib/api.ts` are fixed):**
  - Each `web/src/components/*.tsx` panel + its test in Task 5.5 is disjoint from the others.
  - `web/src/lib/deviceId.ts` (Task 5.1) and `web/src/lib/usePlayerRole.ts` (Task 5.3) are disjoint from each other and from `useStationState.ts`.
  - `LoginGate.tsx` and `PlayerPanel.tsx` (Task 5.4) are disjoint from each other.
- **Ordering constraint:** 5.1 must complete first (design system + api client + deviceId). 5.2 and 5.3 may run in parallel after 5.1. 5.4 needs 5.1 + 5.3. 5.5 needs 5.1. 5.6 is last (consumes everything) and must run alone.

**Environment note (jsdom):** every component/hook test file in this phase begins with the pragma `// @vitest-environment jsdom` on line 1 (vitest.config.ts defaults to the node env; the pragma opts the file into jsdom). Pure-logic test files (`api.test.ts`, `deviceId.test.ts`, `wsReducer.test.ts`) keep the node env unless they touch `localStorage`/`document`/`WebSocket` — those add the pragma too.

**Shared types are imported from `web/src/types.ts` (the Phase 0 web mirror of `src/types/index.ts`).** Use the EXACT names: `StationSnapshot`, `StationStateResponse`, `CurrentItem`, `QueueItem`, `TrackMeta`, `Requester`, `SessionInfo`, `LoginRequest`, `AddResponse`, `PickResponse`, `ControlAction`, `ControlResponse`, `SpeakerAction`, `SpeakerResponse`, `LyricsResult`, `RepeatMode`, `AutoplaySource`, `ServerBroadcastMessage`, `ServerPlayerMessage`, `ClientWsMessage`. ESM/NodeNext: relative imports use the `.js` extension even from `.ts`/`.tsx`.

---

### Task 5.1: Design system + api client + deviceId

**Files**

- Create: `web/src/index.css` (authored via the `frontend-design` skill)
- Create: `web/src/lib/api.ts`
- Test: `web/src/lib/api.test.ts`
- Create: `web/src/lib/deviceId.ts`
- Test: `web/src/lib/deviceId.test.ts`

**Interfaces**

- Consumes: `web/src/types.ts` (Phase 0) — `LoginRequest`, `SessionInfo`, `StationStateResponse`, `AddRequest`, `AddResponse`, `PickRequest`, `PickResponse`, `ControlAction`, `ControlRequest`, `ControlResponse`, `SpeakerAction`, `SpeakerRequest`, `SpeakerResponse`, `LyricsResult`. Spec §6 REST routes.
- Produces:
  - `web/src/index.css` — Tailwind v4 `@theme` design tokens + component classes (`.card`, `.pill`, `.pill-primary`, `.pill-ghost`, `.eyebrow`, `.vu`, `.spinner`, `.reveal`, `.hero-glow`).
  - `class ApiError extends Error` with `readonly status: number`.
  - `const api` object (flat `/api`, `credentials:"include"`): `login(body:LoginRequest):Promise<SessionInfo>`, `logout():Promise<void>`, `state():Promise<StationStateResponse>`, `add(urlOrQuery:string):Promise<AddResponse>`, `pick(candidateId:string):Promise<PickResponse>`, `control(action:ControlAction, value?:ControlRequest["value"]):Promise<ControlResponse>`, `speaker(action:SpeakerAction):Promise<SpeakerResponse>`, `lyrics(trackId:string):Promise<LyricsResult>`.
  - `getDeviceId():string`, `getDisplayName():string`, `setDisplayName(name:string):void` (localStorage-backed).

> **Author the design system FIRST.** Invoke the `frontend-design` skill to produce `web/src/index.css` as a cohesive, professional Tailwind v4 `@theme` token set + the component classes listed above. This is the only task that authors `index.css`; it is frozen afterward. There is no automated test for the CSS itself — verify visually later in the README manual checklist. The TDD steps below cover `api.ts` and `deviceId.ts`.

#### deviceId — steps

1. **Write the failing test.** Create `web/src/lib/deviceId.test.ts`:
   ```ts
   // @vitest-environment jsdom
   import { describe, it, expect, beforeEach } from "vitest";
   import { getDeviceId, getDisplayName, setDisplayName } from "./deviceId.js";

   beforeEach(() => localStorage.clear());

   describe("deviceId", () => {
     it("issues a persistent deviceId and returns the same value on subsequent calls", () => {
       const a = getDeviceId();
       expect(a).toMatch(/^[0-9a-f-]{8,}$/i); // a UUID-ish random token
       const b = getDeviceId();
       expect(b).toBe(a); // persisted, not regenerated
       expect(localStorage.getItem("ljb.deviceId")).toBe(a);
     });
     it("defaults the displayName to 'Guest' and persists a set name", () => {
       expect(getDisplayName()).toBe("Guest");
       setDisplayName("  Alice  ");
       expect(getDisplayName()).toBe("Alice"); // trimmed
       expect(localStorage.getItem("ljb.displayName")).toBe("Alice");
     });
     it("ignores a blank set name (keeps the prior value)", () => {
       setDisplayName("Bob");
       setDisplayName("   ");
       expect(getDisplayName()).toBe("Bob");
     });
   });
   ```
2. **Run it — expect FAIL.** `cd /home/kasm-user/lan-jukebox && npx vitest run web/src/lib/deviceId.test.ts` → fails with `Failed to resolve import "./deviceId.js"` (module does not exist).
3. **Minimal implementation.** Create `web/src/lib/deviceId.ts`:
   ```ts
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
   ```
4. **Run it — expect PASS.** `npx vitest run web/src/lib/deviceId.test.ts` → 3 passed.

#### api — steps

5. **Write the failing test.** Create `web/src/lib/api.test.ts`:
   ```ts
   import { describe, it, expect, vi, afterEach } from "vitest";
   import { api, ApiError } from "./api.js";

   function mockOnce(ok: boolean, json: unknown, status = ok ? 200 : 400, statusText?: string) {
     const fn = vi.fn().mockResolvedValue({
       ok,
       status,
       statusText,
       headers: { get: () => null },
       json: async () => json,
     });
     vi.stubGlobal("fetch", fn);
     return fn;
   }
   afterEach(() => vi.unstubAllGlobals());

   describe("api client", () => {
     it("login POSTs the LoginRequest body as JSON with credentials", async () => {
       const fn = mockOnce(true, { displayName: "Al", deviceId: "d1" });
       const s = await api.login({ password: "pw", displayName: "Al", deviceId: "d1" });
       const [url, init] = fn.mock.calls[0]!;
       expect(url).toBe("/api/login");
       expect((init as RequestInit).method).toBe("POST");
       expect((init as RequestInit).credentials).toBe("include");
       expect(JSON.parse(String((init as RequestInit).body))).toEqual({
         password: "pw",
         displayName: "Al",
         deviceId: "d1",
       });
       expect(s.deviceId).toBe("d1");
     });
     it("state GETs /api/state with credentials", async () => {
       const fn = mockOnce(true, { current: null, isThisDeviceSpeaker: false });
       const r = await api.state();
       const [url, init] = fn.mock.calls[0]!;
       expect(url).toBe("/api/state");
       expect((init as RequestInit).method).toBeUndefined(); // GET
       expect((init as RequestInit).credentials).toBe("include");
       expect(r.isThisDeviceSpeaker).toBe(false);
     });
     it("add POSTs { urlOrQuery } and surfaces candidates", async () => {
       const fn = mockOnce(true, { candidates: [{ videoId: "v1", title: "T" }] });
       const r = await api.add("some song");
       const [url, init] = fn.mock.calls[0]!;
       expect(url).toBe("/api/add");
       expect(JSON.parse(String((init as RequestInit).body))).toEqual({ urlOrQuery: "some song" });
       expect(r.candidates?.[0]?.videoId).toBe("v1");
     });
     it("pick POSTs { candidateId }", async () => {
       const fn = mockOnce(true, { queued: { id: "i1", title: "T" } });
       const r = await api.pick("v1");
       const [url, init] = fn.mock.calls[0]!;
       expect(url).toBe("/api/pick");
       expect(JSON.parse(String((init as RequestInit).body))).toEqual({ candidateId: "v1" });
       expect(r.queued.id).toBe("i1");
     });
     it("control POSTs { action } and forwards a value when given", async () => {
       const fn = mockOnce(true, { ok: true });
       await api.control("seek", 42000);
       const [url, init] = fn.mock.calls[0]!;
       expect(url).toBe("/api/control");
       expect(JSON.parse(String((init as RequestInit).body))).toEqual({
         action: "seek",
         value: 42000,
       });
     });
     it("control omits value when not provided (bodyless-ish action like pause)", async () => {
       const fn = mockOnce(true, { ok: true });
       await api.control("pause");
       expect(JSON.parse(String((fn.mock.calls[0]![1] as RequestInit).body))).toEqual({
         action: "pause",
       });
     });
     it("speaker POSTs { action } and returns the active player id", async () => {
       const fn = mockOnce(true, { ok: true, activePlayerDeviceId: "d1" });
       const r = await api.speaker("claim");
       const [url, init] = fn.mock.calls[0]!;
       expect(url).toBe("/api/speaker");
       expect(JSON.parse(String((init as RequestInit).body))).toEqual({ action: "claim" });
       expect(r.activePlayerDeviceId).toBe("d1");
     });
     it("lyrics GETs /api/lyrics with the trackId query and surfaces the null branch", async () => {
       const fn = mockOnce(true, { lyrics: null, source: "lyrics.ovh" });
       const r = await api.lyrics("v1");
       const [url, init] = fn.mock.calls[0]!;
       expect(url).toBe("/api/lyrics?trackId=v1");
       expect((init as RequestInit).method).toBeUndefined(); // GET
       expect(r.lyrics).toBeNull();
     });
     it("logout resolves on an empty 204 body without parsing JSON", async () => {
       const fn = vi.fn().mockResolvedValue({
         ok: true,
         status: 204,
         headers: { get: () => null },
         json: async () => {
           throw new SyntaxError("Unexpected end of JSON input");
         },
       });
       vi.stubGlobal("fetch", fn);
       await expect(api.logout()).resolves.toBeUndefined();
       expect(fn).toHaveBeenCalledWith("/api/logout", expect.objectContaining({ method: "POST" }));
     });
     it("throws ApiError with the status AND the body's error message on non-OK", async () => {
       mockOnce(false, { error: "bad password" }, 401);
       await expect(
         api.login({ password: "x", displayName: "y", deviceId: "z" }),
       ).rejects.toMatchObject({ status: 401, message: "bad password" });
     });
     it("falls back to statusText when the non-OK body has no parseable JSON", async () => {
       const fn = vi.fn().mockResolvedValue({
         ok: false,
         status: 500,
         statusText: "Internal Server Error",
         headers: { get: () => null },
         json: async () => {
           throw new SyntaxError("boom");
         },
       });
       vi.stubGlobal("fetch", fn);
       await expect(api.state()).rejects.toMatchObject({
         status: 500,
         message: "Internal Server Error",
       });
     });
     it("ApiError is an Error subclass named ApiError", () => {
       const e = new ApiError(403, "forbidden");
       expect(e).toBeInstanceOf(Error);
       expect(e.name).toBe("ApiError");
       expect(e.status).toBe(403);
     });
   });
   ```
6. **Run it — expect FAIL.** `npx vitest run web/src/lib/api.test.ts` → fails with `Failed to resolve import "./api.js"`.
7. **Minimal implementation.** Create `web/src/lib/api.ts`:
   ```ts
   import type {
     AddRequest,
     AddResponse,
     ControlAction,
     ControlRequest,
     ControlResponse,
     LoginRequest,
     LyricsResult,
     PickRequest,
     PickResponse,
     SessionInfo,
     SpeakerAction,
     SpeakerRequest,
     SpeakerResponse,
     StationStateResponse,
   } from "../types.js";

   export class ApiError extends Error {
     constructor(
       public readonly status: number,
       message: string,
     ) {
       super(message);
       this.name = "ApiError";
     }
   }

   async function req<T>(url: string, init?: RequestInit): Promise<T> {
     const res = await fetch(url, { credentials: "include", ...init });
     if (!res.ok) {
       let detail = res.statusText;
       try {
         detail = ((await res.json()) as { error?: string }).error ?? detail;
       } catch {
         /* ignore */
       }
       throw new ApiError(res.status, detail);
     }
     // 204 / empty bodies: calling res.json() would throw — short-circuit.
     if (res.status === 204 || res.headers.get("content-length") === "0") return undefined as T;
     return (await res.json()) as T;
   }

   function post<T>(url: string, body?: unknown): Promise<T> {
     // Only attach a JSON content-type when there is a body (Fastify 400s on an empty
     // body sent with application/json).
     const init: RequestInit = { method: "POST" };
     if (body !== undefined) {
       init.headers = { "content-type": "application/json" };
       init.body = JSON.stringify(body);
     }
     return req<T>(url, init);
   }

   export const api = {
     login: (body: LoginRequest) => post<SessionInfo>("/api/login", body),
     logout: () => post<void>("/api/logout"),
     state: () => req<StationStateResponse>("/api/state"),
     add: (urlOrQuery: string) =>
       post<AddResponse>("/api/add", { urlOrQuery } satisfies AddRequest),
     pick: (candidateId: string) =>
       post<PickResponse>("/api/pick", { candidateId } satisfies PickRequest),
     control: (action: ControlAction, value?: ControlRequest["value"]) =>
       post<ControlResponse>(
         "/api/control",
         value === undefined ? { action } : ({ action, value } satisfies ControlRequest),
       ),
     speaker: (action: SpeakerAction) =>
       post<SpeakerResponse>("/api/speaker", { action } satisfies SpeakerRequest),
     lyrics: (trackId: string) =>
       req<LyricsResult>(`/api/lyrics?trackId=${encodeURIComponent(trackId)}`),
   };
   ```
8. **Run it — expect PASS.** `npx vitest run web/src/lib/api.test.ts web/src/lib/deviceId.test.ts` → all passed.

---

### Task 5.2: useStationState WS hook + reducer

**Files**

- Create: `web/src/lib/useStationState.ts`
- Test: `web/src/lib/useStationState.test.ts`
- Test: `web/src/lib/wsReducer.test.ts`

**Interfaces**

- Consumes: 5.1 `getDeviceId`; Phase 0 `StationSnapshot`, `ServerBroadcastMessage`; spec §6 WS protocol.
- Produces:
  - `interface WsState { snapshot: StationSnapshot | null; status: "connecting"|"live"|"forbidden"|"closed"; receivedAt: number; lastError?: { title: string; reason: string; seq: number } | null; }`
  - `initialWsState: WsState`
  - `applyWsMessage(prev: WsState, raw: string): WsState` — handles `{ type:"state", state }` (→ status `"live"`, bumps `receivedAt`) and `{ type:"trackError", videoId, title, reason }` (→ `lastError`, increments `seq`); returns the SAME reference for malformed/unrecognized frames.
  - `reconnectDelayMs(attempt: number): number`
  - `useStationState(): WsState & { socket: WebSocket | null }` — opens `/ws`, sends `hello{ type:"hello", deviceId, role:"remote" }` on open, reconnect/backoff/visibility/online machinery (ported verbatim from the bot's `useGuildState`). It also **exposes the live `socket`** (held in `useState`, so consumers re-render on every (re)connect and on disconnect); `App` passes this to `usePlayerRole`, which attaches its own `addEventListener("message", …)` and `send()` to it (the hook uses `addEventListener`, not `onmessage`, so the two listeners coexist on the one socket).

#### Reducer — steps

1. **Write the failing reducer test.** Create `web/src/lib/wsReducer.test.ts`:
   ```ts
   import { describe, it, expect } from "vitest";
   import { applyWsMessage, initialWsState } from "./useStationState.js";
   import type { StationSnapshot } from "../types.js";

   // Fully-shaped snapshot so the compiler flags any field add/remove and the round-trip
   // assertion is meaningful (de-guilded/de-Discorded fields).
   const snap: StationSnapshot = {
     current: null,
     upcoming: [],
     upcomingRadio: [],
     history: [],
     seed: null,
     paused: false,
     preparing: null,
     activePlayerPresent: false,
     activePlayerLabel: null,
     repeat: "off",
     autoplay: true,
     autoplaySource: "radio",
     volume: 100,
     maxTrackDurationSec: 0,
   };

   describe("applyWsMessage", () => {
     it("applies a state frame and goes live", () => {
       const s = applyWsMessage(initialWsState, JSON.stringify({ type: "state", state: snap }));
       expect(s.status).toBe("live");
       expect(s.snapshot).toEqual(snap);
       expect(s.snapshot?.autoplaySource).toBe("radio");
       expect(s.receivedAt).toBeGreaterThan(0);
     });
     it("ignores malformed frames by returning the SAME reference (no clobbering)", () => {
       const prev = { ...initialWsState, status: "live" as const };
       expect(applyWsMessage(prev, "not json")).toBe(prev);
     });
     it("returns the same reference for an unrecognized frame type", () => {
       const prev = { ...initialWsState, status: "live" as const };
       expect(applyWsMessage(prev, JSON.stringify({ type: "noop" }))).toBe(prev);
     });
     it("sets lastError on a trackError frame and increments seq", () => {
       const s1 = applyWsMessage(
         initialWsState,
         JSON.stringify({ type: "trackError", videoId: "v1", title: "X", reason: "po_token_sabr" }),
       );
       expect(s1.lastError).toMatchObject({ title: "X", reason: "po_token_sabr", seq: 1 });
       const s2 = applyWsMessage(
         s1,
         JSON.stringify({
           type: "trackError",
           videoId: "v2",
           title: "Y",
           reason: "download_failed",
         }),
       );
       expect(s2.lastError).toMatchObject({ title: "Y", reason: "download_failed", seq: 2 });
     });
   });

   describe("reconnectDelayMs", () => {
     it("follows the 1s/2s/4s/8s schedule capped at 15s", () => {
       const { reconnectDelayMs } = require("./useStationState.js");
       expect(reconnectDelayMs(0)).toBe(1000);
       expect(reconnectDelayMs(1)).toBe(2000);
       expect(reconnectDelayMs(2)).toBe(4000);
       expect(reconnectDelayMs(3)).toBe(8000);
       expect(reconnectDelayMs(10)).toBe(15000); // capped
     });
   });
   ```
2. **Run it — expect FAIL.** `npx vitest run web/src/lib/wsReducer.test.ts` → `Failed to resolve import "./useStationState.js"`.
3. **Minimal implementation — reducer + helpers.** Create `web/src/lib/useStationState.ts` with the reducer half first:
   ```ts
   import { useEffect, useReducer, useState } from "react";
   import type { StationSnapshot } from "../types.js";
   import { getDeviceId } from "./deviceId.js";

   export interface WsState {
     snapshot: StationSnapshot | null;
     status: "connecting" | "live" | "forbidden" | "closed";
     /** Local epoch-ms the latest snapshot arrived — extrapolates the moving progress bar. */
     receivedAt: number;
     lastError?: { title: string; reason: string; seq: number } | null;
   }
   export const initialWsState: WsState = {
     snapshot: null,
     status: "connecting",
     receivedAt: 0,
     lastError: null,
   };

   const RECONNECT_BASE_MS = 1000;
   const RECONNECT_CAP_MS = 15000;
   export function reconnectDelayMs(attempt: number): number {
     return Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
   }

   export function applyWsMessage(prev: WsState, raw: string): WsState {
     let msg: { type?: string; state?: StationSnapshot; title?: string; reason?: string };
     try {
       msg = JSON.parse(raw);
     } catch {
       return prev;
     }
     if (msg.type === "state" && msg.state)
       return { ...prev, snapshot: msg.state, status: "live", receivedAt: Date.now() };
     if (msg.type === "trackError") {
       return {
         ...prev,
         lastError: {
           title: msg.title ?? "track",
           reason: msg.reason ?? "failed",
           seq: (prev.lastError?.seq ?? 0) + 1,
         },
       };
     }
     return prev;
   }
   ```
4. **Run it — expect PASS.** `npx vitest run web/src/lib/wsReducer.test.ts` → all passed.

#### Hook — steps

5. **Write the failing hook test.** Create `web/src/lib/useStationState.test.ts`:
   ```ts
   // @vitest-environment jsdom
   import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
   import { renderHook, act } from "@testing-library/react";
   import { useStationState } from "./useStationState.js";

   // Minimal controllable fake WebSocket capturing sends + exposing the open/message hooks.
   class FakeWS {
     static instances: FakeWS[] = [];
     static OPEN = 1;
     static CONNECTING = 0;
     readyState = FakeWS.CONNECTING;
     sent: string[] = [];
     private listeners: Record<string, ((e: unknown) => void)[]> = {};
     constructor(public url: string) {
       FakeWS.instances.push(this);
     }
     addEventListener(type: string, fn: (e: unknown) => void) {
       (this.listeners[type] ??= []).push(fn);
     }
     removeEventListener() {}
     send(data: string) {
       this.sent.push(data);
     }
     close() {
       this.readyState = 3;
       this.emit("close", {});
     }
     emit(type: string, e: unknown) {
       (this.listeners[type] ?? []).forEach((fn) => fn(e));
     }
     fireOpen() {
       this.readyState = FakeWS.OPEN;
       this.emit("open", {});
     }
     fireMessage(data: string) {
       this.emit("message", { data });
     }
   }

   beforeEach(() => {
     FakeWS.instances = [];
     localStorage.clear();
     localStorage.setItem("ljb.deviceId", "dev-abc");
     vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
   });
   afterEach(() => vi.unstubAllGlobals());

   describe("useStationState", () => {
     it("opens /ws and sends hello{deviceId,role:'remote'} on open", () => {
       renderHook(() => useStationState());
       const ws = FakeWS.instances[0]!;
       expect(ws.url).toMatch(/\/ws$/);
       act(() => ws.fireOpen());
       expect(JSON.parse(ws.sent[0]!)).toEqual({
         type: "hello",
         deviceId: "dev-abc",
         role: "remote",
       });
     });
     it("becomes live and stores the snapshot on a state frame", () => {
       const { result } = renderHook(() => useStationState());
       const ws = FakeWS.instances[0]!;
       act(() => ws.fireOpen());
       act(() =>
         ws.fireMessage(JSON.stringify({ type: "state", state: { current: null, paused: false } })),
       );
       expect(result.current.status).toBe("live");
       expect(result.current.snapshot).toMatchObject({ paused: false });
     });
   });
   ```
6. **Run it — expect FAIL.** `npx vitest run web/src/lib/useStationState.test.ts` → fails: `useStationState is not a function` (only the reducer half exists).
7. **Minimal implementation — append the hook.** Add to `web/src/lib/useStationState.ts` (after the reducer; this is the verbatim-ported lifecycle from the bot, hello-frame swapped for `subscribe`):
   ```ts
   type WsAction = { raw: string } | { reset: true } | { closed: true } | { connecting: true };

   function reduce(s: WsState, a: WsAction): WsState {
     if ("reset" in a) return initialWsState;
     if ("connecting" in a) return s.status === "forbidden" ? s : { ...s, status: "connecting" };
     if ("closed" in a) return { ...s, status: s.status === "forbidden" ? s.status : "closed" };
     return applyWsMessage(s, a.raw);
   }

   export function useStationState(): WsState & { socket: WebSocket | null } {
     const [state, dispatch] = useReducer(reduce, initialWsState);
     // Exposed so usePlayerRole can send/attach; updates on every (re)connect.
     const [liveSocket, setLiveSocket] = useState<WebSocket | null>(null);

     useEffect(() => {
       if (typeof WebSocket === "undefined") return;
       dispatch({ reset: true });

       const deviceId = getDeviceId();
       let unmounted = false;
       let socket: WebSocket | null = null;
       let attempt = 0;
       let retryTimer: ReturnType<typeof setTimeout> | null = null;
       let forbidden = false;

       const clearRetry = () => {
         if (retryTimer !== null) {
           clearTimeout(retryTimer);
           retryTimer = null;
         }
       };
       const scheduleReconnect = () => {
         if (unmounted || forbidden || retryTimer !== null) return;
         const delay = reconnectDelayMs(attempt);
         attempt += 1;
         retryTimer = setTimeout(() => {
           retryTimer = null;
           connect();
         }, delay);
       };

       type Tracked = WebSocket & { _dead?: boolean };
       function teardownSocket() {
         if (socket) {
           (socket as Tracked)._dead = true;
           try {
             socket.close();
           } catch {
             /* ignore */
           }
           socket = null;
           setLiveSocket(null);
         }
       }

       function connect() {
         if (unmounted) return;
         clearRetry();
         teardownSocket();
         dispatch({ connecting: true });
         const proto = location.protocol === "https:" ? "wss" : "ws";
         const ws = new WebSocket(`${proto}://${location.host}/ws`) as Tracked;
         socket = ws;
         setLiveSocket(ws);
         ws.addEventListener("open", () => {
           if (ws._dead) return;
           attempt = 0;
           ws.send(JSON.stringify({ type: "hello", deviceId, role: "remote" }));
         });
         ws.addEventListener("message", (e) => {
           if (ws._dead) return;
           dispatch({ raw: String((e as MessageEvent).data) });
         });
         const onDown = () => {
           if (ws._dead || ws !== socket) return;
           ws._dead = true;
           dispatch({ closed: true });
           scheduleReconnect();
         };
         ws.addEventListener("close", onDown);
         ws.addEventListener("error", onDown);
       }

       const reconnectNow = () => {
         if (unmounted || forbidden) return;
         const ready = socket?.readyState;
         if (ready === WebSocket.OPEN || ready === WebSocket.CONNECTING) return;
         clearRetry();
         attempt = 0;
         connect();
       };
       const onVisible = () => {
         if (document.visibilityState === "visible") reconnectNow();
       };

       document.addEventListener("visibilitychange", onVisible);
       window.addEventListener("online", reconnectNow);
       connect();

       return () => {
         unmounted = true;
         clearRetry();
         document.removeEventListener("visibilitychange", onVisible);
         window.removeEventListener("online", reconnectNow);
         teardownSocket();
       };
     }, []);

     return { ...state, socket: liveSocket };
   }
   ```
8. **Run it — expect PASS.** `npx vitest run web/src/lib/useStationState.test.ts web/src/lib/wsReducer.test.ts` → all passed.

---

### Task 5.3: usePlayerRole hidden-audio sink

**Files**

- Create: `web/src/lib/usePlayerRole.ts`
- Test: `web/src/lib/usePlayerRole.test.ts`

**Interfaces**

- Consumes: 5.1 `getDeviceId` (unused here directly; deviceId carried by the WS session); Phase 0 `ServerPlayerMessage`, `ClientWsMessage`; spec §5 browser-autoplay caveat.
- Produces: `usePlayerRole(ws: WebSocket | null, isSpeaker: boolean): { audioRef: React.RefObject<HTMLAudioElement>; volume: number; error: string | null }`.
  - Owns a hidden `<audio>` (the caller mounts `audioRef`).
  - Parses server player frames: `load{audioUrl,startMs}` → set `audio.src` + on `loadedmetadata` seek to `startMs/1000`; `play` → `audio.play()`; `pause` → `audio.pause()`; `seek{ms}` → set `currentTime`; `setVolume{pct}` → `audio.volume = clamp(pct/100, 0..1)` (>100% clamps to 1; track `volume` state for the UI).
  - Reports back over `ws`: `{type:"position",ms}` on `timeupdate` (throttled ~1/s), `{type:"trackEnded"}` on `ended`, `{type:"playbackError",message}` on `error`/`play()` rejection.
  - On `isSpeaker` true → sends `{type:"becomePlayer"}`; on transition to false → sends `{type:"relinquishPlayer"}` and pauses local audio.

#### Steps

1. **Write the failing test.** Create `web/src/lib/usePlayerRole.test.ts`:
   ```ts
   // @vitest-environment jsdom
   import { describe, it, expect, vi, beforeEach } from "vitest";
   import { renderHook, act } from "@testing-library/react";
   import { useRef } from "react";
   import { usePlayerRole } from "./usePlayerRole.js";

   // A fake socket recording sends and letting the test inject server frames.
   function makeWs() {
     const listeners: Record<string, ((e: unknown) => void)[]> = {};
     return {
       sent: [] as string[],
       send(d: string) {
         this.sent.push(d);
       },
       addEventListener(t: string, fn: (e: unknown) => void) {
         (listeners[t] ??= []).push(fn);
       },
       removeEventListener() {},
       fireMessage(data: string) {
         (listeners.message ?? []).forEach((fn) => fn({ data }));
       },
     };
   }

   // Stub HTMLMediaElement methods jsdom doesn't implement.
   beforeEach(() => {
     vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
     vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
   });

   // Helper hook that mounts a real <audio> and wires the ref into usePlayerRole.
   function useHarness(ws: ReturnType<typeof makeWs>, isSpeaker: boolean) {
     const role = usePlayerRole(ws as unknown as WebSocket, isSpeaker);
     const mountRef = useRef<HTMLAudioElement | null>(null);
     return { role, mountRef };
   }

   describe("usePlayerRole", () => {
     it("sends becomePlayer when it becomes the speaker", () => {
       const ws = makeWs();
       renderHook(({ s }) => usePlayerRole(ws as unknown as WebSocket, s), {
         initialProps: { s: true },
       });
       expect(ws.sent.map((m) => JSON.parse(m).type)).toContain("becomePlayer");
     });
     it("sends relinquishPlayer when it stops being the speaker", () => {
       const ws = makeWs();
       const { rerender } = renderHook(({ s }) => usePlayerRole(ws as unknown as WebSocket, s), {
         initialProps: { s: true },
       });
       act(() => rerender({ s: false }));
       expect(ws.sent.map((m) => JSON.parse(m).type)).toContain("relinquishPlayer");
     });
     it("loads the audioUrl and applies setVolume from server frames", () => {
       const ws = makeWs();
       const { result } = renderHook(() => usePlayerRole(ws as unknown as WebSocket, true));
       const el = document.createElement("audio");
       act(() => {
         (result.current.audioRef as React.MutableRefObject<HTMLAudioElement | null>).current = el;
       });
       act(() =>
         ws.fireMessage(JSON.stringify({ type: "load", audioUrl: "/audio/v1", startMs: 0 })),
       );
       expect(el.getAttribute("src")).toBe("/audio/v1");
       act(() => ws.fireMessage(JSON.stringify({ type: "setVolume", pct: 50 })));
       expect(el.volume).toBeCloseTo(0.5);
       expect(result.current.volume).toBe(50);
     });
     it("clamps setVolume above 100% to 1.0 on the element but keeps the pct for the UI", () => {
       const ws = makeWs();
       const { result } = renderHook(() => usePlayerRole(ws as unknown as WebSocket, true));
       const el = document.createElement("audio");
       act(() => {
         (result.current.audioRef as React.MutableRefObject<HTMLAudioElement | null>).current = el;
       });
       act(() => ws.fireMessage(JSON.stringify({ type: "setVolume", pct: 150 })));
       expect(el.volume).toBe(1);
       expect(result.current.volume).toBe(150);
     });
     it("reports trackEnded on the audio 'ended' event", () => {
       const ws = makeWs();
       const { result } = renderHook(() => usePlayerRole(ws as unknown as WebSocket, true));
       const el = document.createElement("audio");
       act(() => {
         (result.current.audioRef as React.MutableRefObject<HTMLAudioElement | null>).current = el;
       });
       // Re-render so the effect re-binds to the now-present element.
       act(() => ws.fireMessage(JSON.stringify({ type: "play" })));
       act(() => el.dispatchEvent(new Event("ended")));
       expect(ws.sent.map((m) => JSON.parse(m).type)).toContain("trackEnded");
     });
   });
   ```
2. **Run it — expect FAIL.** `npx vitest run web/src/lib/usePlayerRole.test.ts` → `Failed to resolve import "./usePlayerRole.js"`.
3. **Minimal implementation.** Create `web/src/lib/usePlayerRole.ts`:
   ```ts
   import { useEffect, useRef, useState } from "react";
   import type { ServerPlayerMessage, ClientWsMessage } from "../types.js";

   /**
    * Owns a hidden <audio> sink. Subscribes to server player frames over `ws` and reports
    * playback telemetry back. The caller mounts `audioRef` on a real <audio> element.
    * Spec §5: a fresh load can't autoplay without a user gesture / granted permission;
    * a rejected play() surfaces as a playbackError (the operator grants autoplay once).
    */
   export function usePlayerRole(
     ws: WebSocket | null,
     isSpeaker: boolean,
   ): { audioRef: React.RefObject<HTMLAudioElement>; volume: number; error: string | null } {
     const audioRef = useRef<HTMLAudioElement>(null);
     const [volume, setVolume] = useState(100);
     const [error, setError] = useState<string | null>(null);
     const lastPosSentRef = useRef(0);

     const send = (msg: ClientWsMessage) => {
       if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
     };

     // Announce / relinquish the player role on the speaker transition.
     useEffect(() => {
       if (!ws) return;
       if (isSpeaker) {
         send({ type: "becomePlayer" });
       } else {
         send({ type: "relinquishPlayer" });
         audioRef.current?.pause();
       }
       // eslint-disable-next-line react-hooks/exhaustive-deps
     }, [ws, isSpeaker]);

     // Server → player command frames.
     useEffect(() => {
       if (!ws) return;
       const onMessage = (e: MessageEvent) => {
         let msg: ServerPlayerMessage;
         try {
           msg = JSON.parse(String(e.data));
         } catch {
           return;
         }
         const el = audioRef.current;
         if (!el) return;
         switch (msg.type) {
           case "load": {
             el.src = msg.audioUrl;
             const startMs = msg.startMs;
             const seekToStart = () => {
               try {
                 el.currentTime = startMs / 1000;
               } catch {
                 /* ignore */
               }
             };
             el.addEventListener("loadedmetadata", seekToStart, { once: true });
             el.load();
             break;
           }
           case "play":
             setError(null);
             el.play().catch((err: unknown) => {
               const message = err instanceof Error ? err.message : "play blocked";
               setError(message);
               send({ type: "playbackError", message });
             });
             break;
           case "pause":
             el.pause();
             break;
           case "seek":
             try {
               el.currentTime = msg.ms / 1000;
             } catch {
               /* ignore */
             }
             break;
           case "setVolume": {
             const pct = msg.pct;
             el.volume = Math.max(0, Math.min(1, pct / 100));
             setVolume(pct);
             break;
           }
         }
       };
       ws.addEventListener("message", onMessage as EventListener);
       return () => ws.removeEventListener("message", onMessage as EventListener);
       // eslint-disable-next-line react-hooks/exhaustive-deps
     }, [ws]);

     // Audio element → telemetry.
     useEffect(() => {
       const el = audioRef.current;
       if (!el || !ws) return;
       const onTime = () => {
         const ms = Math.floor(el.currentTime * 1000);
         if (ms - lastPosSentRef.current >= 900 || ms < lastPosSentRef.current) {
           lastPosSentRef.current = ms;
           send({ type: "position", ms });
         }
       };
       const onEnded = () => send({ type: "trackEnded" });
       const onError = () => {
         const message = el.error ? `media error ${el.error.code}` : "media error";
         setError(message);
         send({ type: "playbackError", message });
       };
       el.addEventListener("timeupdate", onTime);
       el.addEventListener("ended", onEnded);
       el.addEventListener("error", onError);
       return () => {
         el.removeEventListener("timeupdate", onTime);
         el.removeEventListener("ended", onEnded);
         el.removeEventListener("error", onError);
       };
       // eslint-disable-next-line react-hooks/exhaustive-deps
     }, [ws, isSpeaker]);

     return { audioRef, volume, error };
   }
   ```
4. **Run it — expect PASS.** `npx vitest run web/src/lib/usePlayerRole.test.ts` → all passed.

---

### Task 5.4: LoginGate + PlayerPanel

**Files**

- Create: `web/src/components/LoginGate.tsx`
- Test: `web/src/components/LoginGate.test.tsx`
- Create: `web/src/components/PlayerPanel.tsx`
- Test: `web/src/components/PlayerPanel.test.tsx`

**Interfaces**

- Consumes: 5.1 `api.login`, `getDeviceId`/`getDisplayName`/`setDisplayName`; 5.3 `usePlayerRole` (audioRef is passed in by App, not created here); Phase 0 `SessionInfo`.
- Produces:
  - `LoginGate({ onAuthed }: { onAuthed: (s: SessionInfo) => void })` — shared-password + displayName form; submits `api.login({ password, displayName, deviceId })`; surfaces the error message on failure; calls `onAuthed` with the session. (Single shared password — no admin-unlock form.)
  - `PlayerPanel({ isSpeaker, onRelinquish, audioRef }: { isSpeaker: boolean; onRelinquish: () => void; audioRef: React.RefObject<HTMLAudioElement> })` — "This device is the speaker" + a relinquish button + the managed hidden `<audio>` mount point (`ref={audioRef}`).

#### LoginGate — steps

1. **Write the failing test.** Create `web/src/components/LoginGate.test.tsx`:
   ```tsx
   // @vitest-environment jsdom
   import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
   import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
   import { LoginGate } from "./LoginGate.js";
   import { api } from "../lib/api.js";

   beforeEach(() => localStorage.clear());
   afterEach(() => {
     cleanup();
     vi.restoreAllMocks();
   });

   describe("LoginGate", () => {
     it("submits the password + displayName + deviceId and calls onAuthed with the session", async () => {
       const session = { displayName: "Al", deviceId: expect.any(String) };
       const spy = vi.spyOn(api, "login").mockResolvedValue(session as never);
       const onAuthed = vi.fn();
       render(<LoginGate onAuthed={onAuthed} />);
       fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "Al" } });
       fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "pw" } });
       fireEvent.click(screen.getByRole("button", { name: /enter|sign in|log in/i }));
       await waitFor(() => expect(spy).toHaveBeenCalled());
       const arg = spy.mock.calls[0]![0];
       expect(arg).toMatchObject({ password: "pw", displayName: "Al" });
       expect(arg.deviceId).toMatch(/.+/);
       await waitFor(() => expect(onAuthed).toHaveBeenCalledWith(session));
     });
     it("shows the server error message on a failed login and does not call onAuthed", async () => {
       vi.spyOn(api, "login").mockRejectedValue(
         Object.assign(new Error("bad password"), { name: "ApiError", status: 401 }),
       );
       const onAuthed = vi.fn();
       render(<LoginGate onAuthed={onAuthed} />);
       fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "Al" } });
       fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "wrong" } });
       fireEvent.click(screen.getByRole("button", { name: /enter|sign in|log in/i }));
       expect(await screen.findByText(/bad password/i)).toBeTruthy();
       expect(onAuthed).not.toHaveBeenCalled();
     });
   });
   ```
2. **Run it — expect FAIL.** `npx vitest run web/src/components/LoginGate.test.tsx` → `Failed to resolve import "./LoginGate.js"`.
3. **Minimal implementation.** Create `web/src/components/LoginGate.tsx`:
   ```tsx
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
   ```
4. **Run it — expect PASS.** `npx vitest run web/src/components/LoginGate.test.tsx` → all passed.

#### PlayerPanel — steps

5. **Write the failing test.** Create `web/src/components/PlayerPanel.test.tsx`:
   ```tsx
   // @vitest-environment jsdom
   import { describe, it, expect, vi, afterEach } from "vitest";
   import { render, screen, fireEvent, cleanup } from "@testing-library/react";
   import { createRef } from "react";
   import { PlayerPanel } from "./PlayerPanel.js";

   afterEach(() => cleanup());

   describe("PlayerPanel", () => {
     it("announces this device is the speaker and mounts the audio element on the ref", () => {
       const audioRef = createRef<HTMLAudioElement>();
       const { container } = render(
         <PlayerPanel isSpeaker onRelinquish={() => {}} audioRef={audioRef} />,
       );
       expect(screen.getByText(/this device is the speaker/i)).toBeTruthy();
       const audio = container.querySelector("audio");
       expect(audio).toBeTruthy();
       expect(audioRef.current).toBe(audio); // the ref is wired to the real element
     });
     it("calls onRelinquish when the relinquish control is clicked", () => {
       const audioRef = createRef<HTMLAudioElement>();
       const onRelinquish = vi.fn();
       render(<PlayerPanel isSpeaker onRelinquish={onRelinquish} audioRef={audioRef} />);
       fireEvent.click(screen.getByRole("button", { name: /relinquish|stop being the speaker/i }));
       expect(onRelinquish).toHaveBeenCalledTimes(1);
     });
     it("still mounts the (hidden) audio element when this device is NOT the speaker", () => {
       const audioRef = createRef<HTMLAudioElement>();
       const { container } = render(
         <PlayerPanel isSpeaker={false} onRelinquish={() => {}} audioRef={audioRef} />,
       );
       expect(container.querySelector("audio")).toBeTruthy(); // audio always mounted so commands can load
       expect(screen.queryByText(/this device is the speaker/i)).toBeNull();
     });
   });
   ```
6. **Run it — expect FAIL.** `npx vitest run web/src/components/PlayerPanel.test.tsx` → `Failed to resolve import "./PlayerPanel.js"`.
7. **Minimal implementation.** Create `web/src/components/PlayerPanel.tsx`:
   ```tsx
   export function PlayerPanel({
     isSpeaker,
     onRelinquish,
     audioRef,
   }: {
     isSpeaker: boolean;
     onRelinquish: () => void;
     audioRef: React.RefObject<HTMLAudioElement>;
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
   ```
8. **Run it — expect PASS.** `npx vitest run web/src/components/PlayerPanel.test.tsx web/src/components/LoginGate.test.tsx` → all passed.

---

### Task 5.5: De-guild/de-Discord reused panels

**Files** (port each from `~/discord-yt-music-bot/web/src/components/`, prune Discord/guild/removed features, re-skin against 5.1's design system)

- Modify(port): `web/src/components/AddBar.tsx` + Test `AddBar.test.tsx`
- Modify(port): `web/src/components/Controls.tsx` + Test `Controls.test.tsx`
- Modify(port): `web/src/components/NowPlaying.tsx` + Test `NowPlaying.test.tsx`
- Modify(port): `web/src/components/Queue.tsx` + Test `Queue.test.tsx`
- Modify(port): `web/src/components/History.tsx` + Test `History.test.tsx`
- Modify(port): `web/src/components/Lyrics.tsx` + Test `Lyrics.test.tsx`
- Modify(port): `web/src/components/Settings.tsx` + Test `Settings.test.tsx`
- (Verbatim helpers, no test changes needed beyond a smoke render: `Picker.tsx`, `Thumb.tsx`, `Grain.tsx`, `Preparing.tsx`)

**Interfaces** (Produces — exact props)

- `AddBar({ onPlay, onQueueAll, busy }: { onPlay: (input: string) => Promise<{ candidates: TrackMeta[] | null }>; onQueueAll: (videoIds: string[]) => Promise<boolean>; busy?: boolean })` — drops the voice-target busy state.
- `Controls({ onAction, paused, disabled }: { onAction: (a: "skip"|"pause"|"resume") => void; paused: boolean; disabled?: boolean })` — **Stop button removed.**
- `NowPlaying({ item, paused, receivedAt, canSeek, onSeek }: { item: CurrentItem | null; paused?: boolean; receivedAt?: number; canSeek?: boolean; onSeek?: (positionMs: number) => void | Promise<void> })` — **Visualizer removed; `requester.displayName` only (no avatarUrl); `source` line kept.**
- `Queue({ items, current, upcomingRadio, onRemove, onReorder, onPlayNext, onJump, onShuffle, onClear, autoplay, autoplaySource, onToggleAutoplay }: { items: QueueItem[]; current: CurrentItem | null; upcomingRadio: QueueItem[]; onRemove: (id: string) => void; onReorder: (id: string, toIndex: number) => void; onPlayNext: (id: string) => void; onJump: (id: string) => void; onShuffle: () => void; onClear: () => void; autoplay: boolean; autoplaySource: AutoplaySource; onToggleAutoplay: (on: boolean) => void })` — adds the AutoDiscover(radio) toggle + an **upcoming-radio preview section** (`fromRadio` items).
- `History({ history, onRequeue }: { history: QueueItem[]; onRequeue: (videoId: string) => void })`.
- `Lyrics({ trackId }: { trackId: string })` — lazy fetch via `api.lyrics(trackId)`.
- `Settings({ repeat, autoplay, autoplaySource, volume, maxTrackDurationSec, disabled, onChange }: { repeat: RepeatMode; autoplay: boolean; autoplaySource: AutoplaySource; volume: number; maxTrackDurationSec: number; disabled?: boolean; onChange: (patch: Partial<StationSettings>) => void })` — **idle/crossfade/normalize/fx/commandChannel ALL removed.**

> Each panel + its test is parallel-safe (disjoint files) once 5.1 is fixed. Below are the two highest-risk ports (Controls — Stop removal; Settings — heavy pruning) in full TDD detail. The remaining six follow the same write-failing-test → port-and-prune → pass loop; their exact pruned props are listed above (no placeholders — copy the bot file, delete the removed branches, rename `voiceChannelId`/`guildId` away, swap `requester.avatarUrl` for the `displayName`-only credit line, and import shared types from `../types.js`).

#### Controls (Stop removed) — steps

1. **Write the failing test.** Create `web/src/components/Controls.test.tsx`:
   ```tsx
   // @vitest-environment jsdom
   import { describe, it, expect, vi, afterEach } from "vitest";
   import { render, screen, fireEvent, cleanup } from "@testing-library/react";
   import { Controls } from "./Controls.js";

   afterEach(() => cleanup());

   describe("Controls", () => {
     it("shows Pause + Skip and has NO Stop button (the station never stops)", () => {
       render(<Controls onAction={() => {}} paused={false} />);
       expect(screen.getByRole("button", { name: /pause/i })).toBeTruthy();
       expect(screen.getByRole("button", { name: /skip/i })).toBeTruthy();
       expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
     });
     it("emits resume when paused and pause when playing", () => {
       const onAction = vi.fn();
       const { rerender } = render(<Controls onAction={onAction} paused />);
       fireEvent.click(screen.getByRole("button", { name: /resume/i }));
       expect(onAction).toHaveBeenCalledWith("resume");
       rerender(<Controls onAction={onAction} paused={false} />);
       fireEvent.click(screen.getByRole("button", { name: /pause/i }));
       expect(onAction).toHaveBeenCalledWith("pause");
     });
     it("emits skip", () => {
       const onAction = vi.fn();
       render(<Controls onAction={onAction} paused={false} />);
       fireEvent.click(screen.getByRole("button", { name: /skip/i }));
       expect(onAction).toHaveBeenCalledWith("skip");
     });
   });
   ```
2. **Run it — expect FAIL.** `npx vitest run web/src/components/Controls.test.tsx` → `Failed to resolve import "./Controls.js"`.
3. **Minimal implementation (ported, Stop deleted).** Create `web/src/components/Controls.tsx`:
   ```tsx
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
   ```
4. **Run it — expect PASS.** `npx vitest run web/src/components/Controls.test.tsx` → all passed.

#### Settings (pruned to surviving fields) — steps

5. **Write the failing test.** Create `web/src/components/Settings.test.tsx`:
   ```tsx
   // @vitest-environment jsdom
   import { describe, it, expect, vi, afterEach } from "vitest";
   import { render, screen, fireEvent, cleanup } from "@testing-library/react";
   import { Settings } from "./Settings.js";

   afterEach(() => cleanup());

   const base = {
     repeat: "off" as const,
     autoplay: true,
     autoplaySource: "radio" as const,
     volume: 100,
     maxTrackDurationSec: 0,
   };

   describe("Settings (pruned)", () => {
     it("renders only the surviving controls and NONE of the removed Discord ones", () => {
       render(<Settings {...base} onChange={() => {}} />);
       expect(screen.getByLabelText(/repeat mode/i)).toBeTruthy();
       expect(screen.getByLabelText(/^volume$/i)).toBeTruthy();
       expect(screen.getByLabelText(/autoplay/i)).toBeTruthy();
       expect(screen.getByLabelText(/max track length/i)).toBeTruthy();
       // Removed for the jukebox:
       expect(screen.queryByLabelText(/leave channel/i)).toBeNull();
       expect(screen.queryByLabelText(/crossfade/i)).toBeNull();
       expect(screen.queryByLabelText(/normalize/i)).toBeNull();
       expect(screen.queryByLabelText(/fx preset/i)).toBeNull();
       expect(screen.queryByLabelText(/command channel/i)).toBeNull();
     });
     it("emits a Partial<StationSettings> patch when repeat changes", () => {
       const onChange = vi.fn();
       render(<Settings {...base} onChange={onChange} />);
       fireEvent.change(screen.getByLabelText(/repeat mode/i), { target: { value: "all" } });
       expect(onChange).toHaveBeenCalledWith({ repeat: "all" });
     });
     it("emits a volume patch as a number", () => {
       const onChange = vi.fn();
       render(<Settings {...base} onChange={onChange} />);
       fireEvent.change(screen.getByLabelText(/^volume$/i), { target: { value: "150" } });
       expect(onChange).toHaveBeenCalledWith({ volume: 150 });
     });
     it("shows the autoplay source picker only while autoplay is ON", () => {
       const { rerender } = render(<Settings {...base} autoplay={false} onChange={() => {}} />);
       expect(screen.queryByLabelText(/autoplay source/i)).toBeNull();
       rerender(<Settings {...base} autoplay onChange={() => {}} />);
       expect(screen.getByLabelText(/autoplay source/i)).toBeTruthy();
     });
   });
   ```
6. **Run it — expect FAIL.** `npx vitest run web/src/components/Settings.test.tsx` → `Failed to resolve import "./Settings.js"`.
7. **Minimal implementation (ported, pruned).** Create `web/src/components/Settings.tsx`:
   ```tsx
   import type { AutoplaySource, RepeatMode, StationSettings } from "../types.js";

   const MAX_LEN_PRESETS: { sec: number; label: string }[] = [
     { sec: 3600, label: "1 hour" },
     { sec: 7200, label: "2 hours" },
     { sec: 10800, label: "3 hours" },
     { sec: 14400, label: "4 hours" },
     { sec: 21600, label: "6 hours" },
     { sec: 0, label: "No limit" },
   ];
   const REPEAT_LABELS: Record<RepeatMode, string> = {
     off: "Off",
     one: "Repeat one",
     all: "Repeat all",
   };
   const AUTOPLAY_SOURCE_LABELS: Record<AutoplaySource, string> = {
     radio: "Radio / Mix",
     artist: "Artist",
   };
   const VOLUME_MAX = 200;

   export function Settings({
     repeat,
     autoplay,
     autoplaySource,
     volume,
     maxTrackDurationSec,
     disabled,
     onChange,
   }: {
     repeat: RepeatMode;
     autoplay: boolean;
     autoplaySource: AutoplaySource;
     volume: number;
     maxTrackDurationSec: number;
     disabled?: boolean;
     onChange: (patch: Partial<StationSettings>) => void;
   }) {
     const inputStyle = {
       border: "1px solid var(--color-line)",
       color: "var(--color-ink)",
     } as const;
     const selectClass = "bg-transparent px-3 py-2 text-sm font-mono tracking-tight";
     const optStyle = { background: "var(--color-raised)", color: "var(--color-ink)" } as const;
     const maxLenIsPreset = MAX_LEN_PRESETS.some((p) => p.sec === maxTrackDurationSec);

     return (
       <div className="flex flex-wrap items-center gap-x-5 gap-y-3" aria-label="Playback settings">
         <label className="flex flex-col gap-1.5">
           <span className="eyebrow">Repeat</span>
           <select
             aria-label="Repeat mode"
             value={repeat}
             disabled={disabled}
             onChange={(e) => onChange({ repeat: e.target.value as RepeatMode })}
             className={selectClass}
             style={inputStyle}
           >
             {(Object.keys(REPEAT_LABELS) as RepeatMode[]).map((m) => (
               <option key={m} value={m} style={optStyle}>
                 {REPEAT_LABELS[m]}
               </option>
             ))}
           </select>
         </label>

         <label className="flex flex-col gap-1.5">
           <span className="eyebrow">Volume</span>
           <div className="flex items-center gap-3">
             <input
               type="range"
               min={0}
               max={VOLUME_MAX}
               step={5}
               aria-label="Volume"
               value={volume}
               disabled={disabled}
               onChange={(e) => onChange({ volume: Number(e.target.value) })}
               style={{ "--range-fill": `${(volume / VOLUME_MAX) * 100}%` } as React.CSSProperties}
             />
             <span
               className="font-mono tabular-nums text-sm"
               style={{ minWidth: "4ch", color: "var(--color-ink)", textAlign: "right" }}
             >
               {volume}%
             </span>
           </div>
         </label>

         <label className="flex flex-col gap-1.5">
           <span className="eyebrow">Max track length</span>
           <select
             aria-label="Max track length"
             value={String(maxTrackDurationSec)}
             disabled={disabled}
             onChange={(e) => onChange({ maxTrackDurationSec: Number(e.target.value) })}
             className={selectClass}
             style={inputStyle}
           >
             {!maxLenIsPreset && (
               <option
                 key={maxTrackDurationSec}
                 value={String(maxTrackDurationSec)}
                 style={optStyle}
               >
                 {maxTrackDurationSec}s (current)
               </option>
             )}
             {MAX_LEN_PRESETS.map((p) => (
               <option key={p.sec} value={String(p.sec)} style={optStyle}>
                 {p.label}
               </option>
             ))}
           </select>
         </label>

         <div className="flex flex-col gap-1.5">
           <span className="eyebrow">Autoplay</span>
           <div className="flex items-center gap-4">
             <label
               className="flex items-center gap-2 text-sm"
               style={{ color: "var(--color-ink-dim)" }}
             >
               <input
                 type="checkbox"
                 aria-label="Autoplay"
                 checked={autoplay}
                 disabled={disabled}
                 onChange={(e) => onChange({ autoplay: e.target.checked })}
               />
               <span className="font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>
                 {autoplay ? "ON" : "OFF"}
               </span>
             </label>
             {autoplay && (
               <label className="flex items-center gap-2">
                 <span className="eyebrow">Source</span>
                 <select
                   aria-label="Autoplay source"
                   value={autoplaySource}
                   disabled={disabled}
                   onChange={(e) => onChange({ autoplaySource: e.target.value as AutoplaySource })}
                   className={selectClass}
                   style={inputStyle}
                 >
                   {(Object.keys(AUTOPLAY_SOURCE_LABELS) as AutoplaySource[]).map((s) => (
                     <option key={s} value={s} style={optStyle}>
                       {AUTOPLAY_SOURCE_LABELS[s]}
                     </option>
                   ))}
                 </select>
               </label>
             )}
           </div>
         </div>
       </div>
     );
   }
   ```
8. **Run it — expect PASS.** `npx vitest run web/src/components/Settings.test.tsx` → all passed.

#### Remaining ports — steps (one loop each, same pattern)

9. **AddBar:** write `AddBar.test.tsx` asserting (a) typing + submit calls `onPlay(value)` and clears the box, (b) when `onPlay` resolves `{candidates:[...]}` the `Picker` renders and `onQueueAll` is wired, (c) `busy`/`pending` disables the input + button. Port the bot's `AddBar.tsx` verbatim except: import `TrackMeta` from `../types.js`, keep the `Picker` import. **Run FAIL → PASS** (`npx vitest run web/src/components/AddBar.test.tsx`).
10. **NowPlaying:** write `NowPlaying.test.tsx` asserting (a) the empty-state "Nothing is playing" renders for `item=null`, (b) for a populated `CurrentItem` the title/channel render and the requester credit shows `requester.displayName` (and `· source`) with **no `<img>` avatar**, (c) the `ProgressBar` is read-only when `canSeek=false` (role `progressbar`) and a slider when `canSeek` + `durationMs>0`, calling `onSeek` on release. Port the bot file but **delete the `Visualizer` import + `<Visualizer/>` line, delete the `<img src={requester.avatarUrl}>` and inline the `displayName`-only credit, delete the embedded `<Lyrics guildId=…/>` call** (Lyrics is now App-driven), import `CurrentItem` from `../types.js`. **Run FAIL → PASS.**
11. **Queue:** write `Queue.test.tsx` asserting (a) explicit `items` render with remove/reorder/play-next/jump buttons wired, (b) a separate **"Up next on the radio" preview** section renders `upcomingRadio` items tagged from-radio and is read-only (no remove), (c) the AutoDiscover toggle reflects `autoplay` and calls `onToggleAutoplay`, (d) `onShuffle`/`onClear` wired. Port the bot `Queue.tsx`, add the `upcomingRadio` preview block + the autoplay toggle, import `QueueItem`/`CurrentItem`/`AutoplaySource` from `../types.js`. **Run FAIL → PASS.**
12. **History:** write `History.test.tsx` asserting each `history` entry renders and clicking re-queue calls `onRequeue(videoId)`. Port `History.tsx`, swap the requeue arg to `meta.videoId`, import `QueueItem`. **Run FAIL → PASS.**
13. **Lyrics:** write `Lyrics.test.tsx` (jsdom) asserting (a) it calls `api.lyrics(trackId)` on expand and renders the returned text, (b) the null branch shows "No lyrics found." Port `Lyrics.tsx` to take `{ trackId }` and call `api.lyrics(trackId)` (drop `guildId`/`videoId`). **Run FAIL → PASS.**
14. **Helpers smoke:** copy `Picker.tsx`, `Thumb.tsx`, `Grain.tsx`, `Preparing.tsx` verbatim (Picker/Preparing already have ported tests `Picker.test.tsx`/`Preparing.test.tsx` from the bot — copy those too and run them green). **Run** `npx vitest run web/src/components/Picker.test.tsx web/src/components/Preparing.test.tsx` → all passed.
15. **Run the whole panel set — expect PASS.** `npx vitest run web/src/components/` → all panel tests green.

---

### Task 5.6: App root — session + station status + role wiring

**Files**

- Create: `web/src/components/App.tsx`
- Test: `web/src/components/App.test.tsx`

**Interfaces**

- Consumes: 5.1 `api`/`getDeviceId`/`getDisplayName`; 5.2 `useStationState`; 5.3 `usePlayerRole`; 5.4 `LoginGate`/`PlayerPanel`; 5.5 all panels; Phase 0 `StationStateResponse`, `SessionInfo`, `ControlAction`, `TrackMeta`.
- Produces: `App()` —
  - Session check: on mount `api.state()`; a 401 (`ApiError.status === 401`) → render `LoginGate`; success → render the station.
  - deviceId bootstrap (calls `getDeviceId()` so the token exists before the WS connects).
  - Station-live vs cold-start banner: when `snapshot.seed === null && snapshot.current === null` show **"Queue a song to start the station."**; otherwise the live station.
  - Optimistic-pause + generation-guard banner system (a monotonic op-generation so a stale WS snapshot can't revert a just-issued pause/skip), and a transient error banner fed by `wsState.lastError`.
  - becomePlayer toggle + auto-speaker: claiming the Player needs the per-socket sink, so it is done over the WS (`usePlayerRole` sends `{type:"becomePlayer"}`), NOT via REST. A local `wantsSpeaker` state flag is what App passes to `usePlayerRole` as `isSpeaker`; when `snapshot.isThisDeviceSpeaker` (from the per-viewer `StationStateResponse`, set by the server when this device is the remembered/auto-selected speaker) is true, App initializes `wantsSpeaker` true so the role auto-engages. A "Play on this device" button sets `wantsSpeaker=true` (→ WS `becomePlayer`); relinquish sets `wantsSpeaker=false` (→ WS `relinquishPlayer`) AND best-effort `api.speaker("release")` to clear the persisted designation. The sink-free `api.speaker("remember"|"forget"|"release")` REST calls back the "Remember this device" / "Forget" / "Relinquish" controls; `api.speaker("claim")` is never sent (the backend 400s it — claim is the WS path).
  - Lays out `PlayerPanel` + all panels, wiring their handlers to `api.add`/`api.pick`/`api.control`/`api.speaker`/`api.lyrics`. The `Lyrics` panel is keyed on `snap?.current?.meta.videoId` and lazy-fetches via `api.lyrics(trackId)`.

#### Steps

1. **Write the failing test.** Create `web/src/components/App.test.tsx`:
   ```tsx
   // @vitest-environment jsdom
   import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
   import { render, screen, waitFor, cleanup } from "@testing-library/react";
   import { App } from "./App.js";
   import { api, ApiError } from "../lib/api.js";

   // The App composes useStationState (opens a WS) — provide a no-op fake so the hook
   // doesn't throw and the App renders its initial snapshot=null state.
   beforeEach(() => {
     localStorage.clear();
     class NoopWS {
       static OPEN = 1;
       static CONNECTING = 0;
       readyState = 0;
       addEventListener() {}
       removeEventListener() {}
       send() {}
       close() {}
     }
     vi.stubGlobal("WebSocket", NoopWS as unknown as typeof WebSocket);
   });
   afterEach(() => {
     cleanup();
     vi.restoreAllMocks();
     vi.unstubAllGlobals();
   });

   describe("App", () => {
     it("renders the LoginGate when /api/state returns 401", async () => {
       vi.spyOn(api, "state").mockRejectedValue(new ApiError(401, "unauthorized"));
       render(<App />);
       expect(await screen.findByLabelText(/password/i)).toBeTruthy();
     });
     it("shows the cold-start banner when there is no seed and nothing playing", async () => {
       vi.spyOn(api, "state").mockResolvedValue({
         current: null,
         upcoming: [],
         upcomingRadio: [],
         history: [],
         seed: null,
         paused: false,
         preparing: null,
         activePlayerPresent: false,
         activePlayerLabel: null,
         repeat: "off",
         autoplay: true,
         autoplaySource: "radio",
         volume: 100,
         maxTrackDurationSec: 0,
         isThisDeviceSpeaker: false,
       } as never);
       render(<App />);
       expect(await screen.findByText(/queue a song to start the station/i)).toBeTruthy();
     });
     it("does NOT show the cold-start banner once a seed exists", async () => {
       vi.spyOn(api, "state").mockResolvedValue({
         current: null,
         upcoming: [],
         upcomingRadio: [],
         history: [],
         seed: {
           videoId: "v1",
           title: "Seed",
           channel: "C",
           durationSec: 100,
           isLive: false,
           thumbnailUrl: null,
         },
         paused: false,
         preparing: null,
         activePlayerPresent: false,
         activePlayerLabel: null,
         repeat: "off",
         autoplay: true,
         autoplaySource: "radio",
         volume: 100,
         maxTrackDurationSec: 0,
         isThisDeviceSpeaker: false,
       } as never);
       render(<App />);
       await waitFor(() => expect(api.state).toHaveBeenCalled());
       expect(screen.queryByText(/queue a song to start the station/i)).toBeNull();
     });
   });
   ```
2. **Run it — expect FAIL.** `npx vitest run web/src/components/App.test.tsx` → `Failed to resolve import "./App.js"`.
3. **Minimal implementation.** Create `web/src/components/App.tsx`:
   ```tsx
   import { useCallback, useEffect, useState } from "react";
   import type { SessionInfo, StationStateResponse } from "../types.js";
   import { api, ApiError } from "../lib/api.js";
   import { getDeviceId } from "../lib/deviceId.js";
   import { useStationState } from "../lib/useStationState.js";
   import { usePlayerRole } from "../lib/usePlayerRole.js";
   import { LoginGate } from "./LoginGate.js";
   import { PlayerPanel } from "./PlayerPanel.js";
   import { AddBar } from "./AddBar.js";
   import { Controls } from "./Controls.js";
   import { NowPlaying } from "./NowPlaying.js";
   import { Queue } from "./Queue.js";
   import { History } from "./History.js";
   import { Lyrics } from "./Lyrics.js";
   import { Settings } from "./Settings.js";
   import { Grain } from "./Grain.js";

   type AuthState = "checking" | "anon" | "authed";

   export function App() {
     const [auth, setAuth] = useState<AuthState>("checking");
     const [, setSession] = useState<SessionInfo | null>(null);
     // Per-viewer flags from the REST snapshot (the WS broadcast carries the shared
     // StationSnapshot; isThisDeviceSpeaker comes from /api/state).
     const [meta, setMeta] = useState<Pick<StationStateResponse, "isThisDeviceSpeaker"> | null>(
       null,
     );
     const ws = useStationState();

     // Bootstrap: ensure a deviceId exists, then probe the session.
     useEffect(() => {
       getDeviceId();
       let alive = true;
       api
         .state()
         .then((s) => {
           if (!alive) return;
           setMeta({ isThisDeviceSpeaker: s.isThisDeviceSpeaker });
           setAuth("authed");
         })
         .catch((e) => {
           if (!alive) return;
           setAuth(e instanceof ApiError && e.status === 401 ? "anon" : "authed");
         });
       return () => {
         alive = false;
       };
     }, []);

     // Auto-engage the speaker role when the server marks this device the remembered
     // speaker; the manual "Play on this device" / relinquish controls toggle this
     // same flag (see the becomePlayer/relinquish prose in this task's Notes).
     const isSpeaker = meta?.isThisDeviceSpeaker ?? false;
     const { audioRef, error: playerError } = usePlayerRole(ws.socket, isSpeaker);

     const onControl = useCallback(
       (action: Parameters<typeof api.control>[0], value?: Parameters<typeof api.control>[1]) =>
         void api.control(action, value),
       [],
     );
     const onRelinquish = useCallback(() => void api.speaker("release"), []);

     if (auth === "checking") {
       return (
         <main className="min-h-full grid place-items-center">
           <span className="spinner" aria-label="Loading" />
         </main>
       );
     }
     if (auth === "anon") {
       return (
         <LoginGate
           onAuthed={(s) => {
             setSession(s);
             setAuth("authed");
             api.state().then((st) => setMeta({ isThisDeviceSpeaker: st.isThisDeviceSpeaker }));
           }}
         />
       );
     }

     const snap = ws.snapshot;
     const coldStart = snap !== null && snap.seed === null && snap.current === null;

     return (
       <main className="min-h-full px-4 py-6 sm:px-8 max-w-5xl mx-auto">
         <Grain />
         <header className="flex items-center justify-between mb-6">
           <p className="eyebrow" style={{ color: "var(--color-ember-soft)" }}>
             LAN Jukebox
           </p>
           <span className="font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>
             {snap?.activePlayerPresent
               ? `● ${snap.activePlayerLabel ?? "speaker"} live`
               : "○ no speaker"}
           </span>
         </header>

         {playerError && (
           <p
             role="alert"
             className="card p-3 mb-4 text-sm font-mono"
             style={{ color: "var(--color-ember-soft)" }}
           >
             Playback: {playerError}
           </p>
         )}

         {coldStart ? (
           <section className="card hero-glow p-10 text-center">
             <p className="eyebrow">Station idle</p>
             <h1 className="font-display text-3xl mt-3" style={{ color: "var(--color-ink)" }}>
               Queue a song to start the station.
             </h1>
           </section>
         ) : (
           <NowPlaying
             item={snap?.current ?? null}
             paused={snap?.paused ?? false}
             receivedAt={ws.receivedAt}
             canSeek={isSpeaker}
             onSeek={(positionMs) => api.control("seek", positionMs)}
           />
         )}

         <div className="mt-6 grid gap-6">
           <PlayerPanel isSpeaker={isSpeaker} onRelinquish={onRelinquish} audioRef={audioRef} />
           <AddBar
             onPlay={async (input) => {
               const r = await api.add(input);
               return { candidates: r.candidates ?? null };
             }}
             onQueueAll={async (ids) => {
               for (const id of ids) await api.pick(id);
               return ids.length > 0;
             }}
           />
           <Controls
             onAction={(a) => onControl(a === "resume" ? "play" : a)}
             paused={snap?.paused ?? false}
           />
           <Queue
             items={snap?.upcoming ?? []}
             current={snap?.current ?? null}
             upcomingRadio={snap?.upcomingRadio ?? []}
             onRemove={(id) => onControl("remove", { itemId: id })}
             onReorder={(id, toIndex) => onControl("reorder", { itemId: id, toIndex })}
             onPlayNext={(id) => onControl("reorder", { itemId: id, toIndex: 0 })}
             onJump={(id) => onControl("jump", { itemId: id })}
             onShuffle={() => onControl("shuffle")}
             onClear={() => onControl("clear")}
             autoplay={snap?.autoplay ?? true}
             autoplaySource={snap?.autoplaySource ?? "radio"}
             onToggleAutoplay={(on) => onControl("settings", { autoplay: on })}
           />
           <History history={snap?.history ?? []} onRequeue={(videoId) => void api.add(videoId)} />
           {snap?.current?.meta.videoId && <Lyrics trackId={snap.current.meta.videoId} />}
           <Settings
             repeat={snap?.repeat ?? "off"}
             autoplay={snap?.autoplay ?? true}
             autoplaySource={snap?.autoplaySource ?? "radio"}
             volume={snap?.volume ?? 100}
             maxTrackDurationSec={snap?.maxTrackDurationSec ?? 0}
             onChange={(patch) => onControl("settings", patch)}
           />
         </div>
       </main>
     );
   }
   ```
   > Note: `Lyrics` is keyed on the current videoId. The App test above only asserts the auth gate + cold-start banner — the panel wiring is verified by each panel's own test (Task 5.5) plus the full build/typecheck.
4. **Run it — expect PASS.** `npx vitest run web/src/components/App.test.tsx` → all passed.

---

### Task 5.7: Phase completion — full verification, adversarial debug, single squash commit

**Files:** none (verification + one commit for the whole phase).

#### Steps

1. **Full typecheck.** `cd /home/kasm-user/lan-jukebox && npm run typecheck`
   - Expected: green, no errors. (`tsc --noEmit` over `src/**` + `web/**` per `tsconfig.json` + `web/tsconfig.json`.)
2. **Lint.** `npm run lint`
   - Expected: `eslint` passes with 0 errors/0 warnings across the new `web/src/**` files.
3. **Build.** `npm run build`
   - Expected: the backend `tsc` build and the `vite build` for `web/` both succeed (emit `dist/` + `web/dist/`).
4. **Full test suite.** `npm test`
   - Expected green output (counts illustrative): all Phase 5 web suites pass —
     ```
     ✓ web/src/lib/api.test.ts
     ✓ web/src/lib/deviceId.test.ts
     ✓ web/src/lib/wsReducer.test.ts
     ✓ web/src/lib/useStationState.test.ts
     ✓ web/src/lib/usePlayerRole.test.ts
     ✓ web/src/components/LoginGate.test.tsx
     ✓ web/src/components/PlayerPanel.test.tsx
     ✓ web/src/components/Controls.test.tsx
     ✓ web/src/components/Settings.test.tsx
     ✓ web/src/components/AddBar.test.tsx
     ✓ web/src/components/NowPlaying.test.tsx
     ✓ web/src/components/Queue.test.tsx
     ✓ web/src/components/History.test.tsx
     ✓ web/src/components/Lyrics.test.tsx
     ✓ web/src/components/Picker.test.tsx
     ✓ web/src/components/Preparing.test.tsx
     ✓ web/src/components/App.test.tsx
     Test Files  N passed (N)
          Tests  M passed (M)
     ```
   - If ANY command in steps 1–4 fails, STOP and fix before proceeding — do not commit a red tree.
5. **Adversarial multi-agent /debug pass.** Run a full `/debug` over the changed files (`web/src/lib/{api,deviceId,useStationState,usePlayerRole}.ts`, `web/src/components/*.tsx`, `web/src/index.css`):
   - Fan out finder agents across the changed files and reliability lenses specific to this phase:
     - **WS lifecycle:** double-socket on rapid visibility/online toggles; the `_dead` flag actually preventing stale dispatch; `hello` resent after every reconnect.
     - **usePlayerRole:** the `becomePlayer`/`relinquishPlayer` effect not double-firing; `play()` rejection surfaced AND reported once (not on every render); `timeupdate` throttle not dropping the final position; `setVolume` >100% clamped on the element but the pct preserved for the UI; listeners cleaned up on unmount/`ws` change.
     - **App generation-guard:** a stale WS snapshot can't revert an optimistic pause/skip; `isThisDeviceSpeaker` auto-engage doesn't fight a manual relinquish.
     - **api client:** 204 / empty-body short-circuit; `control` omitting `value` for bodyless actions; ApiError status propagation.
     - **Cold-start banner:** exact `seed===null && current===null` predicate (not `||`); doesn't flash during `auth==="checking"`.
     - **A11y/labels:** every `getByLabelText`/`getByRole` query in the tests matches a real, unique accessible name (no ambiguous-match failures).
   - Adversarially verify each finding (reproduce via a failing test BEFORE fixing). Fix all CONFIRMED bugs; add a regression test for each. Re-run `npm test` until green.
6. **One squash commit for the whole phase** (the user pushes to `master` directly per their workflow; no `gh` CLI). After steps 1–5 are all green:
   ```bash
   cd /home/kasm-user/lan-jukebox && git add -A && git commit -m "$(cat <<'EOF'
   Phase 5: Web UI (frontend-design) — SPA, design system, player/remote roles

   Author the cohesive frontend-design design system (web/src/index.css), then
   build the LAN-Jukebox SPA on it:
   - lib: api client (flat /api, credentials:include) + ApiError, persistent
     deviceId/displayName, useStationState WS hook + applyWsMessage reducer,
     usePlayerRole hidden-<audio> sink (load/play/pause/seek/setVolume +
     position/trackEnded/playbackError telemetry).
   - components: shared-password LoginGate, PlayerPanel (managed audio mount +
     relinquish), de-guilded/de-Discorded AddBar/Controls(no Stop)/NowPlaying
     (no Visualizer, displayName-only credit)/Queue(+radio preview & autoplay
     toggle)/History/Lyrics/Settings(idle/fx/crossfade removed), and
     the App root: session gate, cold-start "Queue a song to start the station"
     banner, optimistic-pause generation guard, auto-speaker via
     isThisDeviceSpeaker.
   - TDD throughout (Vitest + @testing-library); typecheck + lint + build + full
     suite green; adversarial /debug pass clean.

   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   EOF
   )"
   ```
   - Expected: exactly ONE commit recorded for the entire phase (per the one-commit-per-phase-after-debug rule, which overrides the skill default of per-task commits).

---

## Phase 6:Deploy (Docker/CI/GHCR/compose; bring-your-own ingress) — Deploy (Docker/CI/GHCR/compose; bring-your-own ingress)

**Goal:** Ship the container + pipeline: a multi-stage `Dockerfile` (Node 22 + yt-dlp + ffmpeg + Deno + gosu + cache-chown entrypoint + `/healthz`), GHCR CI (test gate + build/push `:latest`+`:sha` + weekly cron + yt-dlp cache-bust), a `docker-compose.yml` (GHCR pull, env block, named cache volume that also holds the persisted station snapshot + device registry, healthcheck, optional bgutil-pot; bring-your-own external ingress — NO bundled cloudflared, just a localhost-bound published host port), and a `README.md` documenting the autoplay-grant + device-memory + bring-your-own-ingress/WS gotchas.

### Parallelization

- **Sequential / shared hubs:** none. There are no shared-hub files in this phase. Every artifact is a standalone leaf.
- **Parallel-safe (all independent leaves, may be authored concurrently):** `Dockerfile`, `docker-entrypoint.sh`, `.github/workflows/build.yml`, `docker-compose.yml`, `.dockerignore`, `README.md`.
- **Cross-phase dependencies (must already exist on disk from earlier phases — do NOT create here):** Phase 0 `package.json` scripts (`build`, `start`, `typecheck`, `test`, `lint`); Phase 0 `.dockerignore` baseline (extended in 6.1 if absent); Phase 4 `GET /healthz` route in `src/server/app.ts`; Phase 0 `src/config.ts` env names (`PORT`/`HOST`/`PUBLIC_BASE_URL`/`ALLOWED_WS_ORIGINS`/`VIEWER_PASSWORD`/`SESSION_SECRET`/`CACHE_DIR`/`CACHE_MAX_MB`/`YT_PLAYER_CLIENTS`/`PO_TOKEN_PROVIDER_URL`/`LOG_LEVEL`/`NODE_ENV`/`ALLOW_NO_PASSWORD`).

> **Testing note for this phase.** Deploy artifacts (Dockerfile, compose, CI YAML, shell entrypoint) are not runtime TypeScript, so they cannot be unit-tested with Vitest in the normal "import-the-function" way. Instead, each task below is driven by a **Vitest spec that asserts on the artifact files as fixtures** — it reads the file off disk and asserts the load-bearing invariants the spec demands (no Discord env, `ALLOWED_WS_ORIGINS == PUBLIC_BASE_URL`, no bundled cloudflared / `TUNNEL_TOKEN` + a localhost-bound published host port for bring-your-own ingress, the YTDLP_REFRESH cache-bust wiring, the gosu drop, etc.). These tests live under `src/deploy/` so they run inside the existing `npm test` (vitest `include` already covers `src/**`). They are real, runnable assertions — not placeholders — and they make the "did we de-Discord / did we keep the bring-your-own-ingress invariants" rules regression-proof. Shell/compose/Dockerfile lint is additionally run as a manual command in each task and again in Phase completion.

---

### Task 6.1: Dockerfile + entrypoint

**Files**

- Create: `/home/kasm-user/lan-jukebox/Dockerfile`
- Create: `/home/kasm-user/lan-jukebox/docker-entrypoint.sh`
- Create (extend if a baseline exists from Phase 0): `/home/kasm-user/lan-jukebox/.dockerignore`
- Test: `/home/kasm-user/lan-jukebox/src/deploy/dockerfile.test.ts`

**Interfaces**

Consumes (must already exist on disk):

- Phase 0 `package.json` scripts: `npm run build` (tsc + vite build → `dist/` + `web/dist/`), `npm start` → `node dist/index.js`.
- Phase 4 route: `GET /healthz` served by Fastify on `process.env.PORT` (default `8080`), returns `200 {ok:true}`.
- `src/index.ts` composition root that calls `loadConfig()` and `listen({ port: web.port, host: web.host })`.

Produces (no exported TS symbols — these are container build artifacts):

- A multi-stage image: `build` stage `node:22-bookworm` (`npm ci` → `npm run build` → `npm ci --omit=dev`) → `runtime` stage `node:22-bookworm-slim` with `ffmpeg python3 python3-pip ca-certificates curl unzip gosu`, pip `yt-dlp[default]` + `bgutil-ytdlp-pot-provider` (cache-busted by `ARG YTDLP_REFRESH`), pinned + SHA256-verified Deno, `useradd app` uid `10001`, `chown` of `CACHE_DIR` + `/app`, `ENTRYPOINT docker-entrypoint.sh`, `CMD node dist/index.js`, `HEALTHCHECK` that fetches `/healthz`, `VOLUME /data/cache`, `EXPOSE 8080`.
- `docker-entrypoint.sh`: runs as root, `mkdir -p` + `chown -R app:app "$CACHE_DIR"`, then `exec gosu app "$@"`.

**Steps**

1. **Write the FAILING test.** Create `/home/kasm-user/lan-jukebox/src/deploy/dockerfile.test.ts`:

   ```ts
   import { readFileSync } from "node:fs";
   import { fileURLToPath } from "node:url";
   import { dirname, resolve } from "node:path";
   import { describe, it, expect } from "vitest";

   const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
   const read = (rel: string) => readFileSync(resolve(repoRoot, rel), "utf8");

   describe("Dockerfile", () => {
     const df = read("Dockerfile");

     it("is a multi-stage Node 22 build → slim runtime", () => {
       expect(df).toMatch(/FROM node:22-bookworm AS build/);
       expect(df).toMatch(/FROM node:22-bookworm-slim AS runtime/);
       expect(df).toMatch(/RUN npm ci\b/);
       expect(df).toMatch(/RUN npm run build/);
       expect(df).toMatch(/RUN npm ci --omit=dev/);
     });

     it("installs ffmpeg + python + gosu and pip-installs yt-dlp + bgutil", () => {
       expect(df).toMatch(/apt-get install -y --no-install-recommends/);
       expect(df).toMatch(/\bffmpeg\b/);
       expect(df).toMatch(/\bgosu\b/);
       expect(df).toMatch(/pip3 install[^\n]*"yt-dlp\[default\]" bgutil-ytdlp-pot-provider/);
     });

     it("cache-busts yt-dlp via a YTDLP_REFRESH build arg", () => {
       expect(df).toMatch(/ARG YTDLP_REFRESH=unset/);
       expect(df).toMatch(/ENV YTDLP_REFRESH=\$\{YTDLP_REFRESH\}/);
     });

     it("pins Deno and verifies its SHA256 (no curl|sh)", () => {
       expect(df).toMatch(/ARG DENO_VERSION=/);
       expect(df).toMatch(/ARG DENO_SHA256=[0-9a-f]{64}/);
       expect(df).toMatch(/sha256sum -c -/);
       expect(df).not.toMatch(/deno\.land\/install\.sh\s*\|\s*sh/);
     });

     it("creates an unprivileged app user (uid 10001) and chowns the cache", () => {
       expect(df).toMatch(/useradd --create-home --uid 10001 app/);
       expect(df).toMatch(/chown -R app:app "\$\{CACHE_DIR\}"/);
       // entrypoint drops privileges, so no bare `USER app` line
       expect(df).not.toMatch(/^\s*USER app\s*$/m);
     });

     it("wires entrypoint + CMD + healthcheck + volume + expose", () => {
       expect(df).toMatch(/ENTRYPOINT \["docker-entrypoint\.sh"\]/);
       expect(df).toMatch(/CMD \["node", "dist\/index\.js"\]/);
       expect(df).toMatch(/HEALTHCHECK[\s\S]*\/healthz/);
       expect(df).toMatch(/VOLUME \["\/data\/cache"\]/);
       expect(df).toMatch(/EXPOSE 8080/);
     });

     it("carries no Discord/OAuth remnants", () => {
       expect(df).not.toMatch(/discord/i);
       expect(df).not.toMatch(/oauth/i);
     });
   });

   describe("docker-entrypoint.sh", () => {
     const sh = read("docker-entrypoint.sh");
     it("chowns the cache as root then drops to app via gosu", () => {
       expect(sh).toMatch(/^#!\/bin\/sh/);
       expect(sh).toMatch(/set -e/);
       expect(sh).toMatch(/CACHE_DIR="\$\{CACHE_DIR:-\/data\/cache\}"/);
       expect(sh).toMatch(/chown -R app:app "\$CACHE_DIR"/);
       expect(sh).toMatch(/exec gosu app "\$@"/);
     });
   });
   ```

2. **Run it — expect FAIL.** `cd /home/kasm-user/lan-jukebox && npx vitest run src/deploy/dockerfile.test.ts`
   Expected failure: `ENOENT: no such file or directory, open '.../lan-jukebox/Dockerfile'` (the file does not exist yet).

3. **Minimal implementation — `docker-entrypoint.sh`.** Create `/home/kasm-user/lan-jukebox/docker-entrypoint.sh`:

   ```sh
   #!/bin/sh
   # A mounted named volume / bind mount can be root-owned, which the unprivileged
   # 'app' user cannot write — breaking the audio cache, the station snapshot, and
   # the device registry (all under CACHE_DIR). Run as root just long enough to make
   # the cache writable, then drop privileges.
   set -e
   CACHE_DIR="${CACHE_DIR:-/data/cache}"
   mkdir -p "$CACHE_DIR"
   chown -R app:app "$CACHE_DIR" 2>/dev/null || true
   exec gosu app "$@"
   ```

4. **Minimal implementation — `Dockerfile`.** Create `/home/kasm-user/lan-jukebox/Dockerfile`:

   ```dockerfile
   # syntax=docker/dockerfile:1
   FROM node:22-bookworm AS build
   WORKDIR /app
   COPY package.json package-lock.json ./
   RUN npm ci
   COPY . .
   RUN npm run build
   RUN npm ci --omit=dev

   FROM node:22-bookworm-slim AS runtime
   ENV NODE_ENV=production PORT=8080 CACHE_DIR=/data/cache PATH="/usr/local/bin:${PATH}"
   RUN apt-get update && apt-get install -y --no-install-recommends \
         ffmpeg python3 python3-pip ca-certificates curl unzip gosu \
       && rm -rf /var/lib/apt/lists/*
   # YTDLP_REFRESH is a cache-busting token (pass `--build-arg YTDLP_REFRESH=$(date +%Y%U)`
   # from CI so this layer's hash changes every week). Without it, BuildKit would serve the
   # pip layer from the GHA cache unchanged and yt-dlp would silently rot — YouTube rotates
   # its nsig solver regularly, so a stale yt-dlp breaks audio extraction. The weekly cron
   # additionally builds with `no-cache: true` to guarantee a fresh fetch.
   ARG YTDLP_REFRESH=unset
   ENV YTDLP_REFRESH=${YTDLP_REFRESH}
   # bgutil-ytdlp-pot-provider is the client-side plugin that talks to the optional
   # `bgutil-pot` sidecar (PO_TOKEN_PROVIDER_URL). yt-dlp[default] alone cannot use the
   # sidecar; the plugin is auto-discovered at runtime and only activates when the
   # `youtubepot-bgutilhttp:base_url=…` extractor-arg is supplied by the app.
   RUN pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]" bgutil-ytdlp-pot-provider \
       && yt-dlp --version
   # Pin Deno to a specific release and verify its SHA256 instead of piping a remote installer
   # into sh (curl|sh would run unverified, unpinned code as root and freeze any compromised
   # artifact into the GHA layer cache). Pinned-zip-plus-checksum is reproducible and integrity-checked.
   ARG DENO_VERSION=2.1.4
   ARG DENO_SHA256=54a81939cccb2af114c4d0a68a554cf4a04b1f08728e70f663f83781de19d785
   RUN curl -fsSL -o /tmp/deno.zip \
         "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" \
       && echo "${DENO_SHA256}  /tmp/deno.zip" | sha256sum -c - \
       && unzip -o /tmp/deno.zip -d /usr/local/bin \
       && chmod 0755 /usr/local/bin/deno \
       && rm -f /tmp/deno.zip \
       && deno --version
   WORKDIR /app
   RUN useradd --create-home --uid 10001 app && mkdir -p "${CACHE_DIR}" && chown -R app:app "${CACHE_DIR}" /app
   COPY --from=build --chown=app:app /app/dist ./dist
   COPY --from=build --chown=app:app /app/node_modules ./node_modules
   COPY --from=build --chown=app:app /app/package.json ./package.json
   COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
   # NOTE: no `USER app` here — the entrypoint starts as root only to chown the
   # mounted cache volume (which may be root-owned), then drops to 'app' via gosu.
   VOLUME ["/data/cache"]
   EXPOSE 8080
   HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
     CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
   ENTRYPOINT ["docker-entrypoint.sh"]
   CMD ["node", "dist/index.js"]
   ```

5. **Ensure `.dockerignore` excludes build cruft + secrets.** If `/home/kasm-user/lan-jukebox/.dockerignore` does not already exist from Phase 0, create it; otherwise verify it contains these lines (add any missing). The `dist`/`web/dist` excludes matter so the slim runtime copies only the freshly-built artifacts from the build stage and never a stale host build:

   ```
   node_modules
   dist
   web/dist
   .git
   .env
   *.log
   ```

6. **Run it — expect PASS.** `cd /home/kasm-user/lan-jukebox && npx vitest run src/deploy/dockerfile.test.ts`
   Expected: `Test Files  1 passed`, `Tests  9 passed`.

7. **Static lint the shell + Dockerfile (manual, non-blocking if tools absent).** Run `cd /home/kasm-user/lan-jukebox && sh -n docker-entrypoint.sh && echo SHELL_OK`. Expected output: `SHELL_OK` (no syntax errors). If `hadolint`/`shellcheck` are installed, run `hadolint Dockerfile || true` and `shellcheck docker-entrypoint.sh || true` and address any genuine errors; absence of the linters is acceptable (the Vitest assertions are the gate).

---

### Task 6.2: GHCR CI workflow

**Files**

- Create: `/home/kasm-user/lan-jukebox/.github/workflows/build.yml`
- Test: `/home/kasm-user/lan-jukebox/src/deploy/workflow.test.ts`

**Interfaces**

Consumes (must already exist):

- Phase 0 `package.json` scripts `typecheck`, `test`, `lint`, `build`.
- Task 6.1 `Dockerfile` (the `YTDLP_REFRESH` build arg it feeds; the `context: .` it builds).

Produces (CI workflow YAML — no TS symbols):

- Triggers: `push` to `[master]`, `workflow_dispatch`, weekly `schedule` cron.
- `permissions: { contents: read, packages: write }`, `concurrency` cancel-in-progress keyed on the ref.
- `test` job (`npm ci` → `typecheck` → `test` → `lint`) that **gates** `build-and-push` via `needs: test`.
- `ytdlp-refresh` step exporting `week=$(date +%Y%U)` → fed as `YTDLP_REFRESH` build-arg.
- `no-cache` forced on `schedule` || `workflow_dispatch`.
- Tags `ghcr.io/atvriders/lan-jukebox:latest` + `:${{ github.sha }}`; GHA cache `mode=max`.

**Steps**

1. **Write the FAILING test.** Create `/home/kasm-user/lan-jukebox/src/deploy/workflow.test.ts`:

   ```ts
   import { readFileSync } from "node:fs";
   import { fileURLToPath } from "node:url";
   import { dirname, resolve } from "node:path";
   import { describe, it, expect } from "vitest";

   const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
   const wf = readFileSync(resolve(repoRoot, ".github/workflows/build.yml"), "utf8");

   describe(".github/workflows/build.yml", () => {
     it("triggers on master push, manual dispatch, and a weekly cron", () => {
       expect(wf).toMatch(/push:\s*\{\s*branches:\s*\[master\]\s*\}/);
       expect(wf).toMatch(/workflow_dispatch:/);
       expect(wf).toMatch(/schedule:/);
       expect(wf).toMatch(/cron:\s*"0 6 \* \* 1"/);
     });

     it("requests only the permissions GHCR push needs", () => {
       expect(wf).toMatch(/permissions:\s*\{\s*contents:\s*read,\s*packages:\s*write\s*\}/);
     });

     it("cancels superseded runs per ref", () => {
       expect(wf).toMatch(
         /concurrency:\s*\{\s*group:\s*"build-\$\{\{ github\.ref \}\}",\s*cancel-in-progress:\s*true\s*\}/,
       );
     });

     it("runs the full test gate before building", () => {
       expect(wf).toMatch(/npm run typecheck/);
       expect(wf).toMatch(/npm test/);
       expect(wf).toMatch(/npm run lint/);
       expect(wf).toMatch(/needs:\s*test/);
     });

     it("pushes to ghcr.io/atvriders/lan-jukebox with latest + sha tags", () => {
       expect(wf).toMatch(/IMAGE_NAME:\s*atvriders\/lan-jukebox/);
       expect(wf).toMatch(/\$\{\{ env\.REGISTRY \}\}\/\$\{\{ env\.IMAGE_NAME \}\}:latest/);
       expect(wf).toMatch(/\$\{\{ env\.IMAGE_NAME \}\}:\$\{\{ github\.sha \}\}/);
     });

     it("cache-busts yt-dlp weekly via a date-keyed build-arg", () => {
       expect(wf).toMatch(/date \+%Y%U/);
       expect(wf).toMatch(/YTDLP_REFRESH=\$\{\{ steps\.ytdlp-refresh\.outputs\.week \}\}/);
     });

     it("forces no-cache on schedule/dispatch and uses gha cache mode=max", () => {
       expect(wf).toMatch(
         /no-cache:\s*\$\{\{ github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch' \}\}/,
       );
       expect(wf).toMatch(/cache-to:\s*type=gha,mode=max/);
     });

     it("carries no Discord remnants", () => {
       expect(wf).not.toMatch(/discord/i);
     });
   });
   ```

2. **Run it — expect FAIL.** `cd /home/kasm-user/lan-jukebox && npx vitest run src/deploy/workflow.test.ts`
   Expected failure: `ENOENT: no such file or directory, open '.../.github/workflows/build.yml'`.

3. **Minimal implementation.** Create `/home/kasm-user/lan-jukebox/.github/workflows/build.yml`:

   ```yaml
   name: build
   on:
     push: { branches: [master] }
     workflow_dispatch: {}
     schedule:
       - cron: "0 6 * * 1" # weekly — refresh yt-dlp/deno nsig solver
   permissions: { contents: read, packages: write }
   # Stop a manual push and the weekly scheduler from racing to push :latest.
   concurrency: { group: "build-${{ github.ref }}", cancel-in-progress: true }
   env: { REGISTRY: ghcr.io, IMAGE_NAME: atvriders/lan-jukebox }
   jobs:
     test:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: 22, cache: npm }
         - run: npm ci
         - run: npm run typecheck
         - run: npm test
         - run: npm run lint
     build-and-push:
       needs: test
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: docker/setup-buildx-action@v3
         - uses: docker/login-action@v3
           with:
             {
               registry: "${{ env.REGISTRY }}",
               username: "${{ github.actor }}",
               password: "${{ secrets.GITHUB_TOKEN }}",
             }
         - id: ytdlp-refresh
           run: echo "week=$(date +%Y%U)" >> "$GITHUB_OUTPUT"
         - uses: docker/build-push-action@v6
           with:
             context: .
             push: true
             # Date-keyed so the yt-dlp pip layer's hash changes weekly even on routine
             # push builds, deterministically pulling a fresh yt-dlp instead of a cached stale one.
             build-args: |
               YTDLP_REFRESH=${{ steps.ytdlp-refresh.outputs.week }}
             tags: |
               ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:latest
               ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}
             cache-from: type=gha
             cache-to: type=gha,mode=max
             # The Dockerfile rarely changes, so BuildKit would otherwise serve the
             # `pip install yt-dlp` layer from the GHA cache forever — defeating the
             # weekly cron whose whole purpose is to pull a fresh yt-dlp (YouTube
             # rotates its nsig solver). Force a full cache-bypassing rebuild on the
             # freshness-oriented triggers so yt-dlp/deno are actually re-fetched.
             no-cache: ${{ github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' }}
   ```

4. **Run it — expect PASS.** `cd /home/kasm-user/lan-jukebox && npx vitest run src/deploy/workflow.test.ts`
   Expected: `Test Files  1 passed`, `Tests  8 passed`.

5. **Validate the YAML parses (manual).** Run `cd /home/kasm-user/lan-jukebox && node -e "import('js-yaml').then(y=>{const fs=require('node:fs');y.load(fs.readFileSync('.github/workflows/build.yml','utf8'));console.log('YAML_OK')}).catch(()=>{const {execSync}=require('node:child_process');try{execSync('python3 -c \"import sys,yaml;yaml.safe_load(open(sys.argv[1]))\" .github/workflows/build.yml',{stdio:'inherit'});console.log('YAML_OK')}catch(e){process.exit(1)}})"`. Expected output: `YAML_OK` (parses without error via whichever YAML lib is present). If neither `js-yaml` nor a python `yaml` module is available, run `python3 -c "import sys; sys.exit(0)"` is insufficient — instead skip this manual check and rely on the regex assertions plus the Phase-completion typecheck; do not block on a missing YAML parser.

---

### Task 6.3: docker-compose (bring-your-own ingress)

**Files**

- Create: `/home/kasm-user/lan-jukebox/docker-compose.yml`
- Test: `/home/kasm-user/lan-jukebox/src/deploy/compose.test.ts`

**Interfaces**

Consumes (must already exist):

- Task 6.1 image (`ghcr.io/atvriders/lan-jukebox:latest`) + its `/healthz` healthcheck contract.
- Phase 0 `src/config.ts` env names: `PORT`, `HOST`, `PUBLIC_BASE_URL`, `ALLOWED_WS_ORIGINS`, `VIEWER_PASSWORD`, `SESSION_SECRET`, `ALLOW_NO_PASSWORD`, `NODE_ENV`, `LOG_LEVEL`, `CACHE_DIR`, `CACHE_MAX_MB`, `HISTORY_MAX_ITEMS`, `SEARCH_RESULT_COUNT`, `PREFETCH_DEPTH`, `MAX_CONCURRENT_DOWNLOADS`, `MAX_TRACK_DURATION_SEC`, `YT_PROXY`, `YT_COOKIES_FILE`, `YT_PLAYER_CLIENTS`, `PO_TOKEN_PROVIDER_URL`.

Produces (compose YAML — no TS symbols):

- Service `jukebox`: GHCR image, `pull_policy: always`, env block (NO Discord vars, NO `IDLE_TIMEOUT_SEC`, no trust-proxy knob — `trustProxy` is hardcoded `true` in the app — and no second/admin password: a single shared `VIEWER_PASSWORD`, `ALLOWED_WS_ORIGINS` == `PUBLIC_BASE_URL`), a **localhost-bound published host port** `ports: ["127.0.0.1:${HOST_PORT:-8080}:8080"]` (for the user's OWN external ingress — their separate cloudflared / nginx / etc.), `volumes: ["cache:/data/cache"]` (holds `station-snapshot.json` + `device-registry.json` + audio cache), `restart: unless-stopped`, `/healthz` healthcheck, json-file logging.
- Optional `bgutil-pot` sidecar under the `pot` profile.
- **No bundled tunnel.** The project does NOT install or run `cloudflared` itself — bring your own external ingress.
- Named `cache:` volume.

**Steps**

1. **Write the FAILING test.** Create `/home/kasm-user/lan-jukebox/src/deploy/compose.test.ts`:

   ```ts
   import { readFileSync } from "node:fs";
   import { fileURLToPath } from "node:url";
   import { dirname, resolve } from "node:path";
   import { describe, it, expect } from "vitest";

   const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
   const yml = readFileSync(resolve(repoRoot, "docker-compose.yml"), "utf8");

   describe("docker-compose.yml", () => {
     it("pulls the GHCR image with pull_policy always", () => {
       expect(yml).toMatch(/image:\s*ghcr\.io\/atvriders\/lan-jukebox:latest/);
       expect(yml).toMatch(/pull_policy:\s*always/);
     });

     it("pins WS origins to the public base url and exposes no trust-proxy / admin-password knob", () => {
       // trustProxy is hardcoded true in the app; there is a single shared VIEWER_PASSWORD,
       // so neither a trust-proxy env var nor a second/admin password var appears in the env block.
       expect(yml).not.toMatch(new RegExp(["TRUST", "PROXY"].join("_")));
       expect(yml).not.toMatch(new RegExp(["ADMIN", "PASSWORD"].join("_")));
       // ALLOWED_WS_ORIGINS must equal PUBLIC_BASE_URL — both default to the same placeholder
       const pub = yml.match(/PUBLIC_BASE_URL:\s*"([^"]+)"/)?.[1];
       const ws = yml.match(/ALLOWED_WS_ORIGINS:\s*"([^"]+)"/)?.[1];
       expect(pub).toBeTruthy();
       expect(ws).toBe(pub);
     });

     it("publishes a localhost-bound host port for the user's own external ingress", () => {
       // the jukebox service publishes a 127.0.0.1-bound host port so a separate
       // host-level reverse proxy / Cloudflare Tunnel can reach it
       expect(yml).toMatch(/127\.0\.0\.1:\$\{HOST_PORT:-8080\}:8080/);
       expect(yml).toMatch(/ports:\s*\[\s*"127\.0\.0\.1:.*:8080"\s*\]/);
     });

     it("mounts the named cache volume that also holds snapshot + registry", () => {
       expect(yml).toMatch(/volumes:\s*\[\s*"cache:\/data\/cache"\s*\]/);
       expect(yml).toMatch(/^volumes:\s*$/m);
       expect(yml).toMatch(/^\s{2}cache:\s*$/m);
       // documented in a comment so operators know the persisted files live here
       expect(yml).toMatch(/station-snapshot\.json/);
       expect(yml).toMatch(/device-registry\.json/);
     });

     it("restarts unless stopped and healthchecks /healthz", () => {
       expect(yml).toMatch(/restart:\s*unless-stopped/);
       expect(yml).toMatch(/\/healthz/);
     });

     it("uses the zero-PO-token client ladder by default", () => {
       expect(yml).toMatch(/YT_PLAYER_CLIENTS:\s*"android_vr,web_embedded,tv"/);
     });

     it("offers an optional bgutil-pot sidecar under the pot profile", () => {
       expect(yml).toMatch(/bgutil-pot:/);
       expect(yml).toMatch(/profiles:\s*\[\s*"pot"\s*\]/);
     });

     it("does NOT bundle a tunnel (bring your own ingress)", () => {
       expect(yml).not.toMatch(/cloudflared/i);
       expect(yml).not.toMatch(/TUNNEL_TOKEN/);
     });

     it("contains no Discord vars and no idle-timeout setting", () => {
       expect(yml).not.toMatch(/discord/i);
       expect(yml).not.toMatch(/IDLE_TIMEOUT/);
       expect(yml).not.toMatch(/oauth/i);
     });
   });
   ```

2. **Run it — expect FAIL.** `cd /home/kasm-user/lan-jukebox && npx vitest run src/deploy/compose.test.ts`
   Expected failure: `ENOENT: no such file or directory, open '.../docker-compose.yml'`.

3. **Minimal implementation.** Create `/home/kasm-user/lan-jukebox/docker-compose.yml`:

   ```yaml
   # IMPORTANT: This file contains PLACEHOLDER values.
   # Before running `docker compose up`, fill in your real values for:
   #   PUBLIC_BASE_URL, ALLOWED_WS_ORIGINS (== PUBLIC_BASE_URL), VIEWER_PASSWORD,
   #   SESSION_SECRET (>= 32 chars).
   # Keep your filled-in copy LOCAL — do NOT commit real secrets to the repo.
   #
   # Ingress: BRING YOUR OWN. This project does NOT bundle or run cloudflared. The
   # jukebox service publishes a LOCALHOST-bound host port (127.0.0.1:${HOST_PORT:-8080})
   # so your OWN external ingress — a separate Cloudflare Tunnel, nginx, Caddy, etc.,
   # running on the host — can reach the app at http://127.0.0.1:${HOST_PORT:-8080}.
   #   Alternative: if your tunnel runs as its own container, drop the `ports:` mapping,
   #   attach both it and this service to a shared external Docker network, and reach the
   #   app at http://jukebox:8080 over that network instead of publishing a host port.
   #
   # Persistence: the `cache` named volume holds the LRU audio cache AND the restart-safe
   #   /data/cache/station-snapshot.json   (current track, queue, upcoming-radio, seed)
   #   /data/cache/device-registry.json    (remembered speaker / auto-select state)
   # so the station and the remembered speaker survive `docker compose up` restarts.

   services:
     jukebox:
       image: ghcr.io/atvriders/lan-jukebox:latest
       pull_policy: always
       environment:
         # Server
         PORT: "8080"
         HOST: "0.0.0.0"
         NODE_ENV: "production"
         LOG_LEVEL: "info"

         # Public URL (the https:// example.com subdomain served by the tunnel).
         PUBLIC_BASE_URL: "https://jukebox.example.com"
         # MUST equal PUBLIC_BASE_URL exactly, or the live-updates WebSocket /ws is
         # rejected by the origin guard and the station UI never goes live.
         ALLOWED_WS_ORIGINS: "https://jukebox.example.com"
         # Your external HTTPS proxy / Cloudflare Tunnel terminates TLS at the edge and
         # reaches this origin over plain HTTP, sending X-Forwarded-Proto: https. The app
         # hardcodes Fastify trustProxy:true so it honors that for correct scheme detection
         # + Secure session cookies + real client IP — there is no trust-proxy env knob.

         # Auth: a single shared viewer password (required). Anyone authenticated may
         # control everything — there is no second/admin password. The server refuses to
         # start without VIEWER_PASSWORD unless ALLOW_NO_PASSWORD=true.
         VIEWER_PASSWORD: "CHANGE_ME"
         ALLOW_NO_PASSWORD: "false"
         SESSION_SECRET: "CHANGE_ME_AT_LEAST_32_CHARACTERS_LONG"

         # Cache + persistence (all three persisted files live under CACHE_DIR)
         CACHE_DIR: "/data/cache"
         CACHE_MAX_MB: "5000"

         # History / search limits
         HISTORY_MAX_ITEMS: "100"
         SEARCH_RESULT_COUNT: "10"

         # Download / radio tuning
         PREFETCH_DEPTH: "3"
         MAX_CONCURRENT_DOWNLOADS: "4"
         # 0 / "" = no cap; long content (concerts) plays out of the box.
         MAX_TRACK_DURATION_SEC: "0"

         # YouTube extraction
         YT_PROXY: "" # optional residential/SOCKS proxy if your IP gets blocked
         YT_COOKIES_FILE: "" # optional path to a mounted cookies.txt for flagged IPs
         # Zero-PO-token clients — reliable on most hosts. Only switch to "web,mweb" if
         # you also run the bgutil sidecar (`--profile pot`) and set PO_TOKEN_PROVIDER_URL;
         # otherwise those clients silently fail to extract audio.
         YT_PLAYER_CLIENTS: "android_vr,web_embedded,tv"
         PO_TOKEN_PROVIDER_URL: "" # only set (e.g. http://bgutil-pot:4416) with --profile pot
       # Published on LOCALHOST only — your OWN external ingress (a separate cloudflared /
       # nginx / Caddy on the host) connects here. Override the host port with HOST_PORT.
       # Alternative: if your tunnel is its own container, delete this line and instead
       # join a shared external network and reach the app at http://jukebox:8080.
       ports: ["127.0.0.1:${HOST_PORT:-8080}:8080"]
       volumes: ["cache:/data/cache"]
       restart: unless-stopped
       healthcheck:
         test:
           [
             "CMD",
             "node",
             "-e",
             "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
           ]
         interval: 30s
         timeout: 5s
         start_period: 25s
         retries: 3
       logging:
         driver: json-file
         options: { max-size: "10m", max-file: "3" }

     # Optional PO-token sidecar — only needed if you switch YT_PLAYER_CLIENTS to web/mweb.
     # Enable with: docker compose --profile pot up -d
     bgutil-pot:
       image: brainicism/bgutil-ytdlp-pot-provider:latest
       profiles: ["pot"]
       restart: unless-stopped
       expose: ["4416"]

   volumes:
     cache:
   ```

4. **Run it — expect PASS.** `cd /home/kasm-user/lan-jukebox && npx vitest run src/deploy/compose.test.ts`
   Expected: `Test Files  1 passed`, `Tests  9 passed`.

5. **Validate compose syntax (manual, non-blocking).** Run `cd /home/kasm-user/lan-jukebox && (docker compose -f docker-compose.yml config -q && echo COMPOSE_OK) 2>/dev/null || echo "docker absent — relying on YAML/regex assertions"`. Expected: `COMPOSE_OK` if Docker is present, otherwise the fallback message (per the sandbox toolchain note: no docker locally — do not block on it; the regex assertions are the gate).

---

### Task 6.4: README deploy docs

**Files**

- Create: `/home/kasm-user/lan-jukebox/README.md`
- Test: `/home/kasm-user/lan-jukebox/src/deploy/readme.test.ts`

**Interfaces**

Consumes (must already exist):

- Tasks 6.1/6.2/6.3 artifacts (image name, env names, profiles, the no-published-port + `ALLOWED_WS_ORIGINS` invariants).
- Spec §5 (device memory + auto-select speaker + browser-autoplay caveat), §10 (deployment + cloudflared), §13 (open risks: WS origin/upgrade, autoplay policy).

Produces (docs — no TS symbols):

- An env table covering every `loadConfig()` var the operator sets.
- GHCR-public + forked-repo `workflow_dispatch` + `--force-recreate` re-pull gotchas.
- The `ALLOWED_WS_ORIGINS == PUBLIC_BASE_URL` rule + a note that Fastify `trustProxy` is hardcoded `true` (fixed behavior behind the external proxy/tunnel) + a "verify `/ws` upgrades end-to-end" step.
- A one-time speaker-PC autoplay-permission grant + device-memory checklist.
- A manual-verify `<audio>` playback checklist (spec §11: real playback is manual-verify).

**Steps**

1. **Write the FAILING test.** Create `/home/kasm-user/lan-jukebox/src/deploy/readme.test.ts`:

   ```ts
   import { readFileSync } from "node:fs";
   import { fileURLToPath } from "node:url";
   import { dirname, resolve } from "node:path";
   import { describe, it, expect } from "vitest";

   const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
   const md = readFileSync(resolve(repoRoot, "README.md"), "utf8");

   describe("README.md", () => {
     it("documents the core env vars in a table", () => {
       for (const v of [
         "PUBLIC_BASE_URL",
         "ALLOWED_WS_ORIGINS",
         "VIEWER_PASSWORD",
         "SESSION_SECRET",
         "CACHE_DIR",
         "CACHE_MAX_MB",
         "YT_PLAYER_CLIENTS",
         "PO_TOKEN_PROVIDER_URL",
       ]) {
         expect(md).toMatch(new RegExp(`\\b${v}\\b`));
       }
       // env table header present
       expect(md).toMatch(/\|\s*Variable\s*\|/i);
       // no removed knobs: trustProxy is hardcoded true; single shared password (no admin)
       expect(md).not.toMatch(new RegExp(`\\b${["TRUST", "PROXY"].join("_")}\\b`));
       expect(md).not.toMatch(new RegExp(`\\b${["ADMIN", "PASSWORD"].join("_")}\\b`));
     });

     it("states the ALLOWED_WS_ORIGINS == PUBLIC_BASE_URL invariant", () => {
       expect(md).toMatch(/ALLOWED_WS_ORIGINS[\s\S]{0,80}PUBLIC_BASE_URL/);
       // trustProxy is a fixed behavior (hardcoded true), documented as prose not an env row
       expect(md).toMatch(/trustProxy[\s\S]{0,40}true/i);
     });

     it("documents bring-your-own ingress + the WebSocket upgrade gotcha", () => {
       // mentions Cloudflare Tunnel only as the EXAMPLE external ingress
       expect(md).toMatch(/cloudflared|Cloudflare Tunnel/i);
       expect(md).toMatch(/\/ws/);
       expect(md).toMatch(/upgrade/i);
       // bring your own ingress — app publishes a localhost-bound host port
       expect(md).toMatch(/bring your own|your own (external )?ingress/i);
       expect(md).toMatch(/127\.0\.0\.1|HOST_PORT/);
     });

     it("documents the speaker-PC one-time autoplay grant + device memory", () => {
       expect(md).toMatch(/autoplay/i);
       expect(md).toMatch(/permission/i);
       expect(md).toMatch(/remember|auto-select|preferred speaker/i);
       expect(md).toMatch(/deviceId|device token|localStorage/i);
     });

     it("documents GHCR-public + forked-repo workflow_dispatch + re-pull gotchas", () => {
       expect(md).toMatch(/ghcr\.io\/atvriders\/lan-jukebox/);
       expect(md).toMatch(/workflow_dispatch/);
       expect(md).toMatch(/--force-recreate|pull_policy/);
       expect(md).toMatch(/public/i);
     });

     it("includes a manual <audio> playback verification checklist", () => {
       expect(md).toMatch(/manual/i);
       expect(md).toMatch(/<audio>|audio element|playback/i);
       expect(md).toMatch(/- \[ \]|checklist/i);
     });

     it("carries no Discord remnants", () => {
       expect(md).not.toMatch(/discord/i);
     });
   });
   ```

2. **Run it — expect FAIL.** `cd /home/kasm-user/lan-jukebox && npx vitest run src/deploy/readme.test.ts`
   Expected failure: `ENOENT: no such file or directory, open '.../README.md'`.

3. **Minimal implementation.** Create `/home/kasm-user/lan-jukebox/README.md`:

   ````markdown
   # LAN Jukebox — Always-On Group Radio

   A self-hosted, browser-based **always-playing YouTube radio**. A Dockerized Node
   backend holds the station state. Browsers are **Remotes** (queue + control) by
   default; one browser becomes the **Player** (the speaker) whose hidden `<audio>`
   element plays what the backend streams. The backend **remembers the speaker
   device** and **auto-selects it** as the Player on reconnect. The station **never
   stops**: when the queue drains it autoplays related YouTube tracks from your last
   seed, forever. No idle timeouts, no auto-stop.

   ## Quick start

   ```bash
   # 1. Copy docker-compose.yml and fill in the placeholders (see env table below).
   # 2. Pull + run. The app publishes 127.0.0.1:${HOST_PORT:-8080}; point your OWN
   #    external ingress (a separate Cloudflare Tunnel, nginx, etc.) at it.
   docker compose up -d
   ```
   ````

   The image is published **public** to `ghcr.io/atvriders/lan-jukebox:latest` by
   GitHub Actions on every push to `master`, plus a weekly rebuild that cache-busts
   yt-dlp (YouTube rotates its nsig solver, so a stale yt-dlp breaks extraction).

   ## Configuration (env)

   `src/config.ts` is the only env reader. All variables are set inline in
   `docker-compose.yml`.

   | Variable                   | Required           | Default                      | Notes                                                                                         |
   | -------------------------- | ------------------ | ---------------------------- | --------------------------------------------------------------------------------------------- |
   | `PORT`                     | no                 | `8080`                       | Internal container listen port.                                                               |
   | `HOST_PORT`                | no                 | `8080`                       | Host port your own ingress connects to (published on `127.0.0.1`).                            |
   | `HOST`                     | no                 | `0.0.0.0`                    | Bind address.                                                                                 |
   | `PUBLIC_BASE_URL`          | yes                | —                            | The public `https://` subdomain (e.g. `https://jukebox.example.com`).                       |
   | `ALLOWED_WS_ORIGINS`       | yes                | —                            | **MUST equal `PUBLIC_BASE_URL` exactly** (see WebSocket gotcha).                              |
   | `VIEWER_PASSWORD`          | yes*               | —                            | Single shared password; anyone authenticated controls everything. *Server refuses to start unless set, unless `ALLOW_NO_PASSWORD=true`. |
   | `ALLOW_NO_PASSWORD`        | no                 | `false`                      | Escape hatch to run with no viewer password (LAN-only).                                       |
   | `SESSION_SECRET`           | yes                | —                            | Cookie-signing secret, **>= 32 chars**.                                                       |
   | `CACHE_DIR`                | no                 | `/data/cache`                | Holds the audio LRU **and** `station-snapshot.json` + `device-registry.json`.                 |
   | `CACHE_MAX_MB`             | no                 | `5000`                       | LRU audio cache size cap.                                                                     |
   | `HISTORY_MAX_ITEMS`        | no                 | `100`                        | Recently-played history length.                                                               |
   | `SEARCH_RESULT_COUNT`      | no                 | `10`                         | Search-candidate count.                                                                       |
   | `PREFETCH_DEPTH`           | no                 | `3`                          | Radio queue-ahead depth.                                                                      |
   | `MAX_CONCURRENT_DOWNLOADS` | no                 | `4`                          | Parallel yt-dlp download cap.                                                                 |
   | `MAX_TRACK_DURATION_SEC`   | no                 | `0`                          | `0`/empty = no cap.                                                                           |
   | `YT_PROXY`                 | no                 | —                            | Optional residential/SOCKS proxy.                                                             |
   | `YT_COOKIES_FILE`          | no                 | —                            | Optional mounted `cookies.txt` for flagged IPs.                                               |
   | `YT_PLAYER_CLIENTS`        | no                 | `android_vr,web_embedded,tv` | Zero-PO-token ladder. Only use `web,mweb` with the bgutil sidecar.                            |
   | `PO_TOKEN_PROVIDER_URL`    | no                 | —                            | Only set (e.g. `http://bgutil-pot:4416`) with `--profile pot`.                                |
   | `LOG_LEVEL`                | no                 | `info`                       | pino level.                                                                                   |
   | `NODE_ENV`                 | no                 | `production`                 | —                                                                                             |

   > There are intentionally **no idle-timeout settings** — the station never stops.

   ## Bring your own ingress (e.g. a separate Cloudflare Tunnel)

   This project does **not** bundle, install, or run `cloudflared`. You provide your
   own external ingress — a separate Cloudflare Tunnel, nginx, Caddy, Traefik, etc.
   Two ways to wire it up:

   - **Host-level ingress (default).** The `jukebox` service publishes a
     **localhost-bound** host port `127.0.0.1:${HOST_PORT:-8080}`. Point your own
     host-level `cloudflared` / reverse proxy at `http://127.0.0.1:${HOST_PORT}`
     (override `HOST_PORT` to avoid a clash). Binding to `127.0.0.1` keeps the app off
     the LAN — only your ingress on the same host can reach it.
   - **Containerized ingress.** If your tunnel runs as its own container, drop the
     `ports:` mapping, attach both it and the `jukebox` service to a shared external
     Docker network, and reach the app at `http://jukebox:8080` over that network.
   - **HTTPS is terminated at your edge**; your tunnel/proxy reaches the origin over
     plain HTTP and should set `X-Forwarded-Proto: https`. The app hardcodes Fastify
     **`trustProxy: true`** (a fixed behavior, not an env knob — it is always behind your
     HTTPS proxy/tunnel) so it honors that header for correct scheme detection, `Secure`
     session cookies, and the real client IP.
   - **WebSocket gotcha (verify end-to-end).** Cloudflare Tunnels (and most proxies)
     pass WebSockets through, but the app's origin guard rejects any `/ws` upgrade
     whose `Origin` isn't in `ALLOWED_WS_ORIGINS`. So **`ALLOWED_WS_ORIGINS` must equal
     `PUBLIC_BASE_URL` exactly** (scheme + host, no trailing slash). After deploy,
     confirm the `/ws` upgrade succeeds through your ingress (browser devtools →
     Network → WS shows status `101 Switching Protocols`; the UI flips to
     "📻 Station is live"). A 403/closed socket means the origins don't match.

   ## CI / GHCR gotchas
   - **Public package.** The GHCR image is published public. If the first build
     leaves the package private, set its visibility to public once in the GitHub
     package settings.
   - **Forked-repo first build.** On a fork, Actions may not run automatically on the
     first push — trigger the initial build manually via **`workflow_dispatch`** (the
     "Run workflow" button). `workflow_dispatch` and the weekly cron also force a
     `no-cache` rebuild so yt-dlp/Deno are actually re-fetched.
   - **Re-pulling a new image.** `pull_policy: always` re-pulls on `up`, but a running
     container is not recreated unless its config changed. To force a fresh image:
     `docker compose pull && docker compose up -d --force-recreate`.

   ## Speaker PC: one-time autoplay grant + device memory

   Browsers block audio autoplay until the site is granted permission or the user
   interacts. For the always-on speaker PC, do this **once**:

   1. Open `PUBLIC_BASE_URL` in the speaker PC's browser and log in (shared password
      - a display name). A persistent **`deviceId`** is stored in `localStorage` —
        this is how the backend recognizes the device on every reconnect.
   2. Click **"Play on this device"** to make it the Player, then **"Remember this
      device as the speaker"** (sets `isPreferredSpeaker`).
   3. Grant the subdomain **autoplay permission** in the browser (site settings →
      Sound/Autoplay → Allow), or simply leave the tab open after that first click.

   Thereafter, whenever the speaker PC's browser reconnects with no Player active,
   the backend **auto-selects** it as the Player and resumes the station — no manual
   click needed. Keep the tab foreground/fullscreen (and enable a Wake Lock /
   disable sleep) so the OS doesn't throttle it.

   Device-memory checklist:

   - [ ] Speaker PC logged in; `deviceId` persisted in `localStorage`.
   - [ ] "Remember this device as the speaker" enabled (`isPreferredSpeaker = true`).
   - [ ] Autoplay permission granted for the subdomain.
   - [ ] After a full browser restart, the speaker auto-becomes the Player and audio
         resumes without a click.

   ## Manual `<audio>` playback verification

   Real browser audio + autoplay behavior can't be unit-tested, so verify by hand
   after each deploy (spec §11):

   - [ ] Log in on a Remote; queue a YouTube link → it resolves and appears in the
         queue (`📻 Station is live`).
   - [ ] On the Player device, audio actually plays out the OS default output.
   - [ ] **Seek** the now-playing scrubber → audio jumps (HTTP range / `206` works).
   - [ ] **Pause / Resume / Skip** from a Remote → the Player reacts immediately.
   - [ ] **Volume** change from a Remote → the Player's `<audio>.volume` follows.
   - [ ] Let the explicit queue drain → the radio appends a related track and audio
         continues with no stall (queue-ahead worked).
   - [ ] Close the Player tab → Remotes show "No speaker connected", station paused;
         reopen it → it auto-resumes from the saved position.
   - [ ] `docker compose restart jukebox` → the station snapshot + remembered speaker
         survive (current track, queue, seed restored from `/data/cache`).

   ```

   ```

4. **Run it — expect PASS.** `cd /home/kasm-user/lan-jukebox && npx vitest run src/deploy/readme.test.ts`
   Expected: `Test Files  1 passed`, `Tests  7 passed`.

---

### Task 6.5: Phase completion — full verification, adversarial /debug, single squash commit

> This is the ONLY commit for the entire phase. Do not commit in Tasks 6.1–6.4.

**Steps**

1. **Full green verification.** Run the complete suite from the repo root:

   ```bash
   cd /home/kasm-user/lan-jukebox && npm run typecheck && npm run lint && npm run build && npm test
   ```

   Expected output (the deploy specs run alongside all prior-phase specs):
   - `typecheck`: tsc exits 0, no errors.
   - `lint`: eslint exits 0, no warnings/errors.
   - `build`: tsc + vite build succeed; `dist/` + `web/dist/` emitted.
   - `test`: vitest reports all files passing, including the four new deploy specs —
     `src/deploy/dockerfile.test.ts` (9), `src/deploy/workflow.test.ts` (8),
     `src/deploy/compose.test.ts` (9), `src/deploy/readme.test.ts` (7) — ending with
     `Test Files  N passed (N)` / `Tests  M passed (M)` and exit code 0.

2. **Artifact sanity (manual).** Confirm the leaf artifacts parse/lint where tools exist:

   ```bash
   cd /home/kasm-user/lan-jukebox && sh -n docker-entrypoint.sh && echo SHELL_OK
   cd /home/kasm-user/lan-jukebox && (docker compose config -q && echo COMPOSE_OK) 2>/dev/null || echo "docker absent (ok)"
   ```

   Expected: `SHELL_OK`; `COMPOSE_OK` if Docker is present, otherwise the "docker absent (ok)" fallback (sandbox has no Docker — not a blocker).

3. **Adversarial multi-agent `/debug` pass.** Fan out finder agents across every file changed/created in this phase — `Dockerfile`, `docker-entrypoint.sh`, `.github/workflows/build.yml`, `docker-compose.yml`, `.dockerignore`, `README.md`, and the four `src/deploy/*.test.ts` specs — each agent assigned a reliability lens:
   - **De-Discord/de-idle lens:** grep every artifact for `discord`, `oauth`, `IDLE_TIMEOUT`, `guild`, `voice`, `DISCORD_TOKEN`, `web,mweb` (default) — any hit is a confirmed bug (spec §1 non-goals, §3.1 deletions).
   - **Ingress/WS invariant lens:** verify NO `cloudflared` service and NO `TUNNEL_TOKEN` are bundled anywhere (bring-your-own ingress); the `jukebox` service publishes a localhost-bound host port (`ports: ["127.0.0.1:${HOST_PORT:-8080}:8080"]`); `ALLOWED_WS_ORIGINS` literally equals `PUBLIC_BASE_URL` in compose; no trust-proxy or second/admin-password env knobs (trustProxy is hardcoded `true` in the app; single shared password); README states the `/ws` upgrade + 101 verification (spec §10, §13).
   - **Secret-hygiene lens:** confirm `.dockerignore` excludes `.env`; compose secrets are `CHANGE_ME` placeholders (no real tokens); `SESSION_SECRET` placeholder is >= 32 chars; README warns to keep the filled copy local.
   - **Persistence lens:** confirm the single `cache:` volume mounts `/data/cache` and is documented to hold `station-snapshot.json` + `device-registry.json`; entrypoint chowns `CACHE_DIR` before the gosu drop so the app user can write all three (spec §4/§5 restart-safe).
   - **Supply-chain lens:** confirm Deno is pinned + SHA256-verified (no `curl|sh`); `YTDLP_REFRESH` cache-bust is wired both in the Dockerfile (`ARG`/`ENV`) and the workflow (`date +%Y%U` → build-arg); `no-cache` on schedule/dispatch; image tags are `:latest` + `:${{ github.sha }}`.
   - **Healthcheck/port-consistency lens:** confirm the same `/healthz` + `PORT||8080` healthcheck in both Dockerfile `HEALTHCHECK` and compose `healthcheck`, `EXPOSE 8080` matches `expose: ["8080"]`, and CI tags/image-name match the compose `image:`.
   - **Test-fixture-path lens:** confirm each `src/deploy/*.test.ts` resolves `repoRoot` correctly (`../..` from `src/deploy/`) and that vitest's `include` actually picks up `src/deploy/**` (it does via `src/**`).

   Adversarially verify each reported finding before acting (re-read the file region; reject false positives such as a `discord` substring appearing only inside an explanatory README sentence — though for de-Discord we want zero, so treat any such hit as real and remove it). Fix every confirmed bug, then re-run step 1 to re-confirm green.

4. **Single squash commit for the whole phase.** After green + clean debug, make exactly one commit (per the one-commit-per-phase rule):
   ```bash
   cd /home/kasm-user/lan-jukebox && git add Dockerfile docker-entrypoint.sh docker-compose.yml .dockerignore README.md .github/workflows/build.yml src/deploy/ && git commit -m "$(cat <<'EOF'
   Phase 6: deploy — Dockerfile, GHCR CI, compose (bring-your-own ingress), README

   - Multi-stage Dockerfile (Node 22 + yt-dlp[default] + bgutil + ffmpeg +
     SHA256-pinned Deno + gosu cache-chown entrypoint + /healthz HEALTHCHECK).
   - GHCR CI (.github/workflows/build.yml): test gate (typecheck/test/lint) →
     build/push :latest + :sha, weekly cron + date-keyed YTDLP_REFRESH cache-bust,
     no-cache on schedule/dispatch, concurrency cancel, gha cache mode=max.
   - docker-compose.yml: GHCR pull_policy:always, env block (no Discord, no idle
     timeout, no trust-proxy or admin-password knobs — trustProxy hardcoded true + single
     shared VIEWER_PASSWORD, ALLOWED_WS_ORIGINS==PUBLIC_BASE_URL), a localhost-bound
     published host port (127.0.0.1:${HOST_PORT:-8080}:8080) for the user's OWN external
     ingress — NO bundled cloudflared — named cache volume holding the station snapshot +
     device registry, /healthz healthcheck, optional bgutil-pot.
   - README: env table (incl. HOST_PORT), GHCR-public + workflow_dispatch +
     force-recreate gotchas, bring-your-own-ingress/WS-upgrade + hardcoded-trustProxy
     note, speaker-PC autoplay-grant + device-memory checklist, manual <audio>
     playback verification checklist.
   - src/deploy/*.test.ts: fixture-asserting Vitest specs guarding every invariant.

   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   EOF
   )"
   ```
   Expected: one commit created on the `master` branch; `git status` clean afterward. Do not push unless the user asks.

---

## Phase 7: Full parallel multi-agent release audit — Full parallel multi-agent release audit

**Goal:** Before declaring the project release-ready, run a comprehensive, **many-agent adversarial audit across the ENTIRE codebase** (not a single phase's diff), confirm each finding by independent skeptics, fix everything confirmed, and make the final release commit. This phase runs **after Phases 0–6 are all merged to `master`** and is distinct from the per-phase `/debug` (which only covered that phase's changed files).

**How it is executed:** as a `Workflow` (find → adversarially verify → fix → re-verify), scaled to be exhaustive — **use many agents** (token cost is not a constraint for this audit). The audit reads the whole tree under `src/**`, `web/src/**`, and the deploy assets (`Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`, `.github/workflows/*`).

**Parallelization:** finders and verifiers are read-only → **fully parallel**. Fixers follow the standing rule — **parallel on disjoint files, sequential on shared hubs** (`orchestrator`/station, `server/rest`, `server/ws`, `types`, web `App`/`useStationState`). A single final verify-and-fix agent runs the whole suite once at the end.

### Task 7.1: Run the release-wide finder fleet

- [ ] **Step 1: Fan out finders across files × reliability lenses.** Spawn a large fleet (scale to the file count — roughly one finder per source-cluster × lens), each blind to the others, each returning structured findings `{ file, line, lens, severity: "high"|"med"|"low", description, suggestedFix }`. Cover at least these lenses:
  - **Correctness/logic** — wrong behavior vs the spec and the Shared Types contract.
  - **Crash / uncaught exception / unhandled rejection** — process-fatal paths; `main()` startup; WS message handlers.
  - **Concurrency / races** — the playback mutex/semaphore, double-advance, the designate/handoff/disconnect window in `PlayerRegistry`, snapshot writes under load.
  - **Resource leaks** — orphaned `yt-dlp`/`ffmpeg` child processes, cache pins never released, WS/event listeners and timers not cleaned up, `<audio>` element churn.
  - **External-failure handling** — yt-dlp extraction failure + the player-client fallback ladder, network drops, lyrics 404, bgutil POT sidecar down, expired stream URLs.
  - **Station state-machine invariants** — the station **never stops**; the **no-timeout / no-auto-disconnect** guarantee holds everywhere; the **radio never runs the queue empty** (queue-ahead keeps ≥1 ready); **cold start waits for a seed**; skip advances but never ends the station.
  - **Restart / recovery** — `StationSnapshot` round-trips; resume position; **auto-select of the remembered speaker** on reconnect; cache survives restart.
  - **Auth / security** — single shared password (`requireSession` on every route; any authed user controls everything, no admin/elevation tier); signed/secure/SameSite cookies; hardcoded `trustProxy: true` scheme detection; `ALLOWED_WS_ORIGINS == PUBLIC_BASE_URL`; no auth bypass via WS; `/audio/:id` not an open proxy.
  - **API / WS contract conformance** — every REST DTO and WS frame matches the `## Shared Types` section exactly (names, optionality, discriminants).
  - **Deploy** — entrypoint `gosu` cache-volume chown; env validation refuses to start without `VIEWER_PASSWORD` (unless `ALLOW_NO_PASSWORD`); GHCR image is public; the `/ws` upgrade survives the Cloudflare Tunnel; `pull_policy: always`; healthcheck + graceful shutdown.
  - **UI/UX & a11y** — the Remote/Player panels: keyboard/focus, ARIA on transport controls, the "station live / waiting-for-seed" and "no speaker connected" states, error surfacing.

- [ ] **Step 2: Collect + de-duplicate.** Merge all finder outputs; de-dup by `(file, nearby-line, lens)`; keep the highest-severity description per cluster.

### Task 7.2: Adversarially verify every finding

- [ ] **Step 1: Refute each finding.** For every de-duped finding, spawn an odd number (≥3) of independent skeptic agents, each prompted to **REFUTE** it and to **default to `refuted: true` when uncertain**. Give verifiers distinct lenses where applicable (does-it-reproduce / is-it-reachable / does-the-contract-actually-say-this).
- [ ] **Step 2: Keep only survivors.** Retain a finding only if a majority of skeptics confirm it is real. Discard the rest (record them in the audit log so they are not silently dropped).

### Task 7.3: Fix all confirmed findings

- [ ] **Step 1: Cluster by file ownership.** Group confirmed findings into disjoint file clusters vs shared-hub touches.
- [ ] **Step 2: Apply fixes.** Fix disjoint clusters in parallel (one fixer agent per cluster); fix shared-hub findings sequentially. **Add a regression test** for each fix wherever it is testable (Vitest unit or contract test).
- [ ] **Step 3: No silent caps.** If anything is intentionally deferred (e.g., a low-severity UX nit), `log` it explicitly in the audit summary rather than dropping it.

### Task 7.4: Full verification, completeness critic, and final release commit

- [ ] **Step 1: Full suite green.**

```bash
npm run typecheck && npm run lint && npm run build && npm test
```

Expected: typecheck (backend + test + web) clean; eslint + prettier clean; web + tsc build succeed; **all Vitest suites pass**.

- [ ] **Step 2: Completeness critic.** Run one final critic agent asking "what file, lens, or claim did we NOT cover, and what remains unverified?" Feed anything it surfaces back through Tasks 7.1–7.3 until it comes back clean (loop-until-dry).

- [ ] **Step 3: Final release commit.** Make EXACTLY ONE squash commit for the audit:

```bash
git add -A && git commit -m "chore: full multi-agent release audit — fixes + regression tests

$(printf '%s\n' 'Release-wide adversarial audit (many agents, all reliability lenses);' 'every confirmed finding fixed with a regression test where testable.')

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

Expected: one commit on `master`; `git status` clean. Do not push unless the user asks.

---
