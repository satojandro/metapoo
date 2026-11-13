/**
 * Agent gallery data (return/growth spec §5.2).
 *
 * `agents-gallery.json` is curated by hand, in the shape of `hall.json` plus one
 * field, `prompt`: the words the owner gave the agent. Stills live in
 * `web/public/agents-gallery/`; `ops/hall/snapshot.mjs --gallery` writes one and
 * prints the entry. Adding a piece is a commit (ops/hall/README.md).
 *
 * Nothing on chain says a tile was painted by an agent, so nothing here is derived:
 * every entry is someone telling us, and an empty list is the honest state until
 * someone does. Do not seed it with examples.
 */

import raw from "./agents-gallery.json";
import { parseStills, stillEntryProblem, type WallStill } from "./wall-still";

export interface AgentPiece extends WallStill {
  /** The prompt that produced the piece, as plain text. Rendered as text, never as HTML. */
  prompt: string;
}

/** Directory under web/public that holds the gallery's stills. */
export const GALLERY_IMAGE_DIR = "agents-gallery";

/** A prompt is something a person pasted into a chat, not a document. */
export const PROMPT_MAX_CHARS = 4000;

/** Why an entry is not usable, or null when it is. */
export function agentPieceProblem(value: unknown): string | null {
  const problem = stillEntryProblem(value, GALLERY_IMAGE_DIR);
  if (problem !== null) return problem;
  const prompt = (value as Record<string, unknown>).prompt;
  if (typeof prompt !== "string" || prompt.trim() === "" || prompt.trim() === "TODO") return "prompt is missing";
  if (prompt.length > PROMPT_MAX_CHARS) return `prompt is longer than ${PROMPT_MAX_CHARS} characters`;
  return null;
}

/** Usable pieces, newest first by block. */
export function parseAgentGallery(value: unknown): AgentPiece[] {
  return parseStills<AgentPiece>(value, agentPieceProblem);
}

export const AGENT_GALLERY: readonly AgentPiece[] = parseAgentGallery(raw);
