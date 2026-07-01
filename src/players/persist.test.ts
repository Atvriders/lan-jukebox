import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeviceRegistryFile } from "../types/index.js";
import { DEVICE_REGISTRY_FILE, readDeviceRegistry, writeDeviceRegistry } from "./persist.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lj-persist-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sample: DeviceRegistryFile = {
  version: 1,
  savedAt: 1000,
  devices: [
    { deviceId: "d1", label: "Living Room PC", lastSeen: 900, isPreferredSpeaker: true },
    { deviceId: "d2", label: "Phone", lastSeen: 800, isPreferredSpeaker: false },
  ],
};

describe("device-registry persist", () => {
  it("writes then reads back the identical file", async () => {
    await writeDeviceRegistry(dir, sample);
    const back = await readDeviceRegistry(dir);
    expect(back).toEqual(sample);
  });

  it("writes to the documented filename", async () => {
    await writeDeviceRegistry(dir, sample);
    const raw = await readFile(join(dir, DEVICE_REGISTRY_FILE), "utf8");
    expect(JSON.parse(raw)).toEqual(sample);
  });
});

describe("device-registry concurrent write atomicity", () => {
  it("many overlapping writes all resolve (unique tmp; none rename out from under another)", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) =>
        writeDeviceRegistry(dir, {
          version: 1,
          savedAt: i,
          devices: [{ deviceId: `d${i}`, label: `L${i}`, lastSeen: i, isPreferredSpeaker: false }],
        }),
      ),
    );
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toEqual([]);
    // The final on-disk file is a complete, parseable last-writer (never truncated/absent).
    const back = await readDeviceRegistry(dir);
    expect(back?.version).toBe(1);
    expect(back?.devices).toHaveLength(1);
  });
});

describe("device-registry tolerant read", () => {
  it("returns null when the file is absent", async () => {
    expect(await readDeviceRegistry(dir)).toBeNull();
  });

  it("returns null on corrupt JSON", async () => {
    await writeFile(join(dir, DEVICE_REGISTRY_FILE), "{not json");
    expect(await readDeviceRegistry(dir)).toBeNull();
  });

  it("returns null on an unknown version", async () => {
    await writeFile(
      join(dir, DEVICE_REGISTRY_FILE),
      JSON.stringify({ version: 2, savedAt: 1, devices: [] }),
    );
    expect(await readDeviceRegistry(dir)).toBeNull();
  });
});
