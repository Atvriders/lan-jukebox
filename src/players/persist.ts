import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeviceRegistryFile } from "../types/index.js";

export const DEVICE_REGISTRY_FILE = "device-registry.json";

/** Atomic write: stage to a UNIQUE tmp sibling, then rename over the target.
 * The tmp name is per-write (pid + random) so concurrent writers never share a
 * staging file — a fixed `${target}.tmp` would be renamed out from under other
 * writers, making their rename() reject with ENOENT and dropping the write. */
export async function writeDeviceRegistry(dir: string, file: DeviceRegistryFile): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = join(dir, DEVICE_REGISTRY_FILE);
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(file));
  await rename(tmp, target); // atomic swap
}

export async function readDeviceRegistry(dir: string): Promise<DeviceRegistryFile | null> {
  try {
    const raw = await readFile(join(dir, DEVICE_REGISTRY_FILE), "utf8");
    const parsed = JSON.parse(raw) as DeviceRegistryFile;
    if (parsed.version === 1 && Array.isArray(parsed.devices)) return parsed;
    return null;
  } catch {
    return null;
  }
}
