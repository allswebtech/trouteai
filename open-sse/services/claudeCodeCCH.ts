/**
 * Claude Code CCH (Client Content Hash) signing.
 *
 * Real Claude Code uses Bun/Zig to compute an xxHash64 integrity token over
 * the serialized request body. The server verifies this to confirm the request
 * came from a genuine Claude Code client.
 *
 * Algorithm:
 *   1. Serialize request body with cch=00000 placeholder
 *   2. xxHash64(body_bytes, seed) & 0xFFFFF
 *   3. Zero-padded 5-char lowercase hex
 *   4. Replace cch=00000 with computed value
 */

import xxhashInit from "xxhash-wasm";

const CCH_SEED = 0x6e52736ac806831en;
const CCH_PATTERN = /\bcch=([0-9a-f]{5});/;

let xxhashPromise: Promise<void> | null = null;
let xxhash64Fn: ((input: Uint8Array, seed: bigint) => bigint) | null = null;

async function ensureXxhash() {
  if (xxhash64Fn) return;
  if (!xxhashPromise) {
    xxhashPromise = (async () => {
      const hasher = await xxhashInit();
      xxhash64Fn = hasher.h64Raw;
    })();
  }
  return xxhashPromise;
}

export async function computeCCH(bodyBytes: Uint8Array): Promise<string> {
  await ensureXxhash();
  const hash = xxhash64Fn!(bodyBytes, CCH_SEED);
  const masked = hash & 0xfffffn;
  return masked.toString(16).padStart(5, "0");
}

/** Index of the closing quote of the JSON string that opens at `open`. */
function stringEnd(json: string, open: number): number {
  let end = open + 1;
  while (end < json.length && json[end] !== '"') end += json[end] === "\\" ? 2 : 1;
  return end;
}

/** [start, end) of the value of the top-level `system` key of a JSON object string. */
function systemValueRange(json: string): [number, number] | null {
  let depth = 0;
  let systemStart = -1;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (c === '"') {
      const end = stringEnd(json, i);
      if (depth === 1) {
        let j = end + 1;
        while (" \n\t\r".includes(json[j])) j++;
        if (json[j] === ":") {
          if (systemStart >= 0) return [systemStart, i];
          if (json.slice(i + 1, end) === "system") systemStart = j + 1;
        }
      }
      i = end;
    } else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return systemStart >= 0 ? [systemStart, i] : null;
    }
  }
  return null;
}

// The `cch=` of the billing line: within one JSON string (no quote in between).
const BILLING_CCH = /x-anthropic-billing-header[^"]*?\bcch=([0-9a-f]{5});/g;

/**
 * Where the billing line's `cch=xxxxx;` value starts, looking only inside the top-level
 * `system`. A first-match rewrite of the whole body could hit the same words in user text
 * (`messages` is serialised before `system`) and leave the real billing line unsigned.
 */
function findBillingCch(body: string): number {
  if (!body.includes("x-anthropic-billing-header")) return -1;
  const range = systemValueRange(body);
  if (!range) return -1;
  BILLING_CCH.lastIndex = range[0];
  const match = BILLING_CCH.exec(body);
  if (!match || match.index >= range[1]) return -1;
  const at = match.index + match[0].length - "cch=00000;".length;
  return at < range[1] ? at : -1;
}

export async function signRequestBody(bodyString: string): Promise<string> {
  const at = findBillingCch(bodyString);
  if (at < 0) return bodyString;
  const encoder = new TextEncoder();
  const bodyBytes = encoder.encode(bodyString);
  const token = await computeCCH(bodyBytes);
  return bodyString.slice(0, at) + `cch=${token};` + bodyString.slice(at + "cch=00000;".length);
}

export { CCH_PATTERN };
