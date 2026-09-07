"""Live smoke tests — real upstream providers, run only on demand:

    set NST_LIVE_TESTS=1   (Windows) / NST_LIVE_TESTS=1 (Unix)

These hit the network and are skipped in normal CI runs.
"""
import os

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("NST_LIVE_TESTS") != "1", reason="live tests disabled"
)


def test_live_translate_both_directions():
    from app.core.engine import Engine

    engine = Engine(providers=("bing", "alibaba", "sogou"), timeout=15)
    text_en, prov_en = engine.translate_one(
        "The weather is lovely today, let's go for a walk.", "auto", "zh"
    )
    assert "天气" in text_en or "散步" in text_en
    text_zh, _ = engine.translate_one("今天天气很好，我们一起去散步吧。", "auto", "en")
    assert "walk" in text_zh.lower() or "weather" in text_zh.lower()
    assert prov_en in {"bing", "alibaba", "sogou"}
    engine.close()


def test_live_service_long_text():
    from app.core.cache import TranslationCache
    from app.core.engine import Engine
    from app.core.service import TranslationService, Item

    engine = Engine(providers=("bing", "alibaba"), timeout=15)
    cache = TranslationCache(ttl=300, max_entries=200)
    svc = TranslationService(engine, cache, split_block_chars=500)
    text = ("This is a fairly long sentence for chunking. " * 8) + "结束。"
    results = svc.translate_batch([Item("1", text, "auto", "zh")])
    assert results[0]["ok"] is True
    assert len(results[0]["translated"]) > 0
    engine.close()
    cache.close()
