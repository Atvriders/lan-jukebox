import { describe, it, expect } from "vitest";
import { applySettingsPatch } from "./settings.js";
import { DEFAULT_SETTINGS, VOLUME_MAX, MAX_TRACK_DURATION_CEILING_SEC } from "../types/index.js";
import type { StationSettings } from "../types/index.js";

const base: StationSettings = { ...DEFAULT_SETTINGS };

describe("applySettingsPatch", () => {
  it("returns base unchanged for a null/empty patch", () => {
    expect(applySettingsPatch(base, null)).toEqual(base);
    expect(applySettingsPatch(base, {})).toEqual(base);
  });

  it("accepts valid repeat / autoplaySource enums and rejects bad ones", () => {
    expect(applySettingsPatch(base, { repeat: "all" }).repeat).toBe("all");
    expect(applySettingsPatch(base, { repeat: "bogus" }).repeat).toBe(base.repeat);
    expect(applySettingsPatch(base, { autoplaySource: "artist" }).autoplaySource).toBe("artist");
    expect(applySettingsPatch(base, { autoplaySource: "x" }).autoplaySource).toBe(
      base.autoplaySource,
    );
  });

  it("clamps + rounds volume to 0..VOLUME_MAX and rejects booleans", () => {
    expect(applySettingsPatch(base, { volume: 150 }).volume).toBe(150);
    expect(applySettingsPatch(base, { volume: 999 }).volume).toBe(VOLUME_MAX);
    expect(applySettingsPatch(base, { volume: -5 }).volume).toBe(0);
    expect(applySettingsPatch(base, { volume: 80.6 }).volume).toBe(81);
    expect(applySettingsPatch(base, { volume: true }).volume).toBe(base.volume);
  });

  it("clamps maxTrackDurationSec to 0..ceiling and treats 0 as no-limit", () => {
    expect(applySettingsPatch(base, { maxTrackDurationSec: 600 }).maxTrackDurationSec).toBe(600);
    expect(applySettingsPatch(base, { maxTrackDurationSec: 0 }).maxTrackDurationSec).toBe(0);
    expect(
      applySettingsPatch(base, { maxTrackDurationSec: MAX_TRACK_DURATION_CEILING_SEC + 100 })
        .maxTrackDurationSec,
    ).toBe(MAX_TRACK_DURATION_CEILING_SEC);
  });

  it("accepts a boolean autoplay and rejects a non-boolean", () => {
    expect(applySettingsPatch(base, { autoplay: false }).autoplay).toBe(false);
    expect(applySettingsPatch(base, { autoplay: "yes" }).autoplay).toBe(base.autoplay);
  });

  it("ignores removed fields (idle/crossfade/fx/commandChannel)", () => {
    const out = applySettingsPatch(base, {
      idleTimeoutSec: 99,
      crossfadeSec: 5,
      fx: "bassboost",
      commandChannelId: "c",
    } as Partial<Record<keyof StationSettings, unknown>>);
    expect(out).toEqual(base);
    expect(Object.keys(out).sort()).toEqual([
      "autoplay",
      "autoplaySource",
      "maxTrackDurationSec",
      "repeat",
      "volume",
    ]);
  });
});
