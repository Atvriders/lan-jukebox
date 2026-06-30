# LAN Jukebox — Design Spec

**Date:** 2026-06-30
**Status:** Approved (pending spec review)
**Working name:** LAN Jukebox (`lan-jukebox`)

## 1. Summary

A self-hosted, browser-based group music player for a local network. One Node
server runs on a Windows PC that is wired to speakers. Everyone — the speaker
machine and every client — opens the **same web app** in a browser:

- On load, a browser is a **Remote** (search, queue, control).
- Clicking **"Play on this device"** turns that browser into the **Player** —
  the audio output. Its HTML5 `<audio>` element plays whatever the server sends,
  and the browser routes it to Windows' default audio device → the speakers.
- Exactly **one active Player** at a time (single playback zone). Designating a
  new Player hands off from the old one.

This project reuses most of the backend and UI from `~/discord-yt-music-bot`,
removing Discord entirely and replacing the "stream Opus into a Discord voice
channel" sink with "serve an audio stream that a browser plays."

### Non-goals (v1)

- No Discord integration of any kind.
- No multi-room / multi-zone playback or cross-room audio sync.
- No native Windows audio stack (mpv / ffmpeg-to-WASAPI). The browser is the
  audio output device.
- No server-side ffmpeg audio effects (crossfade, loudnorm, EQ presets,
  visualizer). Deferred; see §9.

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Speaker host | One Windows PC; the browser is the audio output |
| Zones | Single playback target, one shared queue |
| Discord | Removed entirely |
| Player role | One web app; "Play on this device" toggle designates the active Player; everyone else is a Remote |
| Access control | Single shared password (signed session cookie); optional separate admin password for destructive/global actions |
| Sources | YouTube exact link, YouTube search + pick, client-uploaded files, local files on the speaker PC |
| Audio delivery | Server downloads/serves to cache; browser `<audio>` plays `/audio/:trackId` (HTTP range supported) |
| Deployment | Native Windows Node process (no Docker). `yt-dlp.exe` + `ffmpeg.exe` bundled/auto-downloaded; `start.bat` launches server + opens Player tab |
| UI quality | Built with the `frontend-design` skill — professional-grade, suitable for a professional group setting |
| Repo | New standalone public repo under Atvriders; branch `master` |

## 3. Architecture

```
[Client browser: Remote] ─┐
[Client browser: Remote] ─┼─ HTTP + WebSocket ─→ [Node/Fastify server on Windows PC]
[Speaker browser: Player]─┘                              │   ├─ yt-dlp (resolve + download)
        ▲                                                │   ├─ ffmpeg (remux/transcode if needed)
        │  GET /audio/:trackId (range)  ←────────────────┘   ├─ disk cache (LRU)
        │  WS: load/play/pause/seek/volume                   ├─ uploads dir
        └─ <audio> → Windows default device → speakers       └─ configured local music dir
```

### 3.1 Server modules (Node 22 / TypeScript / Fastify)

Reused from the bot (de-Discorded):

- `youtube/` — yt-dlp service: URL parse, metadata resolve, search, download.
  (`url-parser`, `ytdlp`, `index`, `errors`, `lyrics` kept; lyrics via lyrics.ovh.)
- `cache/` — LRU cache of downloaded/transcoded audio files.
- `queue/` — pure single-queue logic (add, remove, reorder, next, repeat,
  shuffle). De-guilded: one queue, not a map of guild queues.
- `orchestrator/` — single playback context (formerly per-guild "hub"):
  current track, queue, history, playlists, settings (volume, repeat, shuffle),
  snapshot persistence for restart recovery. Collapsed from multi-guild to one.
- `server/` — Fastify app, REST routes, WebSocket hub, static file serving.
- `util/` — logger (pino), mutex, semaphore.

New modules:

- `audio/` — `GET /audio/:trackId` streaming route with **HTTP range** support
  (seek). Resolves trackId → a cached file (downloading/transcoding first if
  necessary), streams with correct `Content-Type`, `Accept-Ranges`,
  `Content-Range`, 206 partial responses.
- `players/` — **active-player registry + state machine** (see §5). Tracks
  connected WS clients, which one is the active Player, handoff, and disconnect.
- `sources/` — pluggable track sources beyond YouTube:
  - `upload` — multipart upload endpoint; store in uploads dir; index as a Track.
  - `local` — browse a single **configured music root** (path-traversal guarded);
    list directories/files; serve via the same `/audio/:trackId` route.
- `auth/` — **shared-password** auth. Reuse `session-store.ts`; **delete
  `oauth.ts`**. `POST /api/login` validates the password and sets a signed
  session cookie. Optional admin password elevates the session for destructive
  actions. Display-name attribution is client-supplied, not authenticated.

Deleted from the bot: `discord/` (bot, command-parser, handlers, picker,
presence, np-message, bio), `voice/` (connect, session, filter), `auth/oauth.ts`,
all Discord config keys, the guild concept throughout.

### 3.2 Web app (React 19 / Vite / Tailwind 4)

Single SPA. Role is runtime state, not a separate build:

- **Default = Remote.** Search/add bar (link / search), now-playing with live
  progress, queue (reorder/remove/clear), transport controls
  (play/pause/skip/stop/seek/volume/repeat/shuffle), history, playlists, upload,
  local-file browser, lyrics panel.
- **Player role** (after "Play on this device"): a managed hidden `<audio>`
  element. Subscribes to WS player commands (load `/audio/:id`, play, pause,
  seek, set volume). Reports `timeupdate` (position) and `ended` back to the
  server. Volume applied via the `<audio>.volume` (or a Web Audio `GainNode` if
  we later want >100%). Shows a clear "This device is the speaker" state with a
  "Stop being the speaker" control.
- **Login gate** for the shared password; optional admin unlock for elevated
  controls; a display-name prompt (persisted in `localStorage`).

Reused components (de-guilded, Discord UI removed): AddBar, Controls,
NowPlaying, Queue, History, Playlists, Discover (optional), Lyrics, Thumb,
Picker, Grain, plus `lib/api`, `lib/format`, and a reworked `useGuildState` →
`usePlayerState` hook. **Removed:** ServerSelector, VoiceChannelPicker,
LoginGate(Discord), Visualizer (deferred).

**The UI is (re)styled with the `frontend-design` skill** to a professional,
production-grade standard — clean, legible, distinctive, not generic-AI — since
it will be used by a professional group. A cohesive design system (typography,
spacing, color, components) is authored first, then applied across Remote and
Player views.

## 4. Track lifecycle & data flow

1. A Remote submits input: a YouTube URL, a search query (→ results → pick), an
   uploaded file, or a chosen local file.
2. Server resolves it to a `Track` (id, title, artist/uploader, duration,
   thumbnail, source kind, requester display-name) and appends to the queue.
3. If nothing is playing **and** an active Player exists, the orchestrator
   advances: picks the next track and sends the Player a WS `load` (with
   `/audio/:id` and start position 0) then `play`.
4. The server ensures the audio is available in cache: yt-dlp downloads
   `bestaudio`; **remux/transcode to a browser-playable format only if the
   source codec/container isn't broadly playable** (target Chrome/Edge: opus/
   webm and aac/m4a are fine; transcode others to AAC `.m4a` via ffmpeg). Then
   `/audio/:id` streams it with range support.
5. The Player's `<audio>` plays; on `timeupdate` it reports position to the
   server, which broadcasts now-playing (with live position) to all Remotes for
   the moving progress bar. On `ended`, the Player notifies the server →
   orchestrator advances to the next track (honoring repeat/shuffle).
6. Any Remote's transport action → server → forwarded to the active Player as a
   WS command **and** broadcast to all clients so every UI stays in sync.

## 5. Active-Player state machine

Server state: `activePlayerId: string | null` (a WS connection id).

- **Designate** ("Play on this device"): set `activePlayerId` to the requesting
  connection. Tell the previous Player (if any) to `stop`/relinquish. Tell the
  new Player to `load` the current track at the current position and resume the
  prior play/pause state.
- **Player disconnect** (WS closes) while it is active: `activePlayerId → null`.
  Playback is considered paused. Queue + current track + position are preserved.
  Remotes display **"No speaker connected — click Play on this device."** A new
  designation resumes from the preserved position.
- **Invariant:** at most one active Player. A `load`/`play` command is only ever
  sent to the active Player. Remotes never receive audio commands.
- Edge cases: designating the already-active device is a no-op; designating
  during an in-flight track download waits for the cache then loads.

## 6. HTTP / WS contract (high level)

REST (all under `/api`, session-gated except `/api/login`):

- `POST /api/login` `{ password, displayName }` → sets session cookie.
- `POST /api/admin` `{ password }` → elevates session (if admin password set).
- `GET  /api/state` → full snapshot (queue, current, position, settings,
  activePlayer present?, history, playlists).
- `POST /api/add` `{ source, urlOrQuery | fileRef }` → resolve + enqueue (search
  returns candidates for `pick`).
- `POST /api/pick` `{ candidateId }` → enqueue a chosen search result.
- `POST /api/control` `{ action, value? }` — play/pause/skip/stop/seek/volume/
  repeat/shuffle/clear/remove/reorder. Destructive/global actions require an
  elevated session if an admin password is configured.
- `POST /api/upload` (multipart) → store + enqueue.
- `GET  /api/local?path=` → list the configured music dir (guarded).
- `GET  /api/lyrics?trackId=` → lyrics.ovh passthrough.
- `GET  /audio/:trackId` → audio stream (range).

WebSocket `/ws` (one connection per browser):

- Client→server: `hello {role:'remote'}`, `becomePlayer`, `relinquishPlayer`,
  player telemetry `position {ms}`, `trackEnded`, `playbackError {message}`.
- Server→client (to all): `state` broadcasts (now-playing, queue, position,
  activePlayer presence).
- Server→active Player only: `load {audioUrl, startMs}`, `play`, `pause`,
  `seek {ms}`, `setVolume {pct}`, `stop`.

## 7. Auth & attribution

- Single shared **viewer password** (required) → signed session cookie via the
  reused session store. Configurable; if blank in config the server refuses to
  start (no accidentally-open instance) unless `ALLOW_NO_PASSWORD=true`.
- Optional **admin password**. If set, destructive/global actions
  (skip/stop/clear/settings/remove-others'-tracks) require an elevated session.
  If unset, all authenticated users can do everything.
- **Display name** is supplied by the client and shown as "queued by …". It is
  attribution only, not security.

## 8. Audio format policy

- Source of truth is the cache file for a trackId.
- YouTube: yt-dlp `bestaudio`. If the resulting codec/container is broadly
  browser-playable (opus/webm, aac/m4a), serve as-is (remux to a clean container
  if needed, no re-encode). Otherwise transcode to AAC `.m4a` with ffmpeg.
- Uploads: accept common audio (mp3, m4a/aac, ogg/opus, webm, wav, flac).
  Chrome/Edge play all of these; serve as-is. Transcode only on a detected
  incompatibility.
- Local files: same handling as uploads, served from the configured music root.
- `/audio/:trackId` always supports HTTP range (206) for instant seeking.

## 9. Scope: v1 vs deferred

**v1 (in scope):** the single-zone player, Player/Remote roles + handoff,
shared-password auth (+ optional admin), all four sources, queue
(reorder/remove/clear), now-playing w/ live progress, transport
(play/pause/skip/stop/seek), volume, repeat, shuffle, history, playlists,
lyrics, restart-recovery snapshot, professional UI via `frontend-design`.

**Deferred (not v1):** crossfade / gapless, server- or Web-Audio EQ & FX presets
(bassboost/nightcore/etc.), loudness normalization, the decorative visualizer,
multi-room/zones, audio sync across devices, mobile-native clients. All are
clean additions on top of the v1 architecture.

## 10. Deployment (Windows, native)

- `npm install && npm run build && npm start` runs the server on a configurable
  port (default e.g. 4545).
- `yt-dlp.exe` and `ffmpeg.exe`: bundled in the repo or auto-downloaded on first
  run into a `bin/` dir; path resolved cross-platform.
- A `start.bat` (and a README quickstart) starts the server and opens the
  Player tab; the speaker operator clicks "Play on this device" once (or we open
  directly to a `?player=1` deep link that auto-offers it).
- Clients browse to `http://<speaker-pc-ip>:PORT` and log in with the shared
  password. Config via a `.env`/`config` file (port, viewer password, admin
  password, music root, cache dir/size, yt-dlp options).
- Cross-platform: the server also runs on Linux/Mac (browser is the output
  everywhere), but Windows is the supported target.

## 11. Testing

- Reuse Vitest. Unit-test: queue logic, orchestrator transitions, active-player
  state machine (designate/handoff/disconnect/resume), auth (password +
  admin elevation), source resolvers (URL parse, search, upload indexing, local
  listing + traversal guard), and the WS protocol against a **mock Player**.
- The real browser `<audio>` playback + Windows audio output is **manual-verify**
  (like Discord voice was in the bot) — documented in the README with a
  checklist.

## 12. Build approach (agents, in parallel)

New standalone repo; reuse modules are **copied in and pruned**, not imported
from the bot. Implementation is subagent/workflow driven. Per the hard lesson
from the bot build:

- **Sequential** for shared hubs: `orchestrator`, `server/rest`, `server/ws`,
  `types`, the React `App`/state hook — parallel edits to these silently clobber.
- **Parallel** for disjoint files: independent new route modules (`audio`,
  `players`, `sources/*`, `auth`), and per-component UI files once the design
  system and shared types are fixed.
- A final verify-and-fix agent runs the full suite (typecheck + lint + build +
  tests) once per stage. Single commit at the end of each plan phase per the
  established commit workflow.

## 13. Open risks

- **Browser autoplay policy:** the Player tab must get one user gesture before
  audio can start. "Play on this device" *is* that gesture, so the first load is
  safe; document that the Player tab can't autoplay before the click.
- **Codec edge cases:** rare YouTube/local formats may need transcoding; the
  policy in §8 plus an ffmpeg fallback covers it, but verify on the target
  Chrome/Edge.
- **Keeping the Player tab awake:** Windows/browser may throttle a background
  tab. Recommend the Player tab stay foreground/fullscreen; consider a
  Wake Lock + an inaudible keep-alive if throttling is observed (deferred).
