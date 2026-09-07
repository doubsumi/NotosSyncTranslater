// ---------------------------------------------------------------------------
// Block segmentation + document rebuild (client mirror of the backend rules).
//
// A *block* is a maximal run of non-newline characters; blocks are the unit
// of translation memory. Newlines/blank lines are layout and are preserved
// verbatim by `rebuild`, so the two panes always keep identical line layout.
// ---------------------------------------------------------------------------

const BLOCK_RE = /[^\n]+/g;

export function splitBlocks(text: string): string[] {
  BLOCK_RE.lastIndex = 0;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = BLOCK_RE.exec(text)) !== null) out.push(m[0]);
  return out;
}

/** All blocks of `text` with their char offsets: [start, end, content]. */
export function mapBlocks(text: string): Array<[number, number, string]> {
  BLOCK_RE.lastIndex = 0;
  const out: Array<[number, number, string]> = [];
  let m: RegExpExecArray | null;
  while ((m = BLOCK_RE.exec(text)) !== null)
    out.push([m.index, m.index + m[0].length, m[0]]);
  return out;
}

/**
 * Replace block contents in `text` by their translations (index -> text).
 * Every newline and blank line between blocks is copied unchanged.
 */
export function rebuildWithTranslations(
  text: string,
  translations: ReadonlyMap<number, string>
): string {
  const parts: string[] = [];
  let cursor = 0;
  mapBlocks(text).forEach(([start, end, content], idx) => {
    parts.push(text.slice(cursor, start));
    parts.push(translations.get(idx) ?? content);
    cursor = end;
  });
  parts.push(text.slice(cursor));
  return parts.join("");
}

/**
 * Minimal changed window between two block lists via prefix/suffix compare.
 * Returns [firstChanged, firstUnchangedFromTail) over the *current* list,
 * or null when the lists are equal. O(prefix + suffix).
 */
export function changedRange(
  prev: readonly string[],
  curr: readonly string[]
): [number, number] | null {
  if (prev.length === curr.length && prev.every((b, i) => b === curr[i]))
    return null;
  let lo = 0;
  const n = prev.length;
  const m = curr.length;
  while (lo < n && lo < m && prev[lo] === curr[lo]) lo++;
  let tailN = n;
  let tailM = m;
  while (tailN > lo && tailM > lo && prev[tailN - 1] === curr[tailM - 1]) {
    tailN--;
    tailM--;
  }
  return [lo, tailM];
}

/** FNV-1a 32-bit hash — fast, good enough for in-memory TM keys. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
