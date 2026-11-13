/**
 * Hall of Fame snapshot: pure parts (return/growth spec §4.1).
 *
 * Board state in, pixel-crisp PNG out. No network here — `snapshot.mjs` does the reads.
 * The empty-tile checker matches the wall's renderer (`web/src/render-board.ts`), so a
 * still looks like the wall it was taken from.
 */
import { deflateSync } from "node:zlib";

/** The board server's region: 128 × 128, 6 bytes a tile (RGB, then a u24 owner id). */
export const REGION_SIDE = 128;
export const BYTES_PER_PIXEL = 6;
export const REGION_BYTES = REGION_SIDE * REGION_SIDE * BYTES_PER_PIXEL;

/** `web/src/render-board.ts` EMPTY_A / EMPTY_B. */
export const EMPTY_A = [0x24, 0x26, 0x29];
export const EMPTY_B = [0x29, 0x2b, 0x2e];

export function hexToRgb(hex) {
  const n = Number.parseInt(hex.replace(/^#/, ""), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * A side × side grid of RGB triples, or null for an empty tile.
 * @returns {{ side: number, cells: Array<[number, number, number] | null> }}
 */
export function emptyGrid(side) {
  return { side, cells: new Array(side * side).fill(null) };
}

/** Fill a grid from the board server's region blob. Owner id 0 means never painted. */
export function gridFromRegionBlob(bytes, side) {
  if (bytes.byteLength !== REGION_BYTES) {
    throw new Error(`Region blob is ${bytes.byteLength} bytes, expected ${REGION_BYTES}.`);
  }
  if (!Number.isInteger(side) || side < 1 || side > REGION_SIDE) {
    throw new Error(`Board side ${side} is outside 1–${REGION_SIDE}.`);
  }
  const grid = emptyGrid(side);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const at = (y * REGION_SIDE + x) * BYTES_PER_PIXEL;
      const owner = bytes[at + 3] | (bytes[at + 4] << 8) | (bytes[at + 5] << 16);
      if (owner === 0) continue;
      grid.cells[y * side + x] = [bytes[at], bytes[at + 1], bytes[at + 2]];
    }
  }
  return grid;
}

/** Fill a grid from `get_pixels` rows (`{x, y, color}`), mapping colour indices through the palette. */
export function gridFromChainPixels(pixels, side, palette) {
  const grid = emptyGrid(side);
  const byIndex = new Map(palette.map((c) => [c.index, hexToRgb(c.hex)]));
  for (const p of pixels) {
    if (p.x < 0 || p.y < 0 || p.x >= side || p.y >= side) continue;
    const rgb = byIndex.get(p.color);
    if (!rgb) throw new Error(`Tile ${p.x},${p.y} has colour ${p.color}, which is not in the palette.`);
    grid.cells[p.y * side + p.x] = rgb;
  }
  return grid;
}

/** Parse "x,y,w,h" and check it fits the board. */
export function parseCrop(text, side) {
  if (!text) return { x: 0, y: 0, w: side, h: side };
  const parts = text.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) {
    throw new Error(`--crop wants x,y,w,h in whole tiles, got "${text}".`);
  }
  const [x, y, w, h] = parts;
  if (x < 0 || y < 0 || w < 1 || h < 1 || x + w > side || y + h > side) {
    throw new Error(`--crop ${text} does not fit a ${side} × ${side} board.`);
  }
  return { x, y, w, h };
}

/**
 * RGB scanlines for a crop at a whole-number scale. Empty tiles get the wall's checker,
 * keyed on the tile's board coordinates so a crop matches the wall exactly.
 */
export function rasterize(grid, crop, scale) {
  if (!Number.isInteger(scale) || scale < 1 || scale > 64) {
    throw new Error(`--scale must be a whole number from 1 to 64, got ${scale}.`);
  }
  const width = crop.w * scale;
  const height = crop.h * scale;
  const rgb = Buffer.alloc(width * height * 3);
  for (let ty = 0; ty < crop.h; ty += 1) {
    for (let tx = 0; tx < crop.w; tx += 1) {
      const bx = crop.x + tx;
      const by = crop.y + ty;
      const color = grid.cells[by * grid.side + bx] ?? ((bx + by) % 2 === 0 ? EMPTY_A : EMPTY_B);
      for (let dy = 0; dy < scale; dy += 1) {
        let at = ((ty * scale + dy) * width + tx * scale) * 3;
        for (let dx = 0; dx < scale; dx += 1) {
          rgb[at] = color[0];
          rgb[at + 1] = color[1];
          rgb[at + 2] = color[2];
          at += 3;
        }
      }
    }
  }
  return { width, height, rgb };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * An 8-bit truecolour PNG. `text` becomes tEXt chunks (the block height, the board),
 * so a still carries where it came from.
 */
export function encodePng({ width, height, rgb }, text = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const texts = Object.entries(text).map(([k, v]) => chunk("tEXt", Buffer.from(`${k}\0${v}`, "latin1")));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...texts,
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * The `hall.json` entry this still belongs to, with the fields only a human can fill
 * (title, painters) left as TODO. The camera link centres the crop.
 */
export function entrySkeleton({ id, block, crop, image, date }) {
  return {
    id,
    title: "TODO",
    date,
    block,
    painters: ["TODO"],
    x: crop.x + Math.floor(crop.w / 2),
    y: crop.y + Math.floor(crop.h / 2),
    zoom: 12,
    image,
  };
}
