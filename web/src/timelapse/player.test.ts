import { describe, expect, it } from "vitest";
import { baseRate, createPlayer, type FrameScheduler } from "./player";

/** A scheduler the test steps by hand, and a clock it sets. */
function harness() {
  let nextHandle = 1;
  const pending = new Map<number, () => void>();
  let time = 0;
  const scheduler: FrameScheduler = {
    request(callback) {
      pending.set(nextHandle, callback);
      return nextHandle++;
    },
    cancel(handle) {
      pending.delete(handle);
    },
  };
  return {
    scheduler,
    now: () => time,
    pending,
    /** Advance the clock and run the frame that was scheduled. */
    step(ms: number) {
      time += ms;
      const [handle, callback] = [...pending.entries()][0] ?? [];
      if (handle === undefined) return false;
      pending.delete(handle);
      callback!();
      return true;
    },
  };
}

describe("createPlayer", () => {
  it("advances by elapsed time at the chosen speed and stops itself at the end", () => {
    const h = harness();
    const frames: number[] = [];
    const states: boolean[] = [];
    const player = createPlayer({ length: 100, rate: 100, onFrame: (p) => frames.push(p), onState: (s) => states.push(s), scheduler: h.scheduler, now: h.now });
    expect(h.pending.size).toBe(0);
    player.play();
    expect(player.playing).toBe(true);
    h.step(50);
    h.step(50);
    expect(frames).toEqual([5, 10]);
    player.setSpeed(4);
    h.step(100);
    expect(frames.at(-1)).toBe(50);
    h.step(100);
    h.step(100);
    expect(frames.at(-1)).toBe(100);
    expect(player.playing).toBe(false);
    expect(states).toEqual([true, false]);
    expect(h.pending.size).toBe(0);
    // Play at the end starts over.
    player.play();
    expect(frames.at(-1)).toBe(0);
    expect(player.playing).toBe(true);
    player.dispose();
  });

  it("holds exactly one frame request while playing and none while paused", () => {
    const h = harness();
    const player = createPlayer({ length: 1000, rate: 10, onFrame: () => undefined, scheduler: h.scheduler, now: h.now });
    player.play();
    player.play();
    expect(h.pending.size).toBe(1);
    h.step(16);
    expect(h.pending.size).toBe(1);
    player.pause();
    expect(h.pending.size).toBe(0);
    player.seek(500);
    expect(player.position).toBe(500);
    expect(h.pending.size).toBe(0);
    player.toggle();
    expect(h.pending.size).toBe(1);
    player.dispose();
  });

  it("dispose stops the timer for good", () => {
    const h = harness();
    const frames: number[] = [];
    const player = createPlayer({ length: 1000, rate: 10, onFrame: (p) => frames.push(p), scheduler: h.scheduler, now: h.now });
    player.play();
    h.step(100);
    const seen = frames.length;
    player.dispose();
    expect(h.pending.size).toBe(0);
    expect(h.step(100)).toBe(false);
    player.play();
    player.seek(3);
    player.toggle();
    expect(h.pending.size).toBe(0);
    expect(frames).toHaveLength(seen);
    expect(player.playing).toBe(false);
  });

  it("does not leap through the log after the tab was asleep", () => {
    const h = harness();
    const frames: number[] = [];
    const player = createPlayer({ length: 100000, rate: 100, onFrame: (p) => frames.push(p), scheduler: h.scheduler, now: h.now });
    player.play();
    h.step(60_000);
    expect(frames).toEqual([10]);
    player.dispose();
  });

  it("clamps seeks and never plays an empty log", () => {
    const h = harness();
    const player = createPlayer({ length: 10, rate: 1, onFrame: () => undefined, scheduler: h.scheduler, now: h.now });
    player.seek(-4);
    expect(player.position).toBe(0);
    player.seek(99);
    expect(player.position).toBe(10);
    player.seek(Number.NaN);
    expect(player.position).toBe(0);
    const empty = createPlayer({ length: 0, rate: 1, onFrame: () => undefined, scheduler: h.scheduler, now: h.now });
    empty.play();
    expect(empty.playing).toBe(false);
    expect(h.pending.size).toBe(0);
  });
});

describe("baseRate", () => {
  it("plays any log in about a minute and a half at 1×, and a short one at a watchable pace", () => {
    expect(baseRate(500)).toBe(30);
    expect(baseRate(2700)).toBe(30);
    expect(baseRate(90_000)).toBe(1000);
    expect(baseRate(1_000_000) * 90).toBeGreaterThanOrEqual(1_000_000);
  });
});
