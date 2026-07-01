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
    expect(df).toMatch(/EXPOSE 3018/);
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
