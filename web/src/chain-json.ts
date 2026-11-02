/**
 * Lossless JSON for contract views and calls. Plain JSON u64 timestamps (for example
 * the history fields in get_tunables) exceed JavaScript's safe integer range, so an
 * ordinary JSON.parse / JSON.stringify round trip would change them.
 */

/** Plain u64 timestamps in get_tunables exceed JS's safe integer range.
 * Tokenize strings and numbers before JSON.parse, so timestamps keep every digit.
 * Quoted U128 amounts stay strings; unquoted large integers become bigint.
 */
export function parseChainJson(text: string): unknown {
  const integers: bigint[] = [];
  // The generated marker cannot collide with any string in the original input.
  let marker = "__admin_integer__";
  while (text.includes(marker)) marker += "_";
  const protectedJson = text.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
    if (token.startsWith('"') || !/^-?\d+$/.test(token) || Number.isSafeInteger(Number(token))) return token;
    return JSON.stringify(`${marker}${integers.push(BigInt(token)) - 1}`);
  });
  return JSON.parse(protectedJson, (_, value) => typeof value === "string" && value.startsWith(marker)
    ? integers[Number(value.slice(marker.length))] : value);
}

/** Serialize bigint as a JSON number, not a quoted U64 string. Preserve U128 strings. */
export function stringifyChainJson(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map(stringifyChainJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value)
    .map(([key, v]) => `${JSON.stringify(key)}:${stringifyChainJson(v)}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("InvalidChainValue");
  return encoded;
}
