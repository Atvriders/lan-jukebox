import { describe, it, expect } from "vitest";
import { classifyYtdlpError, isRetryableAcrossClients, YtError, YtErrorKind } from "./errors.js";

describe("classifyYtdlpError", () => {
  it.each<[string, YtErrorKind]>([
    [
      "ERROR: [youtube] xx: Private video. Sign in if you've been granted access",
      YtErrorKind.Private,
    ],
    [
      "ERROR: Sign in to confirm your age. This video may be inappropriate",
      YtErrorKind.AgeRestricted,
    ],
    [
      "ERROR: [youtube] xx: Video unavailable. This video has been removed",
      YtErrorKind.Unavailable,
    ],
    ["ERROR: Join this channel to get access to members-only content", YtErrorKind.MembersOnly],
    [
      "ERROR: The uploader has not made this video available in your country",
      YtErrorKind.GeoBlocked,
    ],
    [
      "ERROR: Sign in to confirm you're not a bot. Your IP is likely being blocked",
      YtErrorKind.IpBlocked,
    ],
    [
      "WARNING: Some web client https formats require a GVS PO Token which was not provided",
      YtErrorKind.PoTokenSabr,
    ],
    ["ERROR: Only images are available for download", YtErrorKind.PoTokenSabr],
    [
      "ERROR: This content isn't available, rate-limited by YouTube for up to an hour",
      YtErrorKind.RateLimited,
    ],
    // yt-dlp's plain HTTP-level rate limit (429) must classify as RateLimited too, not Unknown.
    [
      "ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests",
      YtErrorKind.RateLimited,
    ],
    ["ERROR: Too many requests, please try again later", YtErrorKind.RateLimited],
  ])("classifies %s", (stderr, kind) => {
    expect(classifyYtdlpError(stderr, 1).kind).toBe(kind);
  });

  it("prioritizes IP-block over a generic private hint", () => {
    const stderr =
      "Private video. Sign in to confirm you're not a bot. Your IP is likely being blocked";
    expect(classifyYtdlpError(stderr, 1).kind).toBe(YtErrorKind.IpBlocked);
  });

  it("falls back to Unknown and keeps the raw stderr in the message", () => {
    const e = classifyYtdlpError("ERROR: something totally new", 1);
    expect(e.kind).toBe(YtErrorKind.Unknown);
    expect(e.message).toContain("something totally new");
  });
});

describe("isRetryableAcrossClients", () => {
  it.each([
    YtErrorKind.Private,
    YtErrorKind.Unavailable,
    YtErrorKind.MembersOnly,
    YtErrorKind.GeoBlocked,
    YtErrorKind.Live,
    YtErrorKind.TooLong,
  ])("treats %s as terminal (no client swap helps)", (kind) => {
    expect(isRetryableAcrossClients(new YtError(kind, "x"))).toBe(false);
  });

  it.each([
    YtErrorKind.PoTokenSabr,
    YtErrorKind.IpBlocked,
    YtErrorKind.RateLimited,
    YtErrorKind.Timeout,
    YtErrorKind.Unknown,
    YtErrorKind.AgeRestricted, // several clients bypass age-gates the default client trips on
  ])("treats %s as retryable on another client", (kind) => {
    expect(isRetryableAcrossClients(new YtError(kind, "x"))).toBe(true);
  });

  it("retries on a non-YtError (transport / spawn failure)", () => {
    expect(isRetryableAcrossClients(new Error("spawn ENOENT"))).toBe(true);
  });
});
