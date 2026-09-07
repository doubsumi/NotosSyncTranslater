"""Service-layer tests with a fake engine (no network, no translators)."""
import threading

import pytest

from app.core.cache import TranslationCache
from app.core.engine import EngineError
from app.core.service import TranslationService, Item


class FakeEngine:
    def __init__(self, fail_texts: set[str] | None = None):
        self.calls: list[tuple[str, str, str]] = []
        self.fail_texts = fail_texts or set()
        self.lock = threading.Lock()

    def translate_one(self, text: str, from_lang: str, to_lang: str):
        with self.lock:
            self.calls.append((text, from_lang, to_lang))
        if text in self.fail_texts:
            raise EngineError(f"boom: {text[:20]}")
        # Deterministic fake translation: wrap in brackets.
        return f"[{text}]", "fake"


def make_service(split: int = 1600, fail: set[str] | None = None):
    engine = FakeEngine(fail)
    cache = TranslationCache(ttl=60, max_entries=1000)
    return TranslationService(engine, cache, split_block_chars=split), engine, cache


def test_single_translation_and_cache():
    svc, engine, cache = make_service()
    out = svc.translate_text("hello world", "auto", "zh")
    assert out["translated"] == "[hello world]"
    assert out["ok"] is True
    # Second identical request must hit the cache: no new engine call.
    out2 = svc.translate_text("hello world", "auto", "zh")
    assert out2["cacheHits"] >= 1
    assert len(engine.calls) == 1


def test_batch_dedupe():
    svc, engine, _ = make_service()
    results = svc.translate_batch(
        [
            Item("a", "same text", "en", "zh"),
            Item("b", "same text", "en", "zh"),
            Item("c", "other text", "en", "zh"),
        ]
    )
    assert len(results) == 3
    assert all(r["ok"] for r in results)
    assert len(engine.calls) == 2  # identical requests collapsed


def test_auto_resolves_chinese_source():
    svc, engine, _ = make_service()
    out = svc.translate_text("今天天气不错", "auto", "en")
    assert out["from"] == "zh"
    assert out["translated"] == "[今天天气不错]"


def test_per_item_failure_isolation():
    svc, engine, _ = make_service(fail={"bad chunk"})
    results = svc.translate_batch(
        [
            Item("ok", "good chunk", "en", "zh"),
            Item("bad", "bad chunk", "en", "zh"),
        ]
    )
    ok, bad = results
    assert ok["ok"] is True
    assert bad["ok"] is False
    assert bad["error"]["code"] == "TRANSLATION_FAILED"


def test_long_text_is_chunked_and_identical_to_input_length():
    svc, engine, _ = make_service(split=300)
    text = "Sentence A. " * 60 + "中文句子。" * 40
    out = svc.translate_text(text, "auto", "zh")
    assert out["ok"] is True
    assert len(engine.calls) > 1  # split into several upstream calls
    # Every upstream call must have received an exact sub-chunk of the input
    # (concurrency makes the call order arbitrary, hence the sort).
    from app.core.segmentation import subchunk

    expected_pieces = sorted(subchunk(text, 300))
    actual_pieces = sorted(call[0] for call in engine.calls)
    assert actual_pieces == expected_pieces


def test_unsupported_language_rejected():
    svc, _, _ = make_service()
    with pytest.raises(ValueError):
        svc.translate_text("hi", "en", "klingon")
    with pytest.raises(ValueError):
        svc.translate_text("hi", "auto", "auto")


def test_batch_empty():
    svc, engine, _ = make_service()
    assert svc.translate_batch([]) == []
    assert engine.calls == []
