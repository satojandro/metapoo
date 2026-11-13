#!/usr/bin/env node
/**
 * Take a Hall of Fame still of the wall (return/growth spec §4.1).
 *
 *   node ops/hall/snapshot.mjs --id first-fill --server https://<board-server> [--board <contract>] [--crop x,y,w,h] [--scale 8]
 *   node ops/hall/snapshot.mjs --id first-fill --rpc https://rpc.mainnet.fastnear.com --board <contract>
 *
 * Writes `web/public/hall/<id>.png` (override with --out) and prints the `hall.json`
 * entry skeleton with the block the still was read at. Title and painters are for a
 * human to fill in: adding an entry is a commit.
 *
 * With --gallery the still is for the agent gallery on /agents (spec §5.2): it goes to
 * `web/public/agents-gallery/<id>.png` and the entry is an `agents-gallery.json` one,
 * with `prompt` to fill in as well.
 *
 * Reads only. With --server it uses the region blob (`GET /api/region/0/0`, block from
 * `x-last-block`); with --rpc it pages `get_pixels` pinned to one final block.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  encodePng,
  entrySkeleton,
  gridFromChainPixels,
  gridFromRegionBlob,
  parseCrop,
  rasterize,
  stillDir,
} from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const PAGE = 100;

const { values } = parseArgs({
  options: {
    id: { type: "string" },
    server: { type: "string" },
    rpc: { type: "string" },
    board: { type: "string" },
    crop: { type: "string" },
    scale: { type: "string", default: "8" },
    out: { type: "string" },
    gallery: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help || !values.id || (!values.server && !(values.rpc && values.board))) {
  console.error(
    "usage: snapshot.mjs --id <slug> (--server <url> | --rpc <url> --board <contract>) [--crop x,y,w,h] [--scale n] [--gallery] [--out file.png]",
  );
  process.exit(values.help ? 0 : 2);
}
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(values.id)) {
  console.error(`--id must be a lowercase slug (a-z, 0-9, -), got "${values.id}".`);
  process.exit(2);
}

async function fromServer(base) {
  const url = `${base.replace(/\/+$/, "")}/api/region/0/0`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}.`);
  const block = Number(res.headers.get("x-last-block"));
  const side = Number(res.headers.get("x-board-side") ?? 0);
  if (!Number.isSafeInteger(block) || block <= 0) throw new Error(`${url} sent no usable x-last-block.`);
  if (!Number.isInteger(side) || side < 1) throw new Error(`${url} sent no usable x-board-side.`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // The server does not name its board; --board labels the still when given.
  return { block, side, grid: gridFromRegionBlob(bytes, side), board: values.board ?? "" };
}

async function rpcCall(rpc, params) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "hall", method: "query", params }),
  });
  if (!res.ok) throw new Error(`${rpc} answered HTTP ${res.status}.`);
  const body = await res.json();
  if (body.error || body.result?.error) {
    throw new Error(`RPC error: ${JSON.stringify(body.error ?? body.result.error)}`);
  }
  return body.result;
}

async function view(rpc, board, method, args, blockId) {
  const result = await rpcCall(rpc, {
    request_type: "call_function",
    account_id: board,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    ...(blockId ? { block_id: blockId } : { finality: "final" }),
  });
  return { block: result.block_height, data: JSON.parse(Buffer.from(result.result).toString("utf8")) };
}

async function fromChain(rpc, board) {
  // Pin every page to the block the first read landed on, so the still is one moment.
  const meta = await view(rpc, board, "get_board", {});
  const block = meta.block;
  const side = Number(meta.data.width);
  const pixels = [];
  let from = 0;
  for (;;) {
    const page = (await view(rpc, board, "get_pixels", { from_index: from, limit: PAGE }, block)).data;
    pixels.push(...page.pixels);
    if (page.next_from_index === null || page.next_from_index === undefined) break;
    from = page.next_from_index;
  }
  const palette = JSON.parse(readFileSync(resolve(repo, "shared/board.json"), "utf8")).palette;
  return { block, side, grid: gridFromChainPixels(pixels, side, palette), board };
}

const source = values.server ? await fromServer(values.server) : await fromChain(values.rpc, values.board);
const crop = parseCrop(values.crop, source.side);
const scale = Number(values.scale);
const image = rasterize(source.grid, crop, scale);
const out = resolve(values.out ?? resolve(repo, stillDir(values.gallery), `${values.id}.png`));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  encodePng(image, {
    Source: "Meta Poo wall",
    Board: source.board || "unknown",
    Block: String(source.block),
    Crop: `${crop.x},${crop.y},${crop.w},${crop.h}`,
  }),
);

const publicDir = resolve(repo, "web/public");
const served = out.startsWith(publicDir) ? `/${relative(publicDir, out).split("\\").join("/")}` : out;
console.error(`wrote ${out} (${image.width} × ${image.height}, block ${source.block})`);
console.log(
  JSON.stringify(
    entrySkeleton({ id: values.id, block: source.block, crop, image: served, date: new Date().toISOString().slice(0, 10), gallery: values.gallery }),
    null,
    2,
  ),
);
