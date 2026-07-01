# LAN Jukebox — Always-On Radio — Design Spec

**Date:** 2026-06-30
**Status:** Approved (pending spec review)
**Working name:** LAN Jukebox (`lan-jukebox`)

## 1. Summary

A self-hosted, browser-based **always-playing group radio**. A Dockerized Node
backend (the always-on "master") holds the station state. Everyone uses a
browser:

- A browser is a **Remote** by default — it queues YouTube tracks and controls
  playback.
- A browser can become the **Player** — the audio output. Its HTML5 `<audio>`
  element plays what the backend sends; the browser routes it to the device's
  default audio output → the speakers.
- The backend **remembers devices**, so the known speaker device is
  **auto-selected as the Player** when it connects — no manual click each time.

The station **never stops**: you queue a song you like and it plays; when the
queue runs dry the station **autoplays related YouTube tracks** from your last
seed, indefinitely. There are **no idle timeouts and no auto-stop** anywhere.

This reuses most of the backend and UI from `~/discord-yt-music-bot`, with
Discord removed and the "stream Opus to a Discord voice channel" sink replaced
by "serve an audio stream that a browser plays."

### Non-goals (v1)

- No Discord integration.
- No multi-room / zones / cross-device audio sync.
- No native audio stack (mpv / ffmpeg-to-WASAPI) — the browser is the output.
- No sources other than YouTube (no uploads, no local files).
- No server-side ffmpeg audio effects (crossfade, loudnorm, EQ, visualizer).
- **No idle timeout / no auto-disconnect / no auto-stop** of any kind.

## 2. Decisions (locked)

| Decision     | Choice                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| What it is   | An always-playing YouTube radio station for a group                                                          |
| Backend      | Dockerized Node service = the always-on "master" / central coordinator                                       |
| Topology     | Central client-server (browsers ↔ one backend). **Not** WebRTC P2P.                                          |
| Audio output | A browser's `<audio>` element (the "Player"); routes to the OS default device → speakers                     |
| Player role  | "Play on this device" toggle; **remembered devices auto-become the Player**                                  |
| Zones        | Single station, one shared queue + radio                                                                     |
| Radio        | When the queue empties, autoplay YouTube related/mix from the last seed, forever                             |
| Cold start   | Wait for a seed — "Queue a song to start the station"; no default station                                    |
| Timeouts     | None. Never stops, never disconnects on idle                                                                 |
| Source       | YouTube only (exact link + search→pick)                                                                      |
| Access       | Single shared password (signed cookie); anyone authenticated may control everything                          |
| Hosting      | A `example.com` subdomain served from a high-uptime 2 Gbit home network (public HTTPS → local Docker host) |
| Deploy       | GitHub Actions builds the image → **GHCR (public)** → `docker-compose` pulls it                              |
| UI quality   | Built with the `frontend-design` skill — professional-grade for a professional group                         |
| Repo         | New standalone public repo under Atvriders; branch `master`                                                  |

## 3. Architecture

```
                         example.com subdomain (HTTPS, reverse proxy)
                                        │
[Speaker browser: Player] ─┐           ▼
[Client browser: Remote ] ─┼─ HTTP+WS ─→ [Dockerized Node/Fastify backend (master)]
[Client browser: Remote ] ─┘                   ├─ yt-dlp  (resolve + download + related/radio)
        ▲                                       ├─ ffmpeg  (remux/transcode only if needed)
        │ GET /audio/:trackId (range)  ←────────┤ disk cache (LRU, docker volume)
        │ WS: load/play/pause/seek/volume       ├─ device registry (persisted)
        └─ <audio> → OS default device → speakers└─ station snapshot (persisted, restart-safe)
```

The Docker host runs on the home network behind a reverse proxy that terminates
HTTPS for the `example.com` subdomain. The speaker (a Windows PC) and remotes
reach it by that URL from a browser; on the home LAN the audio moves at local
2 Gbit speed.

### 3.1 Backend modules (Node 22 / TypeScript / Fastify, in Docker)

Reused from the bot (de-Discorded, de-guilded):

- `youtube/` — yt-dlp service: URL parse, metadata resolve, search, download,
  **and related/radio fetch** (reuse the bot's autoplay-radio logic). Keep
  `lyrics` (lyrics.ovh).
- `cache/` — LRU cache of downloaded/transcoded audio (Docker volume).
- `queue/` — pure single-queue logic (add/remove/reorder/next/repeat/shuffle).
  De-guilded: one queue, not a per-guild map.
- `orchestrator/` — single **station** context (was per-guild "hub"): current
  track, queue, upcoming radio buffer, history, settings (volume,
  repeat, shuffle), restart-safe snapshot.
- `server/` — Fastify app, REST, WebSocket hub, static serving.
- `util/` — logger (pino), mutex, semaphore.

New / reworked modules:

- `radio/` — **station engine** (§4): seed tracking, related-track fetch via
  yt-dlp, keep ≥1 upcoming track ready, de-dup against recent history, never
  stop. Cold start waits for the first user seed.
- `audio/` — `GET /audio/:trackId` streaming route with **HTTP range** (seek);
  resolves trackId → cached file (downloading/transcoding first if needed);
  correct `Content-Type`, `Accept-Ranges`, `Content-Range`, 206.
- `players/` — **active-player registry + device memory + state machine** (§5).
- `auth/` — **shared-password** auth: reuse `session-store.ts`, **delete
  `oauth.ts`**. `POST /api/login` → signed session cookie; a single shared
  `VIEWER_PASSWORD` for everyone, and anyone authenticated may control
  everything. Display-name is attribution only.

Deleted from the bot: `discord/`, `voice/`, `auth/oauth.ts`, all Discord config,
the guild concept, **uploads, local-file sources, and all idle-timeout logic**.

### 3.2 Web app (React 19 / Vite / Tailwind 4, served by the backend)

Single SPA; role is runtime state:

- **Remote (default):** add bar (YouTube link / search→pick), now-playing with
  live progress, the queue (reorder/remove/clear) + the upcoming-radio preview,
  transport (play/pause/skip/seek/volume/repeat/shuffle), history,
  lyrics, and a clear "📻 Station is live / waiting for a seed" status. (No
  "stop" that kills the station — skip advances; the station never ends.)
- **Player role** (after "Play on this device", or auto on a remembered speaker):
  a managed hidden `<audio>` element subscribing to WS commands (load
  `/audio/:id`, play, pause, seek, setVolume), reporting `timeupdate` position
  and `ended` back. Shows "This device is the speaker" + a relinquish control.
- **Login gate** for the shared password; a display-name
  prompt persisted with a **persistent device token** in `localStorage` (this is
  how the backend remembers the device — see §5).

Reused components (de-guilded, Discord UI removed): AddBar, Controls,
NowPlaying, Queue, History, Lyrics, Thumb, Picker, Grain, `lib/api`,
`lib/format`, and `useGuildState` → `useStationState`. **Removed:**
ServerSelector, VoiceChannelPicker, Discord LoginGate, Visualizer, Discover
(optional), upload UI, local-file browser.

**The UI is (re)built with the `frontend-design` skill** to a professional,
production-grade standard (cohesive design system authored first, then applied
across Remote and Player) — it will be used by a professional group.

## 4. Radio / station engine (the "always playing" core)

- **Seed:** the most recent user-queued track is the station seed.
- **Continuation:** when the explicit queue is empty and the current track is
  ending, the engine fetches related/mix tracks for the seed via yt-dlp
  (YouTube `RD…` mix / related), filters out recent history to avoid repeats,
  and appends the next one. This repeats forever — the station never runs out.
- **Queue-ahead:** keep at least one upcoming track resolved + cached so the
  transition is gapless-ish (no stall while resolving).
- **Re-seeding:** any new user-queued track becomes the new seed and plays next
  (or is appended, per the add semantics); radio resumes from the newest seed
  after the queue drains again.
- **Cold start:** with no seed ever set, the station is idle and the UI shows
  "Queue a song to start the station." No default/auto station.
- **No timeouts:** the engine never stops, never disconnects, and has no idle
  behavior. "Skip" advances to the next track (queue or radio); there is no
  user-facing action that ends the station.
- **Listener model:** the station advances based on the active Player's playback
  (`ended`/telemetry). With no Player connected, playback is paused but the seed,
  current track, position, and upcoming buffer are preserved; when the
  (remembered) speaker reconnects it auto-resumes. (A wall-clock "live broadcast
  that plays even with no listeners" is deferred — not needed for one always-on
  speaker.)

## 5. Active-Player, device memory & state machine

**Device identity:** on first visit a browser is issued a persistent
`deviceId` (random token in `localStorage`); it sends this on every WS/REST
call. The backend keeps a **persisted device registry**: `{ deviceId, label,
lastSeen, isPreferredSpeaker }`.

**Active player:** backend state `activePlayerDeviceId | null`.

- **Manual designate** ("Play on this device"): set the active player to that
  device, tell the previous player to relinquish, tell the new one to load the
  current track at the current position. Optionally mark it
  `isPreferredSpeaker = true` ("remember this device as the speaker").
- **Auto-select (device memory):** when a device whose `isPreferredSpeaker` is
  true connects and no Player is active, the backend **auto-designates it** as
  the Player and resumes the station. This is the "speaker device is auto
  selected to be the speaker" behavior.
- **Player disconnect:** `activePlayerDeviceId → null`; station preserved
  (paused); remotes show "No speaker connected." Auto-select re-engages when the
  remembered speaker returns.
- **Invariant:** at most one active Player; audio commands only ever go to it.
- **Browser autoplay caveat:** a fresh page load can't start audio without a
  user gesture unless the site is granted autoplay permission. For the always-on
  speaker PC, the operator grants the subdomain autoplay permission once (or
  clicks once); thereafter auto-select + auto-resume work across reloads. This is
  documented in the README.

## 6. HTTP / WS contract (high level)

REST (under `/api`, session-gated except `/api/login`):

- `POST /api/login` `{ password, displayName, deviceId }` → signed session cookie.
- `GET  /api/state` → station snapshot (current, position, queue, upcoming-radio,
  settings, history, seed, activePlayer present?, isThisDeviceSpeaker).
- `POST /api/add` `{ urlOrQuery }` → resolve YouTube link, or return search
  candidates for `pick`; sets/updates the seed.
- `POST /api/pick` `{ candidateId }` → enqueue a chosen search result.
- `POST /api/control` `{ action, value? }` — play/pause/skip/seek/volume/repeat/
  shuffle/clear/remove/reorder. (No "stop the station".) Any authenticated user
  may perform any control action.
- `POST /api/speaker` `{ action: 'claim'|'release'|'remember'|'forget' }` —
  device/Player role management.
- `GET  /api/lyrics?trackId=` → lyrics.ovh passthrough.
- `GET  /audio/:trackId` → audio stream (range).

WebSocket `/ws` (one per browser, carries `deviceId`):

- Client→server: `hello {deviceId, role:'remote'}`, `becomePlayer`,
  `relinquishPlayer`, telemetry `position {ms}`, `trackEnded`,
  `playbackError {message}`.
- Server→all: `state` broadcasts (now-playing, queue, upcoming, position,
  activePlayer presence).
- Server→active Player only: `load {audioUrl, startMs}`, `play`, `pause`,
  `seek {ms}`, `setVolume {pct}`.

## 7. Auth & attribution

- Single shared **viewer password** (required) → signed session cookie via the
  reused session store. If unset in config the server refuses to start, unless
  `ALLOW_NO_PASSWORD=true`. There is no second/admin password: anyone
  authenticated may control everything.
- **Display name** + **deviceId** are client-supplied (attribution + device
  memory), not security boundaries.
- Behind HTTPS: secure, `SameSite` cookies; Fastify `trustProxy` is always `true`
  (the app is always behind the user's HTTPS proxy/tunnel) so the forwarded
  headers are honored for correct scheme detection + secure cookies + real
  client IP.

## 8. Audio format policy

- Source of truth is the cached file for a trackId.
- yt-dlp `bestaudio`. If the codec/container is broadly browser-playable
  (opus/webm, aac/m4a), serve as-is (remux to a clean container if needed, no
  re-encode). Otherwise transcode to AAC `.m4a` with ffmpeg.
- `/audio/:trackId` always supports HTTP range (206) for instant seeking.
- Reuse the bot's hardened extraction: player-client fallback ladder
  (`android_vr,web_embedded,tv` defaults — **not** `web,mweb`), optional bgutil
  PO-token sidecar, and CI cache-busting so yt-dlp stays current.

## 9. Scope: v1 vs deferred

**v1 (in scope):** always-on station + radio continuation, cold-start-waits-for-
seed, Player/Remote roles + handoff, **device memory + auto-select speaker**,
no-timeout guarantee, YouTube link + search→pick, queue (reorder/remove/clear) +
upcoming-radio preview, now-playing live progress, transport
(play/pause/skip/seek/volume/repeat/shuffle), history, lyrics,
shared-password auth (single shared password), restart-safe snapshot,
professional UI via `frontend-design`, Dockerized GHCR deploy via GitHub Actions.

**Deferred:** crossfade/gapless, EQ & FX presets, loudness normalization,
visualizer, multi-room/zones, audio sync, non-YouTube sources, wall-clock "live
broadcast" mode, mobile-native clients.

## 10. Deployment

- **Image:** multi-stage Dockerfile (Node 22) bundling yt-dlp + ffmpeg + Deno
  (nsig) + a `gosu`/entrypoint that fixes the cache-volume ownership (carry over
  the bot's `docker-entrypoint.sh` fix). Healthcheck + graceful shutdown +
  snapshot persistence so the station survives restarts.
- **CI:** GitHub Actions (Atvriders) builds + pushes to **GHCR, public**, on
  every push to `master`, with a weekly rebuild + a yt-dlp cache-bust. (Fork
  gotcha: first build may need a `workflow_dispatch`.)
- **Run:** `docker-compose.yml` pulls the GHCR image (`pull_policy: always`),
  mounts a named volume for cache + a volume/file for the persisted device
  registry + station snapshot, and sets env inline.
- **Ingress (bring your own — NOT bundled):** the project does **not** bundle or
  run `cloudflared`. The user fronts it with their **own separate** Cloudflare
  Tunnel (or any HTTPS reverse proxy). The container publishes a localhost-bound
  host port (`127.0.0.1:${HOST_PORT:-8080}:8080`) that a host-level tunnel dials,
  or — if the tunnel runs as its own container — it joins a shared Docker network
  and reaches the app at `http://jukebox:8080`. **HTTPS is terminated at the
  Cloudflare edge** and the tunnel reaches the origin over plain HTTP; Cloudflare
  sets `X-Forwarded-Proto: https`, and Fastify `trustProxy` is always `true` so
  scheme detection + secure cookies + real client IP are correct behind the
  tunnel; Cloudflare Tunnels pass **WebSockets** through (verify `/ws` upgrades
  end-to-end, expect HTTP 101).
- **Config (env):** `PORT`, `PUBLIC_BASE_URL` (the `https://` subdomain),
  `ALLOWED_WS_ORIGINS` (**must equal** `PUBLIC_BASE_URL`),
  `VIEWER_PASSWORD`, `CACHE_DIR`, cache size,
  yt-dlp player clients, optional bgutil POT URL. No idle-timeout settings exist.
  (Fastify `trustProxy` is hardcoded `true` — not a configurable env var.)
- Speaker PC: open the subdomain in a browser, log in, grant autoplay permission
  once; thereafter it's the remembered, auto-selected speaker.

## 11. Testing

- Vitest. Unit-test: queue logic, orchestrator/station transitions, **radio
  engine** (seed → related fetch → de-dup → keep-ahead → never-empty),
  **active-player + device-memory state machine** (manual designate, auto-select
  remembered speaker, disconnect/resume), auth (shared-password login/logout),
  YouTube resolvers (URL parse, search), and the WS protocol against a **mock
  Player**.
- Real browser `<audio>` playback + autoplay-permission behavior is
  **manual-verify**, documented with a README checklist.

## 12. Build approach (parallel agents)

New standalone repo; reuse modules are **copied in and pruned**, not imported.
Subagent/workflow-driven, per the bot's hard-won lesson:

- **Sequential** for shared hubs: `orchestrator`/station, `server/rest`,
  `server/ws`, `types`, the React `App`/state hook — parallel edits clobber.
- **Parallel** for disjoint files: new route modules (`radio`, `audio`,
  `players`, `auth`), and per-component UI files once the design system + shared
  types are fixed.
- A final verify-and-fix agent runs the full suite (typecheck + lint + build +
  tests) once per stage. One commit at the end of each plan phase.

## 13. Open risks

- **Browser autoplay policy** for the auto-selected speaker — mitigated by the
  one-time site permission grant (§5), documented.
- **Continuous egress / yt-dlp load** from a 24/7 radio — mitigated by the
  2 Gbit home host, the LRU cache, and queue-ahead resolution; monitor.
- **yt-dlp breakage** over time — mitigated by the player-client fallback
  ladder, optional bgutil POT, and CI cache-busting (carried from the bot).
- **WS origin/upgrade over the Cloudflare Tunnel** — `ALLOWED_WS_ORIGINS` must
  equal the public subdomain (explicit bot gotcha), and the `/ws` upgrade must be
  verified end-to-end through `cloudflared`; both enforced + documented.
- **Keeping the speaker tab awake** on an always-on PC — recommend foreground/
  fullscreen + Wake Lock; revisit if throttling appears (deferred).
