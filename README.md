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

`src/config.ts` is the only env reader. All variables are set inline in
`docker-compose.yml`. Defaults below are the values `src/config.ts` falls back to.

| Variable                 | Required | Default                      | Notes                                                                                                                                                     |
| ------------------------ | -------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                   | no       | `3018`                       | Internal container listen port.                                                                                                                           |
| `HOST_PORT`              | no       | `3018`                       | Host port your own ingress connects to (published on `127.0.0.1`, in `docker-compose.yml`).                                                               |
| `HOST`                   | no       | `0.0.0.0`                    | Bind address inside the container.                                                                                                                        |
| `PUBLIC_BASE_URL`        | yes      | —                            | The public `https://` subdomain (e.g. `https://jukebox.example.com`). Trailing slash is stripped.                                                         |
| `ALLOWED_WS_ORIGINS`     | no\*     | = `PUBLIC_BASE_URL`          | **MUST equal `PUBLIC_BASE_URL` exactly** (see WebSocket gotcha). Defaults to `PUBLIC_BASE_URL`; only override for extra origins.                          |
| `VIEWER_PASSWORD`        | yes\*\*  | —                            | Single shared password; anyone authenticated controls everything. There is no separate admin/second password.                                             |
| `ALLOW_NO_PASSWORD`      | no       | `false`                      | Set `true` to run with no viewer password (LAN-only escape hatch). Server refuses to start with no password unless this is `true`.                        |
| `SESSION_SECRET`         | yes      | —                            | Cookie-signing secret, **>= 32 chars** (server refuses to start otherwise).                                                                               |
| `CACHE_DIR`              | no       | `/data/cache`                | Holds the audio LRU **and** the station snapshot + device registry JSON. Mount a volume here.                                                             |
| `CACHE_MAX_MB`           | no       | `2048`                       | LRU audio cache size cap (MiB).                                                                                                                           |
| `HISTORY_MAX_ITEMS`      | no       | `100`                        | Recently-played history length.                                                                                                                           |
| `SEARCH_RESULT_COUNT`    | no       | `5`                          | Search-candidate count.                                                                                                                                   |
| `PREFETCH_DEPTH`         | no       | `1`                          | Radio queue-ahead depth.                                                                                                                                  |
| `MAX_TRANSCODE_JOBS`     | no       | `2`                          | Parallel yt-dlp download/transcode cap (>= 1).                                                                                                            |
| `MAX_TRACK_DURATION_SEC` | no       | — (`0`/empty = no cap)       | Reject tracks longer than this many seconds; `0`, empty, or unset means no ceiling.                                                                       |
| `RADIO_MAX_AUTOPLAY_SEC` | no       | `900` (15 min); `0` = no cap | Radio **auto-discovery** skips candidates longer than this many seconds; `0` = no cap. **User-requested tracks are never capped.**                        |
| `YTDLP_TIMEOUT_MS`       | no       | `60000`                      | Per-invocation yt-dlp timeout (ms).                                                                                                                       |
| `YT_PROXY`               | no       | —                            | Optional residential/SOCKS proxy for yt-dlp.                                                                                                              |
| `YT_COOKIES`             | no       | —                            | Optional mounted `cookies.txt` path for flagged IPs (takes precedence over `YT_COOKIES_TEXT`).                                                            |
| `YT_COOKIES_TEXT`        | no       | —                            | Paste cookies inline (a browser `Cookie:` header or a full `cookies.txt`); written to `<cache>/yt-cookies.txt` at startup.                                |
| `YT_SPONSORBLOCK`        | no       | music-focused CSV            | SponsorBlock categories yt-dlp removes from downloaded audio. Unset = `music_offtopic,intro,outro,sponsor,selfpromo,preview,interaction`; `off` disables. |
| `YT_PLAYER_CLIENTS`      | no       | `android_vr,web_embedded,tv` | Zero-PO-token client ladder. **Never** use `web,mweb` unless you run the bgutil PO-token sidecar.                                                         |
| `PO_TOKEN_PROVIDER_URL`  | no       | —                            | Only set (e.g. `http://bgutil-pot:4416`) when you run the optional bgutil PO-token provider (`--profile pot`).                                            |
| `LOG_LEVEL`              | no       | `info`                       | pino level (`trace`..`fatal`).                                                                                                                            |
| `NODE_ENV`               | no       | `development`                | Set `production` in deploy — enables `Secure` session cookies.                                                                                            |

> \* `ALLOWED_WS_ORIGINS` is optional only because it **defaults to
> `PUBLIC_BASE_URL`**. If you set it, it must still equal `PUBLIC_BASE_URL`.
> \*\* `VIEWER_PASSWORD` is required unless `ALLOW_NO_PASSWORD=true`.
>
> There are intentionally **no idle-timeout settings** — the station never stops.

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
  → Network → WS shows status `101 Switching Protocols`; the UI flips to
  "📻 Station is live"). A `403 bad_origin` / immediately-closed socket means the
  origins don't match.

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

## Resource limits (avoiding OOM-kills)

The station fans out `yt-dlp` + `ffmpeg` jobs driven by `PREFETCH_DEPTH` (radio
queue-ahead) and `MAX_TRANSCODE_JOBS` (parallel download/transcode). On a small,
always-on host that burst can be OOM-killed mid-song (the container restarts and
resumes, but the music cuts out). `docker-compose.yml` ships a `mem_limit: 1g`
ceiling for this reason — ample for audio-only work. If you still get OOM-killed
(`docker inspect <c> --format '{{.State.OOMKilled}}'`), **lower `PREFETCH_DEPTH`
and/or `MAX_TRANSCODE_JOBS`** and/or raise `mem_limit`.

## Speaker PC: one-time autoplay grant + device memory

Browsers block audio autoplay until the site is granted permission or the user
interacts. For the always-on speaker PC, do this **once**:

1. Open `PUBLIC_BASE_URL` in the speaker PC's browser and log in (shared password
   - a display name). A persistent **`deviceId`** device token is stored in
     `localStorage` (key `ljb.deviceId`) — this is how the backend recognizes the
     device on every reconnect.
2. Click **"Play on this device"** to make it the Player, then **"Remember this
   device as the speaker"** — this sets `isPreferredSpeaker` in the backend's
   device registry.
3. Grant the subdomain **autoplay permission** in the browser (site settings →
   Sound / Autoplay → Allow), or simply leave the tab open and interacted-with
   after that first click.

Thereafter, whenever the speaker PC's browser reconnects with no Player active,
the backend **auto-selects** it as the preferred speaker / Player and resumes the
station — no manual click needed. Keep the tab foreground/fullscreen (and enable a
Wake Lock / disable OS sleep) so the OS doesn't throttle or suspend it.

Device-memory checklist:

- [ ] Speaker PC logged in; `deviceId` persisted in `localStorage` (`ljb.deviceId`).
- [ ] "Remember this device as the speaker" enabled (`isPreferredSpeaker = true`).
- [ ] Autoplay permission granted for the subdomain.
- [ ] After a full browser restart, the speaker **auto-becomes** the Player and
      audio resumes without a click.

## Manual `<audio>` playback verification

Real browser audio + autoplay behavior can't be unit-tested, so verify by hand
after each deploy (spec §11 — real playback is manual-verify):

- [ ] Log in on a Remote; queue a YouTube link → it resolves and appears in the
      queue (`📻 Station is live`).
- [ ] On the Player device, audio actually plays out the OS default output (the
      hidden `<audio>` element is playing).
- [ ] **Seek** the now-playing scrubber → audio jumps (HTTP range request returns
      `206 Partial Content`).
- [ ] **Pause / Resume / Skip** from a Remote → the Player reacts immediately.
- [ ] **Volume** change from a Remote → the Player's `<audio>.volume` follows.
- [ ] Let the explicit queue drain → the radio appends a related track and audio
      continues with no stall (queue-ahead / prefetch worked).
- [ ] Close the Player tab → Remotes show "No speaker connected", station paused;
      reopen it → it auto-resumes from the saved position.
- [ ] `docker compose restart jukebox` → the station snapshot + remembered speaker
      survive (current track, queue, seed restored from `CACHE_DIR`).
