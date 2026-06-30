import { describe, it, expect } from "vitest";
import { MemorySessionStore } from "./session-store.js";

function p<T>(fn: (cb: (e: unknown, r?: T) => void) => void): Promise<T | undefined> {
  return new Promise((res, rej) => fn((e, r) => (e ? rej(e) : res(r))));
}

describe("MemorySessionStore", () => {
  it("round-trips set → get and destroy removes", async () => {
    const s = new MemorySessionStore();
    await p((cb) => s.set("sid1", { userId: "u1" } as never, cb));
    const got = await p<{ userId: string }>((cb) => s.get("sid1", cb as never));
    expect(got).toEqual({ userId: "u1" });
    await p((cb) => s.destroy("sid1", cb));
    const after = await p((cb) => s.get("sid1", cb as never));
    // Strict null (not `?? null`): the store must call cb(null, null) per the @fastify/session
    // contract for a missing entry. A regression returning undefined would be caught here.
    expect(after).toBeNull();
    s.close();
  });

  it("expires an entry past its TTL on get (and removes it)", async () => {
    let t = 1000;
    const s = new MemorySessionStore({ ttlMs: 100, sweepMs: 0, now: () => t });
    await p((cb) => s.set("sid1", { userId: "u1" } as never, cb));
    expect(s.size).toBe(1);
    t = 1101; // past expiresAt (1000 + 100)
    const got = await p((cb) => s.get("sid1", cb as never));
    // Strict null: an expired entry must yield cb(null, null), not undefined.
    expect(got).toBeNull();
    expect(s.size).toBe(0); // get() deletes the expired entry
    s.close();
  });

  it("refreshes expiry on set (rolling sessions)", async () => {
    let t = 1000;
    const s = new MemorySessionStore({ ttlMs: 100, sweepMs: 0, now: () => t });
    await p((cb) => s.set("sid1", { userId: "u1" } as never, cb));
    t = 1050;
    await p((cb) => s.set("sid1", { userId: "u1" } as never, cb)); // re-set -> expiresAt = 1150
    t = 1120; // would be expired under the first set, but not the refreshed one
    const got = await p<{ userId: string }>((cb) => s.get("sid1", cb as never));
    expect(got).toEqual({ userId: "u1" });
    s.close();
  });

  it("sweep() evicts expired entries without a read", () => {
    let t = 1000;
    const s = new MemorySessionStore({ ttlMs: 100, sweepMs: 0, now: () => t });
    s.set("a", {}, () => {});
    s.set("b", {}, () => {});
    expect(s.size).toBe(2);
    t = 2000;
    s.sweep();
    expect(s.size).toBe(0);
    s.close();
  });
});
