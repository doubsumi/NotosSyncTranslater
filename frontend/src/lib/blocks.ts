// ---------------------------------------------------------------------------
// Text segmentation used by the translation-memory pipeline.
//
// Hierarchy used by the whole app:
//   document  ->  blocks (separated by newlines; layout preserved verbatim)
//   block     ->  sentence parts (the translation-memory request unit)
//
// Why sentence parts? So that editing one sentence re-requests *only that
// sentence*: unchanged sentences resolve from memory and are spliced in place.
// Both panes keep a 1:1 block layout, which powers scroll linking and
// cross-pane selection highlighting.
// ---------------------------------------------------------------------------

const BLOCK_RE = /[^\n]+/g;

export function splitBlocks(text: string): string[] {
  BLOCK_RE.lastIndex = 0;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = BLOCK_RE.exec(text)) !== null) out.push(m[0]);
  return out;
}

/** All blocks of `text` with their char offsets: [start, end]. */
export function mapBlocks(text: string): Array<[number, number]> {
  BLOCK_RE.lastIndex = 0;
  const out: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = BLOCK_RE.exec(text)) !== null)
    out.push([m.index, m.index + m[0].length]);
  return out;
}

/**
 * Replace block contents in `text` using the resolver.
 * `resolve(idx, content)` returns the translation or undefined to keep the
 * original content. Every newline/blank line between blocks is copied
 * unchanged, so both panes always share identical line layout.
 */
export function rebuildWithResolver(
  text: string,
  resolve: (blockIndex: number, content: string) => string | undefined
): string {
  const parts: string[] = [];
  let cursor = 0;
  mapBlocks(text).forEach(([start, end], idx) => {
    const content = text.slice(start, end);
    parts.push(text.slice(cursor, start));
    parts.push(resolve(idx, content) ?? content);
    cursor = end;
  });
  parts.push(text.slice(cursor));
  return parts.join("");
}

/** Rebuild with an explicit index -> translation map (kept for tests). */
export function rebuildWithTranslations(
  text: string,
  translations: ReadonlyMap<number, string>
): string {
  return rebuildWithResolver(text, (idx) => translations.get(idx));
}

/** Minimal changed window via prefix/suffix compare; null when equal. */
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

// ---------------------------------------------------------------------------
// Sentence splitting (block -> sentence parts)
// ---------------------------------------------------------------------------

export interface SentencePart {
  /** The sentence text including its trailing punctuation/closers. */
  text: string;
  /** The whitespace that followed it in the source (kept verbatim). */
  ws: string;
}

const ENDERS = new Set([".", "!", "?", "。", "！", "？", "…"]);
const CLOSERS = new Set(['"', "'", "\u201c", "\u201d", ")", "]", "}", "」", "』", "》", "”", "’", "›", "»"]);
// Words that never end a sentence ("Mr.", "e.g.", "U.S." handled by rules).
const NON_ENDERS = new Set(
  (
    "mr mrs ms dr st vs etc eg ie jan feb mar apr jun jul aug sep sept oct nov dec " +
    "fig no vol pp jr sr inc ltd co dept univ mt ft gen col prof rev hon sen rep " +
    "ave blvd rd est approx min max"
  ).split(" ")
);

function wordBefore(content: string, index: number): string {
  let j = index - 1;
  while (j >= 0 && /[A-Za-z0-9]/.test(content[j])) j--;
  return content.slice(j + 1, index).toLowerCase();
}

/** Split a block into sentence parts; join(part.text + part.ws) === block. */
export function splitSentences(block: string): SentencePart[] {
  if (block.length === 0) return [];
  const parts: SentencePart[] = [];
  const n = block.length;
  let start = 0;
  let i = 0;
  while (i < n) {
    const ch = block[i];
    if (!ENDERS.has(ch)) {
      i++;
      continue;
    }
    // Decide whether ch is a true sentence boundary.
    let boundary = true;
    if (ch === ".") {
      const prevWord = wordBefore(block, i);
      if (
        prevWord.length <= 2 ||
        NON_ENDERS.has(prevWord) ||
        (i > 0 && block[i - 1] === ".")
      ) {
        // Abbreviation ("Mr.", "e.g.", "U.S.") or ellipsis run: not a break.
        boundary = false;
      }
      // Otherwise a "." (followed by whatever) ends the sentence. Real
      // sentences may start with brackets/digits/lowercase, and translation
      // output can contain periods before brackets — requiring an uppercase
      // follower was too strict and collapsed rows.
    }
    if (!boundary) {
      i++;
      continue;
    }
    // Consume terminator + any closing quotes/brackets directly attached.
    let end = i + 1;
    while (end < n && CLOSERS.has(block[end])) end++;
    // Trailing whitespace stays outside the sentence text.
    let wsEnd = end;
    while (wsEnd < n && /\s/.test(block[wsEnd])) wsEnd++;
    parts.push({ text: block.slice(start, end), ws: block.slice(end, wsEnd) });
    start = wsEnd;
    i = wsEnd;
  }
  if (start < n) {
    parts.push({ text: block.slice(start), ws: "" });
  }
  return parts;
}

function isCjkChar(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef);
}

export function isCjkish(char: string): boolean {
  return char.length > 0 && isCjkChar(char.charAt(0));
}

/**
 * Join per-part translations, re-inserting the original inter-part
 * whitespace. With `smartSpacing` (default false) the space is dropped when
 * both neighbours are CJK — the target text never gains stray spaces that the
 * source language implied but CJK typography does not need.
 */
export function joinSentenceParts(
  parts: readonly SentencePart[],
  translations: readonly string[],
  smartSpacing = false
): string {
  return composeUnits(parts, translations, smartSpacing).text;
}

export interface ComposedUnit {
  /** Character range (start, end) of this unit's translation in the result. */
  start: number;
  end: number;
}

/**
 * Single source of truth for composing unit translations back into one text.
 * Also returns each unit's offsets in the result, which the UI uses for
 * exact cross-pane sentence mapping/highlighting.
 */
export function composeUnits(
  parts: readonly SentencePart[],
  translations: readonly string[],
  smartSpacing = false
): { text: string; units: ComposedUnit[] } {
  const units: ComposedUnit[] = [];
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const translated = translations[i] ?? parts[i].text;
    const start = out.length;
    out += translated;
    units.push({ start, end: out.length });
    if (i + 1 < parts.length) {
      let ws = parts[i].ws;
      if (
        smartSpacing &&
        ws.length > 0 &&
        isCjkChar(translated.slice(-1)) &&
        isCjkChar((translations[i + 1] ?? parts[i + 1].text).charAt(0))
      ) {
        ws = "";
      }
      out += ws;
    }
  }
  return { text: out, units };
}

// ---------------------------------------------------------------------------
// Bounded request units
//
// A single sentence may still be huge (dense prose pasted without any
// sentence punctuation). Any such run is deterministically sub-chunked so
// that no single upstream request can grow unboundedly — the root cause of
// "whole paragraph resubmission + timeout". Boundaries prefer natural breaks
// (whitespace / weak clause delimiters), which keeps chunk identity stable
// when an edit happens elsewhere: only the chunk(s) really touched change.
// ---------------------------------------------------------------------------

/** Upper bound of one request unit (kept low so edits stay local). */
export const MAX_UNIT_CHARS = 200;

//: Characters we prefer to break a huge run on (clause-level, CJK aware).
const WEAK_BREAKS = new Set([
  "，", "、", "；", "：", ",", ";", ":", "—", "–", "…",
]);

function splitLongText(text: string, limit: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    // Prefer the last natural break (whitespace or weak delimiter) ≤ limit.
    let cut = -1;
    for (let i = Math.min(limit, rest.length - 1); i >= 0; i--) {
      const ch = rest[i];
      if (ch === " " || WEAK_BREAKS.has(ch)) {
        cut = i + 1;
        break;
      }
    }
    if (cut <= 0) {
      cut = limit;
      // Never split a surrogate pair.
      if (cut < rest.length) {
        const c = rest.charCodeAt(cut);
        if (c >= 0xdc00 && c <= 0xdfff) cut -= 1;
      }
      if (cut <= 0) cut = Math.max(1, Math.min(limit, rest.length));
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0 || out.length === 0) out.push(rest);
  return out;
}

/**
 * The request/TM units of a block: sentence parts, with any over-long part
 * deterministically split. `join(text+ws) === block` still holds.
 */
export function splitRequestUnits(block: string): SentencePart[] {
  const units: SentencePart[] = [];
  for (const part of splitSentences(block)) {
    if (part.text.length <= MAX_UNIT_CHARS) {
      units.push(part);
      continue;
    }
    const pieces = splitLongText(part.text, MAX_UNIT_CHARS);
    for (let i = 0; i < pieces.length; i++) {
      units.push({ text: pieces[i], ws: i === pieces.length - 1 ? part.ws : "" });
    }
  }
  return units;
}

// ---------------------------------------------------------------------------
// Selection mapping helpers (cross-pane highlight)
// ---------------------------------------------------------------------------

/** First..last block index intersected by [start, end), or null. */
export function blockRangeForSelection(
  text: string,
  start: number,
  end: number
): [number, number] | null {
  if (end <= start) return null;
  const blocks = mapBlocks(text);
  if (blocks.length === 0) return null;
  let lo = -1;
  let hi = -1;
  for (let idx = 0; idx < blocks.length; idx++) {
    const [bs, be] = blocks[idx];
    if (be <= start || bs >= end) continue;
    if (lo === -1) lo = idx;
    hi = idx;
  }
  return lo === -1 ? null : [lo, hi];
}

/** Proportional position of an offset inside the text (0..1). */
export function textProgress(text: string, offset: number): number {
  if (!text) return 0;
  const clamped = Math.max(0, Math.min(text.length, offset));
  return clamped / text.length;
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
