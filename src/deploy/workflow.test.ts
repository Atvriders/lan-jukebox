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
