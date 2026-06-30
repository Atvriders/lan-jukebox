import { describe, it, expect } from "vitest";
import { Mutex } from "./mutex.js";

describe("Mutex", () => {
  it("serializes overlapping critical sections", async () => {
    const m = new Mutex();
    const log: string[] = [];
    async function section(tag: string) {
      await m.runExclusive(async () => {
        log.push(`${tag}-start`);
        await new Promise((r) => setTimeout(r, 5));
        log.push(`${tag}-end`);
      });
    }
    await Promise.all([section("a"), section("b")]);
    // No interleaving: each start is immediately followed by its own end.
    expect(log).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("returns the callback result and continues after a throw", async () => {
    const m = new Mutex();
    await expect(
      m.runExclusive(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(m.runExclusive(() => 42)).resolves.toBe(42);
  });
});
