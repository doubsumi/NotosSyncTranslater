"""Text segmentation used by the translation-memory pipeline.

Design notes
------------
* A *block* is a maximal run of non-newline characters. Blocks are the
  translation-memory unit: an edit inside one block only re-translates that
  block; unchanged neighbours are spliced straight from memory.
* Separators (newline runs, blank lines) are never translated and are
  preserved verbatim when the translated document is reassembled, so
  ``assemble(blocks, translations)`` reproduces the original layout exactly.
* A block longer than ``max_chars`` is internally sub-chunked at sentence
  boundaries by the server before it reaches an upstream engine. Sub-chunks
  are cached independently, so local edits in a giant paragraph re-use every
  unchanged sentence. Because input is chunked this way there is *no* upper
  input limit: cost stays O(n) with bounded per-request size.
"""
from __future__ import annotations

import re

_BLOCK_RE = re.compile(r"[^\n]+")
# Common sentence enders across zh/en/ja/ko + European scripts.
_ENDERS = {".", "!", "?", "。", "！", "？", "…", "…"}


def split_blocks(text: str) -> list[str]:
    """Return the list of blocks (non-empty, newline-free strings)."""
    return _BLOCK_RE.findall(text)


def assemble(blocks: list[str]) -> str:
    """Reconstruct a document from its blocks joined by single newlines.

    Used when separators do not matter (client side) — see ``map_blocks``
    for the exact layout-preserving version.
    """
    return "\n".join(blocks)


def map_blocks(text: str) -> list[tuple[int, int, str]]:
    """Map every block to ``(start, end, content)`` byte-free char offsets.

    Layout-preserving reassembly is then just: walk the text once, and for
    each block span replace its content with the translation.
    """
    return [(m.start(), m.end(), m.group()) for m in _BLOCK_RE.finditer(text)]


def rebuild_with_translations(
    text: str,
    translations: dict[int, str],
) -> str:
    """Replace the content of translated blocks inside ``text``.

    ``translations`` maps a block index (order of appearance in ``text``) to
    the translated block content. Every character outside blocks — newlines,
    blank lines — is copied verbatim, so line layout is preserved exactly.
    """
    parts: list[str] = []
    cursor = 0
    for idx, (start, end, content) in enumerate(map_blocks(text)):
        parts.append(text[cursor:start])
        parts.append(translations.get(idx, content))
        cursor = end
    parts.append(text[cursor:])
    return "".join(parts)


def changed_range(prev: list[str], curr: list[str]) -> tuple[int, int] | None:
    """Return ``[first_changed, first_unchanged_from_the_end)`` indices of the
    minimal changed window between two block lists.

    Uses the classic prefix/suffix comparison: everything before the first
    differing block and everything after the last differing block is aligned
    and reusable. Complexity O(prefix + suffix) ≤ O(len(prev)+len(curr)),
    which keeps per-keystroke diffing cheap even for very long documents.
    """
    if prev == curr:
        return None
    n, m = len(prev), len(curr)
    lo = 0
    while lo < n and lo < m and prev[lo] == curr[lo]:
        lo += 1
    hi_n, hi_m = n, m
    while hi_n > lo and hi_m > lo and prev[hi_n - 1] == curr[hi_m - 1]:
        hi_n -= 1
        hi_m -= 1
    # Blocks in [hi_m, m) equal tail of prev and are reusable; changed window
    # on the *current* list is [lo, hi_m).
    return (lo, hi_m)


# ---------------------------------------------------------------------------
# Server-side sub-chunking of oversized blocks
# ---------------------------------------------------------------------------
def _find_split_point(block: str, limit: int) -> int:
    """Best place ≤ ``limit`` to cut ``block``: prefer a sentence ender."""
    if limit <= 0 or limit >= len(block):
        return len(block)
    # Look for the last sentence ender before the limit.
    best = -1
    for i in range(min(limit, len(block)) - 1, -1, -1):
        if block[i] in _ENDERS:
            # Keep the ender attached to the left chunk.
            best = i + 1
            break
    if best > 0:
        return best
    # Fall back to the last whitespace, then to a hard cut (never splitting a
    # surrogate pair).
    best = -1
    for i in range(min(limit, len(block)) - 1, -1, -1):
        if block[i].isspace():
            best = i + 1
            break
    if best > 0:
        return best
    cut = min(limit, len(block))
    if cut < len(block) and 0xDC00 <= ord(block[cut]) <= 0xDFFF:
        cut -= 1
    return max(cut, 1)


def subchunk(block: str, max_chars: int) -> list[str]:
    """Split one block into chunks of at most ``max_chars`` chars, preferring
    sentence boundaries. ``"".join(result) == block`` always holds."""
    if len(block) <= max_chars:
        return [block]
    chunks: list[str] = []
    rest = block
    while len(rest) > max_chars:
        cut = _find_split_point(rest, max_chars)
        chunks.append(rest[:cut])
        rest = rest[cut:]
    chunks.append(rest)
    return chunks
