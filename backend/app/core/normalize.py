"""Translation output normalisation.

Why this exists
---------------
The free upstream engines are *web* translators: they often return HTML-escaped
text (``&lt;`` for ``<``, ``&gt;`` for ``>``, ``&quot;`` …). This module makes
sure no escaped entity ever reaches the UI, and that translations of one block
always stay on a single line so that the two panes keep a 1:1 block layout
(which the frontend relies on for scroll/link highlighting).

The unescape set is deliberately curated: only the entities real-world engines
emit (HTML syntax characters + common typography). ``&amp;`` is resolved last
so ``&amp;lt;`` (a user's literal ``&lt;``) is preserved correctly.
"""
from __future__ import annotations

import re

_NAMED = [
    ("&lt;", "<"),
    ("&gt;", ">"),
    ("&quot;", '"'),
    ("&apos;", "'"),
    ("&#39;", "'"),
    ("&#x27;", "'"),
    ("&nbsp;", " "),
    ("&hellip;", "…"),
    ("&mdash;", "—"),
    ("&ndash;", "–"),
    ("&middot;", "·"),
    ("&lsquo;", "‘"),
    ("&rsquo;", "’"),
    ("&ldquo;", "“"),
    ("&rdquo;", "”"),
    ("&laquo;", "«"),
    ("&raquo;", "»"),
    ("&copy;", "©"),
    ("&reg;", "®"),
    ("&trade;", "™"),
    ("&times;", "×"),
    ("&divide;", "÷"),
    ("&plusmn;", "±"),
    ("&deg;", "°"),
    ("&micro;", "µ"),
    ("&para;", "¶"),
    ("&sect;", "§"),
    ("&bull;", "•"),
    ("&euro;", "€"),
    ("&pound;", "£"),
    ("&yen;", "¥"),
    ("&cent;", "¢"),
]
_NUMERIC_RE = re.compile(r"&#(x[0-9a-fA-F]{1,6}|[0-9]{1,7});")


def unescape_entities(text: str) -> str:
    """Decode the numeric + curated named entities engines may produce."""
    if "&" not in text:
        return text

    def _num(match: re.Match) -> str:
        raw = match.group(1)
        if raw[:1] in {"x", "X"}:
            return chr(int(raw[1:], 16))
        return chr(int(raw))

    out = _NUMERIC_RE.sub(_num, text)
    for entity, char in _NAMED:
        out = out.replace(entity, char)
    # ``&amp;`` must run last so ``&amp;lt;`` becomes ``&lt;``, not ``<``.
    out = out.replace("&amp;", "&")
    return out


def normalize_translation(text: str) -> str:
    """One-line, entity-free translation text (safe for block layout)."""
    if not text:
        return ""
    out = unescape_entities(text)
    # Providers occasionally wrap long answers in newlines; a single block must
    # never contain line breaks or the two panes lose their 1:1 block layout.
    out = re.sub(r"\s*\r?\n\s*", " ", out)
    return out.strip()


def join_translated_chunks(chunks: list[str], translations: list[str]) -> str:
    """Join chunk translations reproducing the whitespace that separated the
    chunks in the *source* text (a chunk that started with a space keeps that
    separation, so Latin text never merges words at chunk seams)."""
    out: list[str] = []
    for index, translation in enumerate(translations):
        out.append(translation)
        if index + 1 < len(chunks):
            nxt = chunks[index + 1]
            leading = nxt[: len(nxt) - len(nxt.lstrip())]
            out.append(leading)
    return "".join(out)
