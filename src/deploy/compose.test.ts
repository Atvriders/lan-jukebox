import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const yml = readFileSync(resolve(repoRoot, "docker-compose.yml"), "utf8");
const config = readFileSync(resolve(repoRoot, "src", "config.ts"), "utf8");

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

  it("publishes a HOST_PORT-overridable host port reachable on the LAN + by the user's own ingress", () => {
    // the jukebox service publishes ${HOST_PORT:-3018}:3018 (all interfaces) so the LAN
    // IP and a separate reverse proxy / Cloudflare Tunnel can both reach it
    expect(yml).toMatch(/ports:\s*\[\s*"\$\{HOST_PORT:-3018\}:3018"\s*\]/);
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

  it("sets a mem_limit so parallel yt-dlp/ffmpeg jobs can't OOM-kill the host", () => {
    // Regression guard: the discord-yt-music-bot was OOM-killed mid-song on a small VPS
    // with no memory ceiling; the LAN Jukebox compose must ship one (it runs a MORE
    // aggressive PREFETCH_DEPTH x MAX_TRANSCODE_JOBS by default).
    expect(yml).toMatch(/mem_limit:\s*\S+/);
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

  it("ships only CHANGE_ME secret placeholders (no real tokens) with a >= 32-char SESSION_SECRET", () => {
    // Secret-hygiene invariant: the committed compose must carry placeholders, never
    // a real filled-in credential. A future edit that pastes a real value must fail CI.
    const viewer = yml.match(/VIEWER_PASSWORD:\s*"([^"]*)"/)?.[1];
    const secret = yml.match(/SESSION_SECRET:\s*"([^"]*)"/)?.[1];
    expect(viewer).toBeTruthy();
    expect(secret).toBeTruthy();
    // both must still be CHANGE_ME placeholders, not real credentials
    expect(viewer).toMatch(/CHANGE_ME/);
    expect(secret).toMatch(/CHANGE_ME/);
    // SESSION_SECRET placeholder must be at least 32 chars (server refuses to start otherwise)
    expect((secret as string).length).toBeGreaterThanOrEqual(32);
  });

  it("sets every tunable env var under the name src/config.ts actually reads", () => {
    // Guard against env-name drift: each app-tunable key in the compose env block must be
    // a name the sole env reader (src/config.ts) reads, so operator-set values aren't
    // silently ignored. These are the drift-prone knobs surfaced by /debug.
    expect(yml).toMatch(/MAX_TRANSCODE_JOBS:/);
    expect(yml).not.toMatch(/MAX_CONCURRENT_DOWNLOADS:/);
    expect(config).toMatch(/"MAX_TRANSCODE_JOBS"/);

    expect(yml).toMatch(/YT_COOKIES:/);
    expect(yml).not.toMatch(/YT_COOKIES_FILE:/);
    expect(config).toMatch(/"YT_COOKIES"/);

    // inline pasted-cookies content is a first-class env, read by config.ts
    expect(yml).toMatch(/YT_COOKIES_TEXT:/);
    expect(config).toMatch(/"YT_COOKIES_TEXT"/);
  });
});
