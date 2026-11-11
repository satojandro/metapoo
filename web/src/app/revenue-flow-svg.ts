/**
 * The split as a small flow diagram. Two drawings of the same graph: a wide one for
 * desktop and a tall one for phones (CSS picks one), so the labels stay readable at
 * 390 px instead of scaling down to 8 px. Static markup only: the one fact it depends on,
 * whether the board has a staking contract, is passed in rather than read here.
 * Line thickness is proportional to each share.
 */

/** Where the stakers' 70% sits: forwarded once the board has a staking contract. */
function stakerLabel(stakingSet: boolean, lines: 2 | 3): string[] {
  if (!stakingSet) return lines === 2 ? ["held on the board", "until staking opens"] : ["70%", "held until", "staking opens"];
  return lines === 2 ? ["forwarded to the staking", "contract"] : ["70%", "forwarded to the", "staking contract"];
}

interface Node {
  x: number; y: number; w: number; h: number;
  title: string; sub?: string[]; tone: "near" | "mpoo" | "team" | "stake" | "burn";
}

function node(n: Node): string {
  const cx = n.x + n.w / 2;
  const lines = n.sub ?? [];
  const top = n.y + n.h / 2 - (lines.length * 15) / 2 + 5;
  const sub = lines
    .map((line, i) => `<text class="rf-sub" x="${cx}" y="${top + 16 + i * 15}">${line}</text>`)
    .join("");
  return `<g class="rf-node rf-${n.tone}"><rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="6"/>`
    + `<text class="rf-title" x="${cx}" y="${top}">${n.title}</text>${sub}</g>`;
}

function edge(prefix: string, d: string, tone: string, share: number): string {
  const width = Math.max(2, share / 9);
  return `<path class="rf-edge rf-e-${tone}" d="${d}" stroke-width="${width}" marker-end="url(#rf-${prefix}-arrow-${tone})"/>`;
}

function markers(prefix: string): string {
  const tones = ["near", "mpoo", "team", "stake", "burn"];
  return `<defs>${tones
    .map(t => `<marker id="rf-${prefix}-arrow-${t}" class="rf-m-${t}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="2.6" markerHeight="2.6" markerUnits="strokeWidth" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z"/></marker>`)
    .join("")}</defs>`;
}

function wide(stakingSet: boolean): string {
  const A: Node = { x: 10, y: 52, w: 200, h: 56, title: "NEAR paid for credits", tone: "near" };
  const T1: Node = { x: 290, y: 10, w: 180, h: 46, title: "Team · 10%", tone: "team" };
  const B: Node = { x: 290, y: 92, w: 180, h: 62, title: "Buyback · 90%", sub: ["swaps NEAR for mPOO"], tone: "near" };
  const C: Node = { x: 10, y: 236, w: 200, h: 56, title: "mPOO paid for credits", tone: "mpoo" };
  const P: Node = { x: 530, y: 160, w: 170, h: 70, title: "mPOO on the board", sub: ["waiting for a split"], tone: "mpoo" };
  const T2: Node = { x: 780, y: 56, w: 170, h: 46, title: "Team · 10%", tone: "team" };
  const S: Node = { x: 780, y: 140, w: 170, h: 74, title: "TOILET stakers · 70%", sub: stakerLabel(stakingSet, 2), tone: "stake" };
  const X: Node = { x: 780, y: 248, w: 170, h: 60, title: "Burned · 20%", sub: ["to the burn address"], tone: "burn" };
  const edges = [
    edge("w", "M210 72 C250 72 250 33 284 33", "team", 10),
    edge("w", "M210 88 C250 88 250 123 284 123", "near", 90),
    edge("w", "M470 123 C510 123 490 185 524 185", "mpoo", 90),
    edge("w", "M210 264 C380 264 400 205 524 205", "mpoo", 100),
    edge("w", "M700 180 C740 180 740 79 774 79", "team", 10),
    edge("w", "M700 195 L774 177", "stake", 70),
    edge("w", "M700 210 C740 210 740 278 774 278", "burn", 20),
  ];
  return `<svg class="rf rf-wide" viewBox="0 0 960 320" role="img" aria-labelledby="rf-wide-t">`
    + `<title id="rf-wide-t">NEAR paid for credits splits 10% to the team and 90% to the buyback account, which swaps it for mPOO. That mPOO and mPOO paid for credits split 10% to the team, 70% to TOILET stakers and 20% burned.</title>`
    + markers("w") + edges.join("") + [A, T1, B, C, P, T2, S, X].map(node).join("") + `</svg>`;
}

function tall(stakingSet: boolean): string {
  const A: Node = { x: 10, y: 8, w: 200, h: 52, title: "NEAR paid for credits", tone: "near" };
  const T1: Node = { x: 236, y: 70, w: 114, h: 46, title: "Team · 10%", tone: "team" };
  const B: Node = { x: 10, y: 108, w: 200, h: 60, title: "Buyback · 90%", sub: ["swaps NEAR for mPOO"], tone: "near" };
  const C: Node = { x: 236, y: 206, w: 114, h: 62, title: "mPOO paid", sub: ["for credits"], tone: "mpoo" };
  const P: Node = { x: 10, y: 214, w: 200, h: 62, title: "mPOO on the board", sub: ["waiting for a split"], tone: "mpoo" };
  const T2: Node = { x: 4, y: 352, w: 106, h: 62, title: "Team", sub: ["10%"], tone: "team" };
  const S: Node = { x: 122, y: 352, w: 116, h: 92, title: "Stakers", sub: stakerLabel(stakingSet, 3), tone: "stake" };
  const X: Node = { x: 250, y: 352, w: 106, h: 62, title: "Burned", sub: ["20%"], tone: "burn" };
  const edges = [
    edge("t", "M210 34 C250 34 293 34 293 64", "team", 10),
    edge("t", "M110 60 L110 102", "near", 90),
    edge("t", "M110 168 L110 208", "mpoo", 90),
    edge("t", "M236 241 L216 241", "mpoo", 100),
    edge("t", "M70 276 C70 310 57 316 57 346", "team", 10),
    edge("t", "M110 276 C110 310 180 316 180 346", "stake", 70),
    edge("t", "M150 276 C150 310 303 316 303 346", "burn", 20),
  ];
  return `<svg class="rf rf-tall" viewBox="0 0 360 450" role="img" aria-labelledby="rf-tall-t">`
    + `<title id="rf-tall-t">NEAR paid for credits splits 10% to the team and 90% to the buyback account, which swaps it for mPOO. That mPOO and mPOO paid for credits split 10% to the team, 70% to TOILET stakers and 20% burned.</title>`
    + markers("t") + edges.join("") + [A, T1, B, C, P, T2, S, X].map(node).join("") + `</svg>`;
}

/** Both drawings; CSS shows one. `stakingSet` is the board's own signal, passed in by the page. */
export function revenueFlowSvg(stakingSet: boolean): string {
  return wide(stakingSet) + tall(stakingSet);
}
