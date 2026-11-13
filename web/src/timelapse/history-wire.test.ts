import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeHistoryPage } from "./history-wire";
import { hexBytes } from "./test-support";

/** The fixture the server's encoder is pinned to (`history_wire.rs`, `the_encoder_matches…`). */
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "../../../ops/board-server/common/fixtures/history-page.json"), "utf8"),
) as { hex: string; rows: Array<Record<string, number | string | boolean>> };

describe("decodeHistoryPage", () => {
  it("reads back every row of the fixture the server encoder produced, in order", () => {
    const page = decodeHistoryPage(hexBytes(fixture.hex))!;
    expect(page).not.toBeNull();
    expect(page.more).toBe(true);
    expect(page.rows).toBe(fixture.rows.length);
    expect(page.next).toBe(fixture.rows.at(-1)!.id);

    // Flatten the records back into rows and compare with what the log held.
    const decoded: Array<Record<string, number | string>> = [];
    for (const record of page.records) {
      if (record.kind === "expand") {
        decoded.push({ kind: "expand", block: record.block, at_ms: record.atMs, from: record.from, to: record.to });
        continue;
      }
      for (let i = 0; i < record.tiles.length; i += 3) {
        decoded.push({ block: record.block, at_ms: record.atMs, x: record.tiles[i]!, y: record.tiles[i + 1]!, color: record.tiles[i + 2]! });
      }
    }
    const expected = fixture.rows.map((row) =>
      row.kind === "expand"
        ? { kind: "expand", block: row.block, at_ms: row.at_ms, from: row.from, to: row.to }
        : { block: row.block, at_ms: row.at_ms, x: row.x, y: row.y, color: row.color },
    );
    expect(decoded).toEqual(expected);
    // Block heights and millisecond times survive whole (they are past 2^32).
    expect(page.records[0]!.atMs).toBe(1762000000123);
    // A time one millisecond earlier than the record before it decodes as such.
    expect(page.records.at(-1)!.atMs).toBe(1762051805399);
  });

  it("groups paints of one block and time into one record", () => {
    const page = decodeHistoryPage(hexBytes(fixture.hex))!;
    expect(page.records.map((r) => (r.kind === "paints" ? r.tiles.length / 3 : "expand"))).toEqual([3, 1, "expand", 2, 1]);
  });

  it("reads an empty page as empty, with no cursor", () => {
    expect(decodeHistoryPage(hexBytes("4d50483100000000"))).toEqual({ more: false, rows: 0, next: null, records: [] });
  });

  it("refuses anything that is not a whole MPH1 page", () => {
    const good = hexBytes(fixture.hex);
    expect(decodeHistoryPage(new Uint8Array())).toBeNull();
    expect(decodeHistoryPage(new TextEncoder().encode("<html>502 Bad Gateway</html>"))).toBeNull();
    // Another magic, a cut-off body, an unknown record tag, a row count the body does not hold.
    expect(decodeHistoryPage(Uint8Array.from([...good].map((b, i) => (i === 3 ? 0x32 : b))))).toBeNull();
    expect(decodeHistoryPage(good.subarray(0, good.length - 2))).toBeNull();
    expect(decodeHistoryPage(Uint8Array.from([...good, 9, 0, 0]))).toBeNull();
    expect(decodeHistoryPage(Uint8Array.from([...good].map((b, i) => (i === 5 ? b + 1 : b))))).toBeNull();
  });
});
