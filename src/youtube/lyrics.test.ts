import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanTitle, deriveSearches, fetchLyrics } from "./lyrics.js";
import type { TrackMeta } from "../types/index.js";

afterEach(() => vi.unstubAllGlobals());

const meta = (over: Partial<TrackMeta> = {}): TrackMeta => ({
  videoId: "vvvvvvvvvvv",
  title: "Title",
  channel: "Channel",
  durationSec: 100,
  isLive: false,
  thumbnailUrl: null,
  ...over,
});

describe("cleanTitle", () => {
  it("strips (Official Video) / [HD] / lyric markers and trims", () => {
    expect(cleanTitle("Bohemian Rhapsody (Official Video)")).toBe("Bohemian Rhapsody");
    expect(cleanTitle("Some Song [HD]")).toBe("Some Song");
    expect(cleanTitle("Tune (Official Music Video) [4K] (Lyrics)")).toBe("Tune");
    expect(cleanTitle("Track (Lyric Video)")).toBe("Track");
    expect(cleanTitle("Hit feat. Someone (Audio)")).toBe("Hit feat. Someone");
  });

  it("collapses leftover whitespace and stray separators", () => {
    expect(cleanTitle("Song   -   ")).toBe("Song");
    expect(cleanTitle("  Spaced   Out  ")).toBe("Spaced Out");
  });

  it("returns empty string for empty/garbage-only input", () => {
    expect(cleanTitle("(Official Video)")).toBe("");
    expect(cleanTitle("")).toBe("");
  });
});

describe("deriveSearches", () => {
  it("yields the channel/title pair first", () => {
    const out = deriveSearches(
      meta({ channel: "Queen", title: "Bohemian Rhapsody (Official Video)" }),
    );
    expect(out[0]).toEqual({ artist: "Queen", title: "Bohemian Rhapsody" });
  });

  it("also yields an 'Artist - Title' split from the title", () => {
    const out = deriveSearches(
      meta({ channel: "VEVO", title: "Adele - Hello (Official Music Video)" }),
    );
    expect(out).toContainEqual({ artist: "Adele", title: "Hello" });
  });

  it("strips a trailing ' - Topic' from auto-generated channels", () => {
    const out = deriveSearches(meta({ channel: "Queen - Topic", title: "Bohemian Rhapsody" }));
    expect(out[0]).toEqual({ artist: "Queen", title: "Bohemian Rhapsody" });
  });

  it("does not produce candidates with empty artist or title", () => {
    const out = deriveSearches(meta({ channel: "", title: "(Official Video)" }));
    expect(out.every((c) => c.artist.length > 0 && c.title.length > 0)).toBe(true);
  });
});

describe("fetchLyrics", () => {
  it("hits lyrics.ovh with URL-encoded artist/title and returns the lyrics", async () => {
    const fn = vi.fn(async () => ({ ok: true, json: async () => ({ lyrics: "la la la" }) }));
    vi.stubGlobal("fetch", fn);
    const res = await fetchLyrics(
      meta({ channel: "Daft Punk", title: "One More Time (Official Video)" }),
    );
    expect(res.lyrics).toBe("la la la");
    expect(res.source).toBe("lyrics.ovh");
    const url = String((fn.mock.calls[0] as unknown[])[0]);
    expect(url).toBe("https://api.lyrics.ovh/v1/Daft%20Punk/One%20More%20Time");
  });

  it("falls through to the 'Artist - Title' split when the channel candidate misses", async () => {
    const fn = vi.fn();
    // First candidate (channel "VEVO") misses; the split candidate (Adele/Hello) hits.
    fn.mockResolvedValueOnce({ ok: true, json: async () => ({ lyrics: null }) });
    fn.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ lyrics: "Hello from the other side" }),
    });
    vi.stubGlobal("fetch", fn);
    const res = await fetchLyrics(meta({ channel: "VEVO", title: "Adele - Hello" }));
    expect(res.lyrics).toBe("Hello from the other side");
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("returns null lyrics when every candidate misses (404)", async () => {
    const fn = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: "no" }) }));
    vi.stubGlobal("fetch", fn);
    const res = await fetchLyrics(meta({ channel: "Nobody", title: "Unknown" }));
    expect(res.lyrics).toBeNull();
  });

  it("never throws on a network error — returns null lyrics (best-effort)", async () => {
    const fn = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fn);
    const res = await fetchLyrics(meta());
    expect(res.lyrics).toBeNull();
  });
});
