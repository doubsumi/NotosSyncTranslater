"""Normalisation tests: entity unescape + single-line layout + chunk join."""
from app.core.normalize import (
    join_translated_chunks,
    normalize_translation,
    unescape_entities,
)
from app.core.engine import _looks_plausible


def test_common_entities_unescaped():
    assert unescape_entities("a &lt; b &gt; c") == "a < b > c"
    assert unescape_entities("&lt;html&gt;") == "<html>"
    assert unescape_entities('He said &quot;hi&quot;') == 'He said "hi"'
    assert unescape_entities("It&#39;s fine") == "It's fine"
    assert unescape_entities("&#x27;ok&#x27;") == "'ok'"
    assert unescape_entities("5 &amp; 3 = 8") == "5 & 3 = 8"


def test_amp_ordering_preserves_literal():
    # &amp;lt; means the literal text "&lt;" — must NOT become "<".
    assert unescape_entities("&amp;lt;") == "&lt;"


def test_no_entities_no_op():
    text = "普通中文 nothing & no entities"
    assert unescape_entities(text) == text


def test_normalize_collapses_provider_newlines():
    out = normalize_translation("first line\nsecond line")
    assert "\n" not in out
    assert " " in out


def test_join_preserves_boundary_space():
    chunks = ["Sentence one.", " Sentence two."]
    translations = ["第一句。", "第二句。"]
    joined = join_translated_chunks(chunks, translations)
    assert joined == "第一句。 第二句。"


def test_join_without_boundary_space():
    chunks = ["句子一。", "句子二。"]
    translations = ["Sentence one.", "Sentence two."]
    assert join_translated_chunks(chunks, translations) == (
        "Sentence one.Sentence two."
    )


def test_plausibility_rejects_hash_noise():
    assert _looks_plausible("a < b and c > d", "0cblwm2773it44inq42z") is False
    assert _looks_plausible("hello world", "你好世界") is True
    assert _looks_plausible("hello world", "hello world") is True
