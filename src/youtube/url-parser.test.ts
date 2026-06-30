import { describe, it, expect } from "vitest";
import { parseInput } from "./url-parser.js";

const ID = "dQw4w9WgXcQ";

describe("parseInput — video URLs", () => {
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=42s`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abc`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube.com/v/${ID}`, // legacy /v/ embed path (PATH_PREFIXES "v")
    `https://www.youtube.com/watch?v=${ID}&list=PLxxxxxxxx`, // playlist param ignored
  ])("extracts the video id from %s", (url) => {
    expect(parseInput(url)).toEqual({ kind: "video", videoId: ID });
  });
});

describe("parseInput — rejections", () => {
  it("rejects a bare playlist URL with no video", () => {
    const r = parseInput("https://www.youtube.com/playlist?list=PLxxxx");
    expect(r.kind).toBe("reject");
  });
  it("rejects a non-YouTube URL", () => {
    const r = parseInput("https://vimeo.com/12345");
    expect(r).toEqual({ kind: "reject", reason: expect.stringContaining("YouTube") });
  });
  it("rejects an empty string", () => {
    expect(parseInput("   ").kind).toBe("reject");
  });

  // youtu.be reject branch (url-parser.ts:36-40): the `?? ""` fallback + VIDEO_ID guard.
  it.each([
    "https://youtu.be/", // empty path → id="" via the ?? "" fallback
    "https://youtu.be/tooshort", // 8 chars
    "https://youtu.be/TooLongXXXXX", // 12 chars
    "https://youtu.be/invalid!chars", // invalid character
  ])("rejects a youtu.be link with an invalid/missing id: %s", (url) => {
    expect(parseInput(url)).toEqual({ kind: "reject", reason: "invalid youtu.be video id" });
  });

  // Path-prefix routes (/shorts/, /embed/, /live/, /v/) with a malformed or missing
  // candidate id fall through to the playlist-then-generic-reject chain (url-parser.ts:47-57).
  it.each([
    "https://www.youtube.com/shorts/notvalidXX", // bad chars
    "https://www.youtube.com/embed/tooshort", // wrong length
    "https://www.youtube.com/live/", // missing candidate (no segs[1])
    "https://www.youtube.com/v/!!!", // invalid id
  ])("rejects a path-prefix route with an invalid/missing id: %s", (url) => {
    expect(parseInput(url).kind).toBe("reject");
  });

  // `?v=` with an invalid id and no list param → the line-57 generic reject branch.
  it("rejects a watch URL whose v param is not a valid 11-char id (no list)", () => {
    expect(parseInput("https://www.youtube.com/watch?v=tooshort")).toEqual({
      kind: "reject",
      reason: expect.stringContaining("video id"),
    });
  });
  it("rejects a watch URL whose 11-char v param contains an invalid character", () => {
    expect(parseInput("https://www.youtube.com/watch?v=dQw4w9WgX!Q").kind).toBe("reject");
  });
});

describe("parseInput — queries", () => {
  it("treats plain text as a search query", () => {
    expect(parseInput("daft punk one more time")).toEqual({
      kind: "query",
      query: "daft punk one more time",
    });
  });
  it("trims surrounding whitespace on a query", () => {
    expect(parseInput("  lofi beats  ")).toEqual({ kind: "query", query: "lofi beats" });
  });

  // Protocol-less "word.tld/path" strings are legitimate search terms, not URLs. The
  // heuristic must not misroute them to the reject branch.
  it.each(["fly.me/to/the/moon", "boards.of.canada/roygbiv", "death.grips/get.got"])(
    "treats scheme-less dotted text %s as a search query, not a rejected non-YouTube URL",
    (q) => {
      expect(parseInput(q)).toEqual({ kind: "query", query: q });
    },
  );

  it("still rejects an explicit-scheme non-YouTube URL", () => {
    // A real http(s):// URL pointing at a non-YouTube host must keep rejecting.
    expect(parseInput("https://vimeo.com/12345").kind).toBe("reject");
  });
});
