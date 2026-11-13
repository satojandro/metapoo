import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeHistoryPage } from "./history-wire";
import { headFor, hexBytes, replayFromZero, syntheticRecords } from "./test-support";
import { buildTimeline, CHECKPOINT_EVERY, createReplay, frameAt, GRID, positionAtBlock, sideAt } from "./timeline";

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "../../../ops/board-server/common/fixtures/history-page.json"), "utf8"),
) as { hex: string };

const at = (state: Uint8Array, x: number, y: number) => state[y * GRID + x]!;

describe("replaying the fixture log", () => {
  const page = decodeHistoryPage(hexBytes(fixture.hex))!;
  const timeline = buildTimeline(page.records, { complete: true, initialSide: 64, side: 96 });

  it("reproduces the known final wall, across the expansion", () => {
    const replay = createReplay(timeline);
    replay.seek(timeline.length);
    expect(timeline.length).toBe(7);
    // (1,2) was painted colour 3 and then 0 in the same block: the later one stands.
    // 0 means "never painted", so a stored colour is its index + 1.
    const painted: Record<string, number> = {};
    replay.state.forEach((value, i) => {
      if (value) painted[`${i % GRID},${Math.floor(i / GRID)}`] = value - 1;
    });
    expect(painted).toEqual({ "1,2": 0, "63,63": 15, "10,11": 7, "95,80": 12, "64,0": 4, "0,95": 9 });
    expect(replay.side).toBe(96);
  });

  it("grows the wall exactly when the log says it grew", () => {
    expect(timeline.expansions).toEqual([{ at: 4, from: 64, to: 96, block: 223200000, atMs: 1762051800000 }]);
    expect([0, 3, 4, 5, 7].map((p) => sideAt(timeline, p))).toEqual([64, 64, 96, 96, 96]);
    expect(timeline.startSide).toBe(64);
    expect(timeline.maxSide).toBe(96);
    // The tiles beyond 64 are only there after the expansion.
    const replay = createReplay(timeline);
    replay.seek(4);
    expect(at(replay.state, 95, 80)).toBe(0);
    replay.seek(5);
    expect(at(replay.state, 95, 80)).toBe(13);
  });

  it("names the block and time of the frame on screen", () => {
    expect(frameAt(timeline, 0)).toBeNull();
    expect(frameAt(timeline, 1)).toMatchObject({ block: 223113576, atMs: 1762000000123 });
    expect(frameAt(timeline, 3)).toMatchObject({ block: 223113576 });
    expect(frameAt(timeline, 4)).toMatchObject({ block: 223113700 });
    expect(frameAt(timeline, 7)).toMatchObject({ block: 223200010 });
  });

  it("opens a shared block at the wall as it stood at the end of that block", () => {
    expect(positionAtBlock(timeline, 1)).toBe(0);
    expect(positionAtBlock(timeline, 223113576)).toBe(3);
    expect(positionAtBlock(timeline, 223113699)).toBe(3);
    expect(positionAtBlock(timeline, 223113700)).toBe(4);
    expect(positionAtBlock(timeline, 223200009)).toBe(6);
    expect(positionAtBlock(timeline, 999999999)).toBe(7);
    // And the block the page prints for a position leads back to that position.
    for (let p = 1; p <= timeline.length; p += 1) {
      const shared = positionAtBlock(timeline, frameAt(timeline, p)!.block);
      expect(frameAt(timeline, shared)!.block).toBe(frameAt(timeline, p)!.block);
    }
  });
});

describe("seeking", () => {
  // Three checkpoints' worth of paint, growing twice.
  const records = syntheticRecords({ paints: CHECKPOINT_EVERY * 3 + 517, expandAt: 5000, expandAgainAt: 9000 });
  const timeline = buildTimeline(records, headFor(records));

  it("replays a few thousand paints with two expansions to the same wall as applying them all", () => {
    const replay = createReplay(timeline);
    replay.seek(timeline.length);
    expect(timeline.length).toBe(CHECKPOINT_EVERY * 3 + 517);
    expect(replay.state).toEqual(replayFromZero(records, timeline.length));
    expect(replay.side).toBe(128);
    expect(timeline.checkpoints).toHaveLength(4);
  });

  it("seeking backwards gives exactly the wall a replay from zero gives at that point", () => {
    const replay = createReplay(timeline);
    replay.seek(timeline.length);
    for (const target of [9001, 9000, 8999, CHECKPOINT_EVERY + 1, CHECKPOINT_EVERY, CHECKPOINT_EVERY - 1, 5000, 4999, 137, 1, 0]) {
      replay.seek(target);
      expect(replay.position).toBe(target);
      expect(replay.state, `at ${target}`).toEqual(replayFromZero(records, target));
      expect(replay.side).toBe(target >= 9000 ? 128 : target >= 5000 ? 96 : 64);
    }
    // And forwards again, by a step and by a jump over a checkpoint.
    for (const target of [1, 2, 4000, 4097, 12000, timeline.length]) {
      replay.seek(target);
      expect(replay.state, `at ${target}`).toEqual(replayFromZero(records, target));
    }
  });

  it("never replays more than one checkpoint's worth to go backwards", () => {
    const replay = createReplay(timeline);
    replay.seek(timeline.length);
    expect(replay.seek(timeline.length - 1)).toBeLessThan(CHECKPOINT_EVERY);
    expect(replay.seek(CHECKPOINT_EVERY + 5)).toBe(5);
    expect(replay.seek(3)).toBe(3);
    // A step forward applies only the step.
    expect(replay.seek(40)).toBe(37);
  });

  it("clamps a seek outside the log", () => {
    const replay = createReplay(timeline);
    replay.seek(-5);
    expect(replay.position).toBe(0);
    replay.seek(Number.NaN);
    expect(replay.position).toBe(0);
    replay.seek(1e12);
    expect(replay.position).toBe(timeline.length);
  });
});

describe("a log that does not start at the first paint", () => {
  const records = syntheticRecords({ paints: 300, expandAt: 120 });

  it("is marked as partial, and takes its starting side from its first expansion", () => {
    const timeline = buildTimeline(records, headFor(records, { complete: false, initialSide: null, startBlock: null }));
    expect(timeline.fromGenesis).toBe(false);
    expect(timeline.startSide).toBe(64);
    expect(timeline.maxSide).toBe(96);
  });

  it("with no expansion in it, the wall was the size it is now throughout", () => {
    const flat = syntheticRecords({ paints: 300 });
    const timeline = buildTimeline(flat, { complete: false, initialSide: null, side: 96 });
    expect(timeline.fromGenesis).toBe(false);
    expect(timeline.startSide).toBe(96);
  });

  it("shows a paint no logged expansion explains instead of hiding it", () => {
    // An older server logged the draws but not the growth: tiles beyond 64 with no expansion.
    const draws = records.filter((r) => r.kind === "paints");
    const timeline = buildTimeline(draws, { complete: true, initialSide: 64, side: 96 });
    expect(timeline.startSide).toBe(96);
    expect(timeline.maxSide).toBe(96);
  });

  it("an empty log is a timeline of nothing", () => {
    const timeline = buildTimeline([], { complete: false, initialSide: null, side: 64 });
    expect(timeline.length).toBe(0);
    expect(timeline.checkpoints).toHaveLength(1);
    expect(frameAt(timeline, 0)).toBeNull();
    expect(positionAtBlock(timeline, 5)).toBe(0);
  });
});
