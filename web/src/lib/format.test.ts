import { describe, it, expect } from "vitest";
import { fmtTime, fmtAudio } from "./format.js";

describe("fmtTime", () => {
  it("renders mm:ss under an hour", () => expect(fmtTime(125)).toBe("2:05"));
  it("adds an hours segment at/over an hour", () => expect(fmtTime(3600)).toBe("1:00:00"));
  it("returns the em-dash placeholder for null/non-finite", () => {
    expect(fmtTime(null)).toBe("—:—");
    expect(fmtTime(Number.NaN)).toBe("—:—");
  });
});

describe("fmtAudio", () => {
  it("joins codec · kbps · kHz, stripping trailing-zero kHz", () => {
    expect(fmtAudio({ codec: "opus", bitrateKbps: 160, sampleRateHz: 48000 })).toBe(
      "opus · 160 kbps · 48 kHz",
    );
    expect(fmtAudio({ codec: "aac", bitrateKbps: 0, sampleRateHz: 44100 })).toBe("aac · 44.1 kHz");
  });
  it("returns null when given null", () => expect(fmtAudio(null)).toBeNull());
});
