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
