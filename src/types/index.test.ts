import { describe, it, expect } from "vitest";
import {
  AUTOPLAY_REQUESTER,
  DEFAULT_SETTINGS,
  VOLUME_MAX,
  MAX_TRACK_DURATION_CEILING_SEC,
} from "./index.js";
import type {
  TrackMeta,
  QueueItem,
  StationSnapshot,
  StationSnapshotFile,
  DeviceRegistryFile,
  ControlRequest,
  ServerPlayerMessage,
  AppConfig,
} from "./index.js";

describe("shared types backbone — runtime constants", () => {
  it("AUTOPLAY_REQUESTER is the synthetic autoplay attribution", () => {
    expect(AUTOPLAY_REQUESTER).toEqual({
      deviceId: "autoplay",
      displayName: "Autoplay",
      source: "autoplay",
    });
  });

  it("DEFAULT_SETTINGS is the jukebox default (autoplay on, radio, vol 100, no dur cap)", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      repeat: "off",
      autoplay: true,
      autoplaySource: "radio",
      volume: 100,
      maxTrackDurationSec: 0,
    });
  });

  it("exposes the volume + duration ceilings", () => {
    expect(VOLUME_MAX).toBe(200);
    expect(MAX_TRACK_DURATION_CEILING_SEC).toBe(21600);
  });
});

describe("shared types backbone — structural type usage compiles", () => {
  it("QueueItem carries fromRadio + null-until-downloaded audio", () => {
    const item: QueueItem = {
      id: "uuid-1",
      meta: {
        videoId: "abcdefghijk",
        title: "T",
        channel: "C",
        durationSec: 100,
        isLive: false,
        thumbnailUrl: null,
      },
      requester: AUTOPLAY_REQUESTER,
      addedAt: 0,
      audio: null,
      fromRadio: true,
    };
    expect(item.fromRadio).toBe(true);
    expect(item.audio).toBeNull();
  });

  it("ControlRequest.value accepts the discriminated value shapes", () => {
    const reorder: ControlRequest = {
      action: "reorder",
      value: { itemId: "x", toIndex: 2 },
    };
    expect(reorder.action).toBe("reorder");
  });

  it("ServerPlayerMessage load carries audioUrl + startMs", () => {
    const msg: ServerPlayerMessage = { type: "load", audioUrl: "/audio/x", startMs: 0 };
    expect(msg.type).toBe("load");
  });

  it("the persisted file shapes are version 1", () => {
    const snap: StationSnapshotFile = {
      version: 1,
      savedAt: 0,
      seed: null,
      current: null,
      positionMs: 0,
      queue: [],
      upcomingRadio: [],
      history: [],
      settings: DEFAULT_SETTINGS,
      activePlayerDeviceId: null,
    };
    const reg: DeviceRegistryFile = { version: 1, savedAt: 0, devices: [] };
    expect(snap.version).toBe(1);
    expect(reg.version).toBe(1);
  });

  it("AppConfig + StationSnapshot are referenceable as types", () => {
    const t = (_c: AppConfig, _s: StationSnapshot, _m: TrackMeta) => true;
    expect(typeof t).toBe("function");
  });
});
