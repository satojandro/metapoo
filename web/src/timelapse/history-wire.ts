/**
 * Decoder for one `GET /api/history` page (TIMELAPSE, return/growth spec §4.3).
 *
 * The server packs the draw log to about three bytes a tile
 * (`ops/board-server/common/src/history_wire.rs`, where the layout is written down):
 *
 *   "MPH1" · flags · rows · next cursor · records…
 *   0x01 paints:    block Δ, at_ms Δ (zigzag), n, n × [x, y, colour]
 *   0x02 expansion: block Δ, at_ms Δ (zigzag), from, to
 *
 * Both ends are pinned to the same fixture (`common/fixtures/history-page.json`). A body that
 * is not exactly this is `null`, never a partial page: the timelapse draws what the log says
 * or says it cannot.
 */

export interface PaintRecord {
  kind: "paints";
  block: number;
  atMs: number;
  /** `x, y, colour` triples, in applied order. A view into the page's bytes. */
  tiles: Uint8Array;
}

export interface ExpandRecord {
  kind: "expand";
  block: number;
  atMs: number;
  from: number;
  to: number;
}

export type HistoryRecord = PaintRecord | ExpandRecord;

export interface HistoryPage {
  /** The page was full: ask again after `next`. */
  more: boolean;
  /** Stream rows packed in this page (tiles plus expansions). */
  rows: number;
  /** Cursor for the next page, `"<position>-<index>"`; null on an empty page. */
  next: string | null;
  records: HistoryRecord[];
}

const MAGIC = [0x4d, 0x50, 0x48, 0x31]; // "MPH1"
const TAG_PAINTS = 1;
const TAG_EXPAND = 2;

class Reader {
  at = 0;
  constructor(readonly bytes: Uint8Array) {}

  /** Unsigned LEB128. Multiplies instead of shifting, so it is exact up to 2^53. */
  varint(): number {
    let value = 0;
    let scale = 1;
    for (;;) {
      if (this.at >= this.bytes.length) throw new Error("truncated");
      const byte = this.bytes[this.at++]!;
      value += (byte & 0x7f) * scale;
      if (!Number.isSafeInteger(value)) throw new Error("too large");
      if ((byte & 0x80) === 0) return value;
      scale *= 128;
    }
  }

  zigzag(): number {
    const v = this.varint();
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  }
}

export function decodeHistoryPage(input: ArrayBuffer | Uint8Array): HistoryPage | null {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 8 || MAGIC.some((b, i) => bytes[i] !== b)) return null;
  try {
    const reader = new Reader(bytes);
    reader.at = 4;
    const more = (bytes[reader.at++]! & 1) === 1;
    const rows = reader.varint();
    const position = reader.varint();
    const index = reader.varint();
    const records: HistoryRecord[] = [];
    let block = 0;
    let atMs = 0;
    let seen = 0;
    while (reader.at < bytes.length) {
      const tag = bytes[reader.at++]!;
      if (tag !== TAG_PAINTS && tag !== TAG_EXPAND) return null;
      block += reader.varint();
      atMs += reader.zigzag();
      if (!Number.isSafeInteger(block) || atMs < 0) return null;
      if (tag === TAG_EXPAND) {
        records.push({ kind: "expand", block, atMs, from: reader.varint(), to: reader.varint() });
        seen += 1;
      } else {
        const n = reader.varint();
        const end = reader.at + n * 3;
        if (n === 0 || end > bytes.length) return null;
        records.push({ kind: "paints", block, atMs, tiles: bytes.subarray(reader.at, end) });
        reader.at = end;
        seen += n;
      }
    }
    // The header counts what the body holds; a mismatch is a cut-off or corrupted page.
    if (seen !== rows) return null;
    return { more, rows, next: rows > 0 || position > 0 ? `${position}-${index}` : null, records };
  } catch {
    return null;
  }
}
