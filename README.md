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
#    Keep your filled-in copy LOCAL — do NOT commit real secrets to the repo.
# 2. Pull + run. The app publishes host port ${HOST_PORT:-3018} on all interfaces —
#    reach it on the LAN at http://<host-ip>:3018 and/or point your OWN external
#    ingress (a separate Cloudflare Tunnel, nginx, etc.) at it.
docker compose up -d
```

The image is published **public** to `ghcr.io/atvriders/lan-jukebox:latest` by
GitHub Actions on every push to `master`, plus a weekly rebuild that cache-busts
yt-dlp (YouTube rotates its nsig solver, so a stale yt-dlp breaks extraction).

## Configuration (env)

`src/config.ts` is the only env reader, and this table is the reference for it —
`docker-compose.yml` is deliberately kept to values plus one-line reminders, with
every explanation living here instead. Defaults below are the values
`src/config.ts` falls back to; anything **not** present in `docker-compose.yml`
simply takes its default, so you only add a line when you want to change one. A
few shipped values intentionally differ from the code default (noted inline).

| Variable                 | Required | Default                      | Notes                                                                                                                                                          |
| ------------------------ | -------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                   | no       | `3018`                       | Container listen port (1–65535).                                                                                                                               |
| `HOST_PORT`              | no       | `3018`                       | Compose-only (the app never reads it): the host port mapped to `3018`, published on **all** interfaces. See Bring your own ingress.                            |
| `HOST`                   | no       | `0.0.0.0`                    | Bind address inside the container.                                                                                                                             |
| `PUBLIC_BASE_URL`        | yes      | —                            | The public `https://` subdomain (e.g. `https://jukebox.example.com`). Trailing slash is stripped. The server refuses to start without it.                      |
| `ALLOWED_WS_ORIGINS`     | no\*     | = `PUBLIC_BASE_URL`          | CSV of `Origin`s allowed to open `/ws`. **Must equal `PUBLIC_BASE_URL` exactly**, or the WebSocket is rejected and the UI never goes live.                     |
| `VIEWER_PASSWORD`        | yes\*\*  | —                            | Single shared password; anyone authenticated controls everything. There is no separate admin/second password.                                                  |
| `ALLOW_NO_PASSWORD`      | no       | `false`                      | The literal string `true` runs with no viewer password (LAN-only escape hatch); anything else is false.                                                        |
| `SESSION_SECRET`         | yes      | —                            | Cookie-signing secret, **>= 32 chars** (server refuses to start otherwise).                                                                                    |
| `CACHE_DIR`              | no       | `/data/cache`                | Audio LRU **plus** the station snapshot, device registry, and materialized cookies file. Mount a volume here.                                                  |
| `CACHE_MAX_MB`           | no       | `2048`                       | LRU audio cache size cap, MiB (>= 1). Compose ships `5000`.                                                                                                    |
| `MIN_FREE_DISK_MB`       | no       | `1024`                       | Free-space floor (MiB) on the `CACHE_DIR` filesystem the cache tries to hold by evicting; `0` disables it. Read Persistence below — it is not a download veto. |
| `HISTORY_MAX_ITEMS`      | no       | `100`                        | Recently-played history length (>= 1).                                                                                                                         |
| `SEARCH_RESULT_COUNT`    | no       | `5`                          | Search-candidate count (>= 1). Compose ships `10`.                                                                                                             |
| `PREFETCH_DEPTH`         | no       | `1`                          | Radio queue-ahead depth (>= 0). Compose ships `3`.                                                                                                             |
| `MAX_TRANSCODE_JOBS`     | no       | `2`                          | Parallel yt-dlp download/transcode cap (>= 1). Compose ships `4`.                                                                                              |
| `TRANSCODE_BITRATE_KBPS` | no       | `256`                        | Target kbps of the **fallback** re-encode only (32–512). Playable opus/webm + aac/m4a are served untouched, so this affects only the rare re-encoded track.    |
| `MAX_TRACK_DURATION_SEC` | no       | — (`0`/empty = no cap)       | Reject tracks longer than this many seconds; `0`, empty, or unset means no ceiling.                                                                            |
| `RADIO_MAX_AUTOPLAY_SEC` | no       | `900` (15 min); `0` = no cap | Radio **auto-discovery** skips candidates longer than this many seconds; `0` = no cap. **User-requested tracks are never capped.**                             |
| `YTDLP_TIMEOUT_MS`       | no       | `60000`                      | Per-invocation yt-dlp timeout (ms, >= 1).                                                                                                                      |
| `YT_PROXY`               | no       | —                            | Optional residential/SOCKS proxy for yt-dlp, if your IP gets blocked.                                                                                          |
| `YT_COOKIES`             | no       | —                            | Optional mounted `cookies.txt` path for flagged IPs (takes precedence over `YT_COOKIES_TEXT`).                                                                 |
| `YT_COOKIES_TEXT`        | no       | —                            | Paste cookies inline (a browser `Cookie:` header or a full `cookies.txt`); written to `<CACHE_DIR>/yt-cookies.txt` at startup. See YouTube extraction.         |
| `YT_AUDIO_FORMAT`        | no       | `bestaudio/best`             | yt-dlp `-f` format selector for the audio download (see Audio quality below).                                                                                  |
| `YT_AUDIO_SORT`          | no       | `abr,acodec:opus`            | yt-dlp `-S` format sort — picks the highest-bitrate opus. `off` drops the `-S` sort and uses yt-dlp's own ordering.                                            |
| `YT_SPONSORBLOCK`        | no       | music-focused CSV            | SponsorBlock categories yt-dlp removes from downloaded audio. Unset = `music_offtopic,intro,outro,sponsor,selfpromo,preview,interaction`; `off` disables.      |
| `YT_PLAYER_CLIENTS`      | no       | `android_vr,web_embedded,tv` | Zero-PO-token client ladder. **Never** use `web,mweb` unless you run the bgutil PO-token sidecar (see YouTube extraction).                                     |
| `PO_TOKEN_PROVIDER_URL`  | no       | —                            | Only set (e.g. `http://bgutil-pot:4416`) when you run the optional bgutil PO-token provider (`--profile pot`).                                                 |
| `LOG_LEVEL`              | no       | `info`                       | pino level (`trace`..`fatal`); an unrecognized level fails startup.                                                                                            |
| `NODE_ENV`               | no       | `development`                | Set `production` in deploy (compose does) — enables `Secure` session cookies.                                                                                  |

> \* `ALLOWED_WS_ORIGINS` is optional only because it **defaults to
> `PUBLIC_BASE_URL`**. If you set it, it must still equal `PUBLIC_BASE_URL`.
> \*\* `VIEWER_PASSWORD` is required unless `ALLOW_NO_PASSWORD=true`.
>
> There are intentionally **no idle-timeout settings** — the station never stops.
> There is also **no trust-proxy knob**: see Bring your own ingress.

## Audio quality (and YouTube's real ceiling)

`YT_AUDIO_FORMAT` (yt-dlp `-f`) and `YT_AUDIO_SORT` (yt-dlp `-S`) choose which
audio stream is downloaded; the defaults ask for the **highest-bitrate opus**
YouTube will hand out. The ceiling is **YouTube's, not this app's**: for a
free/anonymous account YouTube tops out at roughly **160 kbps opus**. The
higher-bitrate opus formats are only offered to a **YouTube Premium** account, so
you get them only by supplying that account's cookies via `YT_COOKIES_TEXT` (or
`YT_COOKIES`). Set `YT_AUDIO_SORT=off` to drop the `-S` sort entirely and take
yt-dlp's own ordering.

`TRANSCODE_BITRATE_KBPS` does **not** apply to most tracks: browser-playable
opus/webm and aac/m4a are served **untouched** (no re-encode, no second quality
loss). It sets the target bitrate of the **fallback** ffmpeg re-encode used only
for a format the browser can't play directly.

## YouTube extraction (cookies, player clients, PO tokens)

**Cookies — the fix for "Sign in to confirm you're not a bot".** On a flagged IP
YouTube demands sign-in; supplying cookies from a logged-in browser clears it (and
is also how you get Premium-only audio formats). Two ways:

- `YT_COOKIES` — path to a **mounted** `cookies.txt`. If set, it always wins.
- `YT_COOKIES_TEXT` — the cookies pasted **inline** into `docker-compose.yml`. At
  startup it is written to `<CACHE_DIR>/yt-cookies.txt` with mode `0600`, so no
  file mount is needed (yt-dlp's `--cookies` only accepts a path). If that write
  fails (full disk, unwritable `CACHE_DIR`) the app logs an error and runs
  **without** cookies rather than refusing to start.

`YT_COOKIES_TEXT` accepts **both** forms. Easiest is a one-line browser `Cookie:`
request header (DevTools → Network → any `youtube.com` request → Request Headers →
`cookie`), which is converted to Netscape format for you:

```yaml
YT_COOKIES_TEXT: "VISITOR_INFO1_LIVE=...; LOGIN_INFO=...; SID=...; HSID=...; SSID=..."
```

Or a full exported `cookies.txt`, as a YAML block scalar (tab-separated lines; the
`# Netscape HTTP Cookie File` header is added if missing):

```yaml
YT_COOKIES_TEXT: |
  # Netscape HTTP Cookie File
  .youtube.com	TRUE	/	TRUE	2000000000	SID	<value>
```

**Player clients.** The default `YT_PLAYER_CLIENTS=android_vr,web_embedded,tv` are
**zero-PO-token** clients — they extract audio without a proof-of-origin token and
are reliable on most hosts. Only switch to `web,mweb` if you _also_ run the bgutil
sidecar (`docker compose --profile pot up -d`) and set
`PO_TOKEN_PROVIDER_URL=http://bgutil-pot:4416`; without that, those clients
silently fail to extract audio.

## Persistence (the `cache` volume) and disk

The `cache` named volume mounted at `CACHE_DIR` (`/data/cache`) holds more than
audio — deleting it resets the station:

- the **LRU audio cache** (downloaded/transcoded tracks, capped by `CACHE_MAX_MB`;
  files left by a previous run are re-adopted at startup so a restart reuses them
  instead of re-downloading),
- `station-snapshot.json` — current track, queue, upcoming-radio, seed,
- `device-registry.json` — the remembered speaker / auto-select state,
- `yt-cookies.txt` — written from `YT_COOKIES_TEXT` at startup.

So both the **station and the remembered speaker survive** `docker compose up`
restarts.

`MIN_FREE_DISK_MB` is a **best-effort recovery floor, not a download veto** — the
naming invites the wrong assumption. The check runs inside the cache's
`register()`, i.e. **after** a downloaded file is already written to disk. If free
space on the `CACHE_DIR` filesystem is below the floor it **evicts LRU (unpinned)
entries to try to get back above it**, stopping early when eviction stops
reclaiming space (the shortfall is external — logs, other containers, an
under-provisioned volume) or after a bounded number of evictions, and logs a
warning in that case. It never rejects a track and never throws. `0` disables it.
Keep it comfortably above your largest expected track: a genuinely full host disk
breaks **every** write (snapshot, cookies, logs), not just the audio cache.

## Bring your own ingress (e.g. a separate Cloudflare Tunnel)

This project does **not** bundle, install, or run `cloudflared`. There is no
`TUNNEL_TOKEN` and no `tunnel` compose profile. You provide your **own external
ingress** — a separate Cloudflare Tunnel, nginx, Caddy, Traefik, etc. Two ways to
wire it up:

- **Host-level ingress (default).** The `jukebox` service publishes host port
  `${HOST_PORT:-3018}:3018` on all interfaces, so it's reachable on the LAN at
  `http://<host-ip>:3018` and by a host-level `cloudflared` / reverse proxy at
  `http://<host-ip>:${HOST_PORT}` (override `HOST_PORT` to avoid a clash). To keep the
  app OFF the LAN (only a same-host tunnel can reach it), prefix the mapping with
  `127.0.0.1:` — i.e. `"127.0.0.1:${HOST_PORT:-3018}:3018"`.
- **Containerized ingress.** If your tunnel runs as its own container, drop the
  `ports:` mapping, attach both it and the `jukebox` service to a shared external
  Docker network, and reach the app at `http://jukebox:3018` over that network.
- **HTTPS is terminated at your edge.** Your tunnel/proxy reaches the origin over
  plain HTTP and should set `X-Forwarded-Proto: https`. The app hardcodes Fastify
  **`trustProxy: true`** (a fixed behavior, not an env knob — the app is always
  behind your HTTPS proxy/tunnel) so it honors `X-Forwarded-*` for correct scheme
  detection, `Secure` session cookies, and the real client IP.
- **WebSocket gotcha (verify end-to-end).** Cloudflare Tunnels (and most proxies)
  pass WebSockets through, but the app's origin guard rejects any `/ws` upgrade
  whose `Origin` header isn't in `ALLOWED_WS_ORIGINS`. So **`ALLOWED_WS_ORIGINS`
  must equal `PUBLIC_BASE_URL` exactly** (scheme + host, no trailing slash). After
  deploy, confirm the `/ws` upgrade succeeds through your ingress (browser devtools
  → Network → WS shows status `101 Switching Protocols`; the header badge flips
  from "○ No speaker" to "● _name_ live" once a Player is attached). A
  `403 bad_origin` / immediately-closed socket means the origins don't match.

## CI / GHCR gotchas

- **Public package.** The GHCR image is published **public**. If the first build
  leaves the package private, set its visibility to public once in the GitHub
  package settings (Packages → `lan-jukebox` → Package settings → Change visibility).
- **Forked-repo first build.** On a fork, Actions may not run automatically on the
  first push — trigger the initial build manually via **`workflow_dispatch`** (the
  Actions tab → the build workflow → "Run workflow" button). `workflow_dispatch` and
  the weekly cron also force a `--no-cache` rebuild with a date-keyed
  `YTDLP_REFRESH` build-arg so yt-dlp/Deno are actually re-fetched.
- **Re-pulling a new image.** `pull_policy: always` re-pulls on `up`, but a running
  container is **not** recreated just because a newer `:latest` exists. To force a
  fresh image onto a running deployment:
  `docker compose pull && docker compose up -d --force-recreate`.

## Resource limits (memory ceiling and zombie reaping)

**`mem_limit: 1g`.** The station fans out `yt-dlp` + `ffmpeg` jobs driven by
`PREFETCH_DEPTH` (radio queue-ahead) and `MAX_TRANSCODE_JOBS` (parallel
download/transcode). On a small, always-on host that burst can be OOM-killed
mid-song (the container restarts and resumes, but the music cuts out).
`docker-compose.yml` ships a `mem_limit: 1g` ceiling for this reason — ample for
audio-only work. If you still get OOM-killed (`docker inspect <c> --format
'{{.State.OOMKilled}}'`), **lower `PREFETCH_DEPTH` and/or `MAX_TRANSCODE_JOBS`**
and/or raise `mem_limit`.

**`init: true`.** Both services run a tiny init (tini) as PID 1 so orphaned
grandchildren are reaped. yt-dlp forks `ffmpeg`, and when a hung child is
SIGKILLed on timeout its own children are reparented to PID 1. Node reaps only its
_direct_ children, so on a forever-running station with continuous downloads and
timeout-kills those orphans would accumulate as `<defunct>` zombies and creep
toward the PID limit.

## Speaker PC: one-time autoplay grant + device memory

Browsers block audio autoplay until the site is granted permission or the user
interacts. For the always-on speaker PC, do this **once**:

1. Open `PUBLIC_BASE_URL` in the speaker PC's browser and log in with the shared
   password and a display name. A persistent **`deviceId`** device token is stored
   in `localStorage` (key `ljb.deviceId`) and sent at login — this is how the
   backend recognizes the device on every reconnect.
2. Click **"Play on this device"** to make it the Player.
3. Mark it the remembered speaker. There is **no button for this yet** — the
   backend exposes it as a REST action keyed to the session's `deviceId`, so run
   this once in that same logged-in tab's devtools console:

   ```js
   await fetch("/api/speaker", {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({ action: "remember" }),
   });
   ```

   That sets `isPreferredSpeaker` in the backend's device registry (persisted to
   `device-registry.json`). `{ "action": "forget" }` clears it again.

4. Grant the subdomain **autoplay permission** in the browser (site settings →
   Sound / Autoplay → Allow), or simply leave the tab open and interacted-with
   after that first click.

Thereafter, whenever the speaker PC's browser reconnects with no Player active,
the backend **auto-selects** it as the preferred speaker / Player and resumes the
station — no manual click needed. Keep the tab foreground/fullscreen (and enable a
Wake Lock / disable OS sleep) so the OS doesn't throttle or suspend it.

Device-memory checklist:

- [ ] Speaker PC logged in; `deviceId` persisted in `localStorage` (`ljb.deviceId`).
- [ ] `POST /api/speaker {"action":"remember"}` sent from that device
      (`isPreferredSpeaker = true`).
- [ ] Autoplay permission granted for the subdomain.
- [ ] After a full browser restart, the speaker **auto-becomes** the Player and
      audio resumes without a click.

## Manual `<audio>` playback verification

Real browser audio + autoplay behavior can't be unit-tested, so verify by hand
after each deploy (spec §11 — real playback is manual-verify):

- [ ] Log in on a Remote; queue a YouTube link → it resolves and appears in the
      queue, and the header badge shows `● <speaker> live`.
- [ ] On the Player device, audio actually plays out the OS default output (the
      hidden `<audio>` element is playing).
- [ ] **Seek** the now-playing scrubber → audio jumps (HTTP range request returns
      `206 Partial Content`).
- [ ] **Pause / Resume / Skip** from a Remote → the Player reacts immediately.
- [ ] **Volume** change from a Remote → the Player's `<audio>.volume` follows.
- [ ] Let the explicit queue drain → the radio appends a related track and audio
      continues with no stall (queue-ahead / prefetch worked).
- [ ] Close the Player tab → Remotes show `○ No speaker`, station paused; reopen
      it → a **remembered** speaker auto-resumes from the saved position (any other
      device needs another "Play on this device" click).
- [ ] `docker compose restart jukebox` → the station snapshot + remembered speaker
      survive (current track, queue, seed restored from `CACHE_DIR`).
