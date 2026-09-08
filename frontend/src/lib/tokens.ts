// ---------------------------------------------------------------------------
// Token layer for the bilingual segment table.
//
// A document is an ordered list of tokens:
//   { type:"text", text }  (one bounded sentence)  |  { type:"sep", text }
// (any raw whitespace/newline between sentences). Invariant: joining every
// token's text reproduces the source text exactly.
// ---------------------------------------------------------------------------

import { mapBlocks, splitRequestUnits } from "./blocks";

export type RawToken =
  | { type: "text"; text: string }
  | { type: "sep"; text: string };

/** Split text into sentence/separator tokens (join(token.text) === text). */
export function tokenize(text: string): RawToken[] {
  const out: RawToken[] = [];
  let cursor = 0;
  for (const [bStart, bEnd] of mapBlocks(text)) {
    if (bStart > cursor) out.push({ type: "sep", text: text.slice(cursor, bStart) });
    for (const part of splitRequestUnits(text.slice(bStart, bEnd))) {
      if (part.text) out.push({ type: "text", text: part.text });
      if (part.ws) out.push({ type: "sep", text: part.ws });
    }
    cursor = bEnd;
  }
  if (cursor < text.length) out.push({ type: "sep", text: text.slice(cursor) });
  return out;
}

function sameToken(a: RawToken, b: RawToken): boolean {
  return a.type === b.type && a.text === b.text;
}

/**
 * Align two token sequences. Returns matched pairs (indices), and the indices
 * only present in old / next. Uses a simple LCS over tokens (middle regions
 * are small — a handful of sentences).
 */
export function alignTokenLists(
  oldTokens: RawToken[],
  nextTokens: RawToken[]
): {
  matched: Array<[number, number]>;
  oldOnly: number[];
  nextOnly: number[];
} {
  const n = oldTokens.length;
  const m = nextTokens.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = sameToken(oldTokens[i], nextTokens[j])
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matched: Array<[number, number]> = [];
  const oldOnly: number[] = [];
  const nextOnly: number[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (sameToken(oldTokens[i], nextTokens[j])) {
      matched.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      oldOnly.push(i);
      i++;
    } else {
      nextOnly.push(j);
      j++;
    }
  }
  while (i < n) oldOnly.push(i++);
  while (j < m) nextOnly.push(j++);
  return { matched, oldOnly, nextOnly };
}
