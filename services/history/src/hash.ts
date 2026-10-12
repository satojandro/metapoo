import { createHash } from "node:crypto";
import { bytesToHex } from "../../../shared/history/encode.ts";

/** SHA-256 digest as lowercase hex (no 0x). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export { bytesToHex };
