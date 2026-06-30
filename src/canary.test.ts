import { describe, it, expect, vi } from "vitest";
import { startupCanary } from "./canary.js";
import { createLogger } from "./util/logger.js";

describe("startupCanary", () => {
  const log = createLogger("silent");

  it("returns true when resolve() succeeds on the known-good video", async () => {
    const resolve = vi.fn().mockResolvedValue({
      videoId: "jNQXAC9IVRw",
      title: "Me at the zoo",
      channel: "jawed",
      durationSec: 19,
      isLive: false,
      thumbnailUrl: null,
    });
    await expect(startupCanary({ resolve }, log)).resolves.toBe(true);
    expect(resolve).toHaveBeenCalledWith("jNQXAC9IVRw");
  });

  it("returns false (never throws) when resolve() rejects", async () => {
    const resolve = vi.fn().mockRejectedValue(new Error("ip blocked"));
    await expect(startupCanary({ resolve }, log)).resolves.toBe(false);
  });
});
