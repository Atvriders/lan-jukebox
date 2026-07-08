import { describe, it, expect, vi } from "vitest";
import { Queue } from "./index.js";
import type { Requester, TrackMeta } from "../types/index.js";

const requester: Requester = { deviceId: "d1", displayName: "u", source: "user" };
function meta(videoId: string): TrackMeta {
  return {
    videoId,
    title: videoId,
    channel: "c",
    durationSec: 100,
    isLive: false,
    thumbnailUrl: null,
  };
}
function newQueue() {
  let n = 0;
  return new Queue({ historyMax: 2, idFactory: () => `id${++n}`, now: () => 0 });
}

describe("Queue", () => {
  it("adds to upcoming, defaults fromRadio=false + audio=null, emits changed + prefetch", async () => {
    const q = newQueue();
    const changed = vi.fn();
    const prefetch = vi.fn();
    q.on("changed", changed);
    q.on("prefetch", prefetch);
    const item = await q.add(meta("aaaaaaaaaaa"), requester);
    expect(item.id).toBe("id1");
    expect(item.fromRadio).toBe(false);
    expect(item.audio).toBeNull();
    expect(item.requester.source).toBe("user");
    expect(q.snapshot().upcoming.map((i) => i.id)).toEqual(["id1"]);
    expect(q.current).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenLastCalledWith("aaaaaaaaaaa");
  });

  it("add(meta, requester, true) tags the item fromRadio", async () => {
    const q = newQueue();
    const item = await q.add(meta("bbbbbbbbbbb"), requester, true);
    expect(item.fromRadio).toBe(true);
  });

  it("a user pick jumps AHEAD of trailing radio filler; radio picks always append", async () => {
    // Regression (bug: "a radio track plays instead of my queued song"): a USER add must
    // insert before the FIRST fromRadio item so it plays soon, not behind an endless radio
    // buffer — while keeping its order relative to earlier user picks; radio adds append.
    const q = newQueue();
    const radioReq: Requester = { deviceId: "autoplay", displayName: "radio", source: "autoplay" };
    await q.add(meta("useraaaaaa1"), requester); // user
    await q.add(meta("radiobbbbb1"), radioReq, true); // radio → append
    await q.add(meta("radiobbbbb2"), radioReq, true); // radio → append
    expect(q.snapshot().upcoming.map((i) => i.meta.videoId)).toEqual([
      "useraaaaaa1",
      "radiobbbbb1",
      "radiobbbbb2",
    ]);
    // New user pick lands AFTER the earlier user pick but BEFORE any radio filler.
    await q.add(meta("useraaaaaa2"), requester);
    expect(q.snapshot().upcoming.map((i) => i.meta.videoId)).toEqual([
      "useraaaaaa1",
      "useraaaaaa2",
      "radiobbbbb1",
      "radiobbbbb2",
    ]);
    // A radio pick still appends to the very end.
    await q.add(meta("radiobbbbb3"), radioReq, true);
    expect(q.snapshot().upcoming.map((i) => i.meta.videoId)).toEqual([
      "useraaaaaa1",
      "useraaaaaa2",
      "radiobbbbb1",
      "radiobbbbb2",
      "radiobbbbb3",
    ]);
  });

  it("advance() promotes the head and archives the old current to history", async () => {
    const q = newQueue();
    await q.add(meta("aaaaaaaaaaa"), requester);
    await q.add(meta("bbbbbbbbbbb"), requester);
    expect((await q.advance())?.meta.videoId).toBe("aaaaaaaaaaa");
    expect((await q.advance())?.meta.videoId).toBe("bbbbbbbbbbb");
    expect(q.snapshot().history.map((i) => i.meta.videoId)).toEqual(["aaaaaaaaaaa"]);
    expect(await q.advance()).toBeNull();
    expect(q.current).toBeNull();
  });

  it("discardCurrent() promotes the head WITHOUT archiving the dropped track", async () => {
    const q = newQueue();
    await q.add(meta("aaaaaaaaaaa"), requester);
    await q.add(meta("bbbbbbbbbbb"), requester);
    await q.advance(); // current = aaa
    const next = await q.discardCurrent();
    expect(next?.meta.videoId).toBe("bbbbbbbbbbb");
    expect(q.snapshot().history).toEqual([]);
  });

  it("remove() drops an upcoming item; returns false for an unknown id", async () => {
    const q = newQueue();
    const a = await q.add(meta("aaaaaaaaaaa"), requester);
    await q.add(meta("bbbbbbbbbbb"), requester);
    expect(await q.remove(a.id)).toBe(true);
    expect(q.snapshot().upcoming.map((i) => i.meta.videoId)).toEqual(["bbbbbbbbbbb"]);
    expect(await q.remove("nope")).toBe(false);
  });

  it("reorder() moves an item and clamps toIndex", async () => {
    const q = newQueue();
    const a = await q.add(meta("aaaaaaaaaaa"), requester);
    await q.add(meta("bbbbbbbbbbb"), requester);
    await q.add(meta("ccccccccccc"), requester);
    expect(await q.reorder(a.id, 99)).toBe(true);
    expect(q.snapshot().upcoming.map((i) => i.meta.videoId)).toEqual([
      "bbbbbbbbbbb",
      "ccccccccccc",
      "aaaaaaaaaaa",
    ]);
  });

  it("shuffle(rng) permutes upcoming deterministically and emits changed", async () => {
    const q = newQueue();
    await q.add(meta("aaaaaaaaaaa"), requester);
    await q.add(meta("bbbbbbbbbbb"), requester);
    const changed = vi.fn();
    q.on("changed", changed);
    await q.shuffle(() => 0); // Fisher-Yates with rng()=0 swaps i with 0
    expect(changed).toHaveBeenCalled();
    expect(q.snapshot().upcoming).toHaveLength(2);
  });

  it("requeueHistory() recycles the full played set + current and clears history", async () => {
    const q = newQueue();
    await q.add(meta("aaaaaaaaaaa"), requester);
    await q.add(meta("bbbbbbbbbbb"), requester);
    await q.advance(); // current aaa
    await q.advance(); // current bbb, history [aaa]
    const n = await q.requeueHistory();
    expect(n).toBe(2);
    expect(q.snapshot().history).toEqual([]);
    expect(q.snapshot().upcoming.map((i) => i.meta.videoId)).toEqual([
      "aaaaaaaaaaa",
      "bbbbbbbbbbb",
    ]);
    expect(q.current).toBeNull();
  });

  it("clear() drops current + upcoming but keeps display history", async () => {
    const q = newQueue();
    await q.add(meta("aaaaaaaaaaa"), requester);
    await q.advance();
    await q.add(meta("bbbbbbbbbbb"), requester);
    await q.clear();
    expect(q.current).toBeNull();
    expect(q.snapshot().upcoming).toEqual([]);
  });

  it("restoreHistory() seeds the history ring on restart, trimmed to historyMax", async () => {
    const q = newQueue(); // historyMax = 2
    const hist = (id: string) => ({
      id,
      meta: meta(id),
      requester,
      addedAt: 0,
      audio: null,
      fromRadio: false,
    });
    await q.restoreHistory([hist("aaaaaaaaaaa"), hist("bbbbbbbbbbb"), hist("ccccccccccc")]);
    // Keeps the most recent historyMax (2) entries.
    expect(q.snapshot().history.map((i) => i.meta.videoId)).toEqual(["bbbbbbbbbbb", "ccccccccccc"]);
  });

  it("setCurrentAudio() records the real audio on the current item (no-op on videoId mismatch)", async () => {
    const q = newQueue();
    await q.add(meta("aaaaaaaaaaa"), requester);
    await q.advance(); // current = aaa, audio null
    expect(q.current?.audio).toBeNull();
    const info = { codec: "opus", bitrateKbps: 160, sampleRateHz: 48000 };
    q.setCurrentAudio("aaaaaaaaaaa", info);
    expect(q.current?.audio).toEqual(info);
    // A stale videoId (already advanced past) must not clobber the current item's audio.
    q.setCurrentAudio("zzzzzzzzzzz", null);
    expect(q.current?.audio).toEqual(info);
  });
});
