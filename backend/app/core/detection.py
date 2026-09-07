"""Lightweight, dependency-free language detection.

Purpose: decide the *source* language label and, more importantly, resolve
``from_language="auto"`` into a concrete code for the upstream engines so they
do not mis-detect short or ambiguous snippets.

The detector is deliberately conservative: it only commits to a language when
the evidence is strong (script ratios, stop-word density for latin scripts)
and otherwise returns ``"auto"``, letting the upstream engines do their own
detection. Detection cost is a single O(n) pass over the text.

Reference material used while designing this module:
- Unicode script ranges (UAX #24).
- Stop-word lists derived from the top-function words of each language.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

# ---------------------------------------------------------------------------
# Unicode block ranges (script classification)
# ---------------------------------------------------------------------------
_CJK = (0x4E00, 0x9FFF), (0x3400, 0x4DBF)          # Han
_HIRAGANA = (0x3040, 0x309F),
_KATAKANA = (0x30A0, 0x30FF), (0x31F0, 0x31FF)
_HANGUL = (0xAC00, 0xD7AF), (0x1100, 0x11FF), (0x3130, 0x318F)
_CYRILLIC = (0x0400, 0x04FF), (0x0500, 0x052F)
_GREEK = (0x0370, 0x03FF), (0x1F00, 0x1FFF)
_THAI = (0x0E00, 0x0E7F),
_ARABIC = (0x0600, 0x06FF), (0x0750, 0x077F), (0x08A0, 0x08FF)
_HEBREW = (0x0590, 0x05FF),
_DEVANAGARI = (0x0900, 0x097F),
_LATIN_BASIC = (0x0041, 0x005A), (0x0061, 0x007A)
_LATIN_EXT = (0x00C0, 0x024F), (0x1E00, 0x1EFF)
_CJK_SYMBOLS = (0x3000, 0x303F),
_FULLWIDTH = (0xFF00, 0xFFEF),

_SCRIPT_RANGES: dict[str, tuple[tuple[int, int], ...]] = {
    "zh": _CJK,
    "hira": _HIRAGANA,
    "kata": _KATAKANA,
    "ko": _HANGUL,
    "ru": _CYRILLIC,
    "el": _GREEK,
    "th": _THAI,
    "ar": _ARABIC,
    "he": _HEBREW,
    "hi": _DEVANAGARI,
    "latin": _LATIN_BASIC + _LATIN_EXT,
}


def _classify_char(ch: str) -> str | None:
    code = ord(ch)
    if 0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF:
        return "zh"
    if 0x3040 <= code <= 0x309F:
        return "hira"
    if 0x30A0 <= code <= 0x30FF or 0x31F0 <= code <= 0x31FF:
        return "kata"
    if 0xAC00 <= code <= 0xD7AF or 0x1100 <= code <= 0x11FF or 0x3130 <= code <= 0x318F:
        return "ko"
    if 0x0400 <= code <= 0x04FF or 0x0500 <= code <= 0x052F:
        return "ru"
    if 0x0370 <= code <= 0x03FF or 0x1F00 <= code <= 0x1FFF:
        return "el"
    if 0x0E00 <= code <= 0x0E7F:
        return "th"
    if 0x0600 <= code <= 0x06FF or 0x0750 <= code <= 0x077F or 0x08A0 <= code <= 0x08FF:
        return "ar"
    if 0x0590 <= code <= 0x05FF:
        return "he"
    if 0x0900 <= code <= 0x097F:
        return "hi"
    if 0x41 <= code <= 0x5A or 0x61 <= code <= 0x7A:
        return "latin"
    if 0xC0 <= code <= 0x24F or 0x1E00 <= code <= 0x1EFF:
        return "latin"
    return None


# ---------------------------------------------------------------------------
# Latin stop-word scoring (lightweight n-gram-free classifier)
# ---------------------------------------------------------------------------
_STOPWORDS: dict[str, frozenset[str]] = {
    "en": frozenset(
        """the of and to in a is for that on it with as you this be are was not
        but have by at or from they we an he she i has had will would can could
        should do does did his her their them my your its about which who when
        where what why how if then than so just more most some any all been
        there here out up down into over under again further once also because
        only very really""".split()
    ),
    "fr": frozenset(
        """le la les de du des et un une est sont que qui dans pour en au aux
        ce cette ces il elle ils elles on nous vous je tu se sur pas plus avec
        mais ou où ou votre leurs son sa ses mon ma mes notre nos ne ni si
        comme tout tous toute toutes par dont""".split()
    ),
    "de": frozenset(
        """der die das und ist sind ich du er sie es wir ihr zu mich mir dem
        den ein eine einen einer eines nicht mit auch noch wie bei im in auf
        für von aus über unter wenn als dann was welche welcher welches oder
        aber schon nur kann können muss müssen war waren sein ihre seiner""".split()
    ),
    "es": frozenset(
        """el la los las de del y que es son un una unos unas en por para con
        no si se su sus me te le lo les como más mas pero este esta estos estas
        ese esa eso aquellos aquellas al a yo tu mi mis tu tus nuestro muy
        cuando donde quien quienes hay había han ha""".split()
    ),
    "it": frozenset(
        """il lo la le i gli di del della dei delle che e ed è un una per con
        non si sono questo questa questi queste suo sua suoi sue mio mia mio
        tu tuo tua noi voi loro anche più più o ma se come da dal dalla dei
        nel nella negli nelle""".split()
    ),
    "pt": frozenset(
        """o a os as de do da dos das e que um uma em para por com não se é
        mais como mas no na nos nas pelo pela pelos pelas ao aos à às ele ela
        eles elas eu você seu sua seus suas meu minha me te lhe este esta isso
        aquilo quando onde há tinha foi""".split()
    ),
}

_WORD_RE = re.compile(r"[a-zA-ZÀ-ÖØ-öø-ÿ]+", re.UNICODE)


@dataclass(frozen=True, slots=True)
class Detection:
    """Result of analysing a snippet of text."""

    #: Best-guess language code, or ``"auto"`` when not confident.
    lang: str
    #: Rough confidence in ``0..1`` (1.0 when the script alone is decisive).
    confidence: float
    #: Dominant script family: zh/hira/kata/ko/ru/el/th/ar/he/hi/latin/other.
    script: str
    #: Number of "meaningful" (letter) characters analysed.
    analyzed_chars: int

    def as_dict(self) -> dict:
        return {
            "lang": self.lang,
            "confidence": round(self.confidence, 3),
            "script": self.script,
            "analyzedChars": self.analyzed_chars,
        }


def _latin_guess(words: list[str]) -> tuple[str, float] | None:
    """Score latin text against stop-word lists; return code+confidence or
    ``None`` when the text is too short/ambiguous to call."""
    total = len(words)
    if total < 2:
        return None
    scores: dict[str, int] = {code: 0 for code in _STOPWORDS}
    for w in words:
        for code, stop in _STOPWORDS.items():
            if w in stop:
                scores[code] += 1
    best_code, best = max(scores.items(), key=lambda kv: kv[1])
    second = sorted(scores.values(), reverse=True)[1] if len(scores) > 1 else 0
    if best < 2 or best <= second:
        return None
    ratio = best / total
    # A text full of stop words is very likely that language.
    if ratio >= 0.30:
        return best_code, min(0.99, 0.55 + ratio)
    if best >= 3 and total >= 8:
        return best_code, 0.62
    return None


def _norm_word(raw: str) -> str:
    # Lower-case and strip combining marks/diacritics for matching.
    decomposed = unicodedata.normalize("NFD", raw).lower()
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def detect(text: str) -> Detection:
    """Detect the language of ``text`` in one linear pass.

    Priority order:
      1. Strong script signals (kana/hangul/cyrillic/thai/arabic/hebrew/
         devanagari/greek) — decisive.
      2. Han characters -> ``zh`` (Japanese written without kana is treated as
         Chinese; acceptable for the auto-default pair rules).
      3. Latin script -> stop-word scoring; else ``auto`` with script=latin.
    """
    counts: dict[str, int] = {}
    words: list[str] = []
    for ch in text:
        script = _classify_char(ch)
        if script is not None:
            counts[script] = counts.get(script, 0) + 1
    for raw in _WORD_RE.findall(text):
        words.append(_norm_word(raw))

    analyzed = sum(counts.values()) + len("".join(words))
    if analyzed == 0:
        return Detection("auto", 0.0, "other", 0)

    def _sum(*keys: str) -> int:
        return sum(counts.get(k, 0) for k in keys)

    han = _sum("zh")
    latin = _sum("latin")
    kana = _sum("hira", "kata")
    hangul = _sum("ko")
    alpha_total = han + latin + kana + hangul + _sum(
        "ru", "el", "th", "ar", "he", "hi"
    )
    if alpha_total == 0:
        return Detection("auto", 0.0, "other", analyzed)

    # --- Decisive non-latin scripts ---------------------------------------
    for code, scripts in (
        ("ru", ("ru",)),
        ("th", ("th",)),
        ("ar", ("ar",)),
        ("he", ("he",)),
        ("el", ("el",)),
        ("hi", ("hi",)),
    ):
        if counts.get(scripts[0], 0) / alpha_total >= 0.5:
            return Detection(code, 0.97, scripts[0], analyzed)

    # Japanese: kana presence (even small) strongly suggests ja.
    if kana and (kana / alpha_total >= 0.06 or han == 0):
        return Detection("ja", 0.9, "hira" if counts.get("hira") else "kata", analyzed)
    if hangul / alpha_total >= 0.4:
        return Detection("ko", 0.95, "ko", analyzed)

    # Han dominant => zh.
    if han and han / alpha_total >= 0.5:
        return Detection("zh", 0.92, "zh", analyzed)

    # Latin dominant => stop-word scoring; otherwise stay "auto".
    if latin / alpha_total >= 0.8:
        guess = _latin_guess(words)
        if guess is not None:
            code, conf = guess
            return Detection(code, conf, "latin", analyzed)
        # English is the default latin label when ambiguous, but we pass
        # "auto" upstream so the engine may still detect accurately.
        return Detection("auto", 0.0, "latin", analyzed)

    return Detection("auto", 0.0, "other", analyzed)
