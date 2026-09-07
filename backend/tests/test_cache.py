"""Translation cache tests."""
import time

from app.core.cache import TranslationCache, cache_key


def test_set_get_roundtrip():
    cache = TranslationCache(ttl=60, max_entries=100)
    assert cache.get("en", "zh", "hello") is None
    cache.set("en", "zh", "hello", "你好")
    assert cache.get("en", "zh", "hello") == "你好"


def test_key_depends_on_langs_and_text():
    a = cache_key("en", "zh", "hi")
    b = cache_key("en", "zh", "hi ")
    c = cache_key("en", "zh-CN", "hi")
    d = cache_key("auto", "zh", "hi")
    assert len({a, b, c, d}) == 4


def test_ttl_expiry():
    cache = TranslationCache(ttl=1, max_entries=100)
    cache.set("en", "zh", "hello", "你好")
    time.sleep(1.1)
    assert cache.get("en", "zh", "hello") is None


def test_lru_eviction_cap():
    cache = TranslationCache(ttl=60, max_entries=3)
    for i in range(5):
        cache.set("en", "zh", f"text-{i}", f"out-{i}")
    # Only the three most recent survive.
    assert cache.get("en", "zh", "text-0") is None
    assert cache.get("en", "zh", "text-4") == "out-4"
    assert cache.size <= 3


def test_unicode_values():
    cache = TranslationCache(ttl=60, max_entries=10)
    cache.set("zh", "en", "你好，世界", "Hello, world")
    assert cache.get("zh", "en", "你好，世界") == "Hello, world"
