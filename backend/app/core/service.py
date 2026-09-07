"""Translation service: ties together cache, detection and the engine.

Public entry points
-------------------
* ``translate_text`` — one logical text (block).
* ``translate_batch`` — many independent texts with dedupe, parallel
  upstream calls and independent per-item failures.

Both split oversized blocks into bounded sub-chunks internally and reuse
sentence-level translation memory, which is what makes arbitrarily long input
feasible with O(n) work and tiny per-request payloads.
"""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Any

from . import detection as det
from .cache import TranslationCache, cache_key
from .engine import Engine, EngineError
from .segmentation import subchunk

#: Language codes the API accepts (``auto`` allowed as source only).
ALLOWED_LANGS = frozenset(
    {
        "auto", "zh", "en", "ja", "ko", "fr", "de", "es", "ru", "pt", "it",
        "ar", "th", "vi", "id", "hi",
    }
)


def validate_lang(lang: str, *, allow_auto: bool) -> str:
    code = (lang or "").strip().lower()
    if code not in ALLOWED_LANGS or (code == "auto" and not allow_auto):
        raise ValueError(f"unsupported language code: {lang!r}")
    return code


def resolve_source(lang: str, text: str) -> str:
    """Resolve ``auto`` into a concrete source code when detection is
    confident; otherwise keep ``auto`` for the upstream engine."""
    if lang != "auto" or not text.strip():
        return lang
    result = det.detect(text)
    return result.lang if result.lang != "auto" else "auto"


@dataclass(slots=True)
class ChunkWork:
    """One provider-sized unit of translation work."""

    key: str
    text: str
    from_lang: str
    to_lang: str
    no_cache: bool = False


@dataclass(slots=True)
class Item:
    """A translation request for one logical text."""

    id: str
    text: str
    from_lang: str
    to_lang: str
    no_cache: bool = False


class TranslationService:
    """Orchestrates chunking, cache and engine; safe across request threads."""

    def __init__(
        self,
        engine: Engine,
        cache: TranslationCache,
        split_block_chars: int = 1600,
        max_parallel: int = 3,
    ) -> None:
        self.engine = engine
        self.cache = cache
        self.split_block_chars = max(split_block_chars, 200)
        self.max_parallel = max(1, max_parallel)
        self._inflight: dict[str, threading.Event] = {}
        self._inflight_lock = threading.Lock()

    # ------------------------------------------------------------------
    def translate_text(self, text: str, from_lang: str, to_lang: str) -> dict[str, Any]:
        """Translate a single text; used by ``POST /api/translate``."""
        results = self.translate_batch(
            [Item(id="t0", text=text, from_lang=from_lang, to_lang=to_lang)]
        )
        result = results[0]
        if not result["ok"]:
            err = result.get("error") or {}
            raise EngineError(
                err.get("message", "translation failed"),
                err.get("providerErrors"),
            )
        return result

    # ------------------------------------------------------------------
    def translate_batch(self, items: list[Item]) -> list[dict[str, Any]]:
        """Translate a batch with parallel upstream calls and per-item
        failure isolation. Results are returned in request order."""
        if not items:
            return []

        # 1. Prepare: chunk each item, resolve ``auto`` source languages.
        prepared: list[tuple[Item, list[ChunkWork], str]] = []
        for item in items:
            from_lang = resolve_source(item.from_lang, item.text)
            to_lang = validate_lang(item.to_lang, allow_auto=False)
            chunks = [
                ChunkWork(
                    key="",
                    text=text,
                    from_lang=from_lang,
                    to_lang=to_lang,
                    no_cache=item.no_cache,
                )
                # Empty text never reaches an upstream provider.
                for text in subchunk(item.text, self.split_block_chars)
                if text
            ]
            prepared.append((item, chunks, from_lang))

        # 2. Collapse identical work across the whole batch (one upstream call
        #    per unique (from, to, text), however many times it was requested).
        unique: dict[str, ChunkWork] = {}
        for _, chunks, _resolved in prepared:
            for chunk in chunks:
                chunk.key = cache_key(chunk.from_lang, chunk.to_lang, chunk.text)
                existing = unique.get(chunk.key)
                if existing is None:
                    unique[chunk.key] = chunk
                elif chunk.no_cache:
                    existing.no_cache = True  # explicit refresh wins

        # 3. Serve cache hits immediately (unless a refresh was requested).
        translated: dict[str, str] = {}
        provider_of: dict[str, str] = {}
        misses: list[ChunkWork] = []
        for key, chunk in unique.items():
            if not chunk.no_cache:
                hit = self.cache.get(chunk.from_lang, chunk.to_lang, chunk.text)
                if hit is not None:
                    translated[key] = hit
                    provider_of[key] = "cache"
                    continue
            misses.append(chunk)

        # 4. Translate the misses concurrently.
        if misses:
            self._translate_misses(misses, translated, provider_of)

        # 5. Assemble per-item results in request order.
        results: list[dict[str, Any]] = []
        for item, chunks, from_lang in prepared:
            pieces: list[str] = []
            provider = "cache"
            cache_hits = 0
            error: dict[str, Any] | None = None
            for chunk in chunks:
                value = translated.get(chunk.key)
                if value is None:
                    error = {
                        "code": "TRANSLATION_FAILED",
                        "message": "no provider could translate this text",
                        "providerErrors": {
                            "upstream": "all configured providers failed"
                        },
                    }
                    break
                pieces.append(value)
                chunk_provider = provider_of.get(chunk.key, "cache")
                if chunk_provider == "cache":
                    cache_hits += 1
                else:
                    provider = chunk_provider  # last upstream provider wins
            if error is None:
                results.append(
                    {
                        "id": item.id,
                        "ok": True,
                        "translated": "".join(pieces),
                        "from": from_lang,
                        "to": item.to_lang,
                        "provider": provider,
                        "cacheHits": cache_hits,
                    }
                )
            else:
                results.append({"id": item.id, "ok": False, "error": error})
        return results

    # ------------------------------------------------------------------
    def _translate_misses(
        self,
        misses: list[ChunkWork],
        translated: dict[str, str],
        provider_of: dict[str, str],
    ) -> None:
        """Run upstream calls for the missing chunks (bounded concurrency)."""
        workers = min(len(misses), self.max_parallel)
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(self._translate_one_claimed, chunk): chunk
                for chunk in misses
            }
            for future in as_completed(futures):
                chunk = futures[future]
                try:
                    value, provider = future.result()
                except EngineError:
                    continue  # per-chunk failure surfaces at item assembly
                if value is not None:
                    translated[chunk.key] = value
                    provider_of[chunk.key] = provider or "cache"

    def _translate_one_claimed(
        self, chunk: ChunkWork
    ) -> tuple[str | None, str]:
        """Translate one chunk, coalescing concurrent duplicates."""
        try:
            if not chunk.no_cache and self.cache.get(
                chunk.from_lang, chunk.to_lang, chunk.text
            ) is not None:
                return None, "cache"
            if not self._wait_or_claim(chunk.key):
                # Another thread is translating the same key right now; read
                # the cache once it lands.
                return self.cache.get(chunk.from_lang, chunk.to_lang, chunk.text), "cache"
            try:
                value, provider = self.engine.translate_one(
                    chunk.text, chunk.from_lang, chunk.to_lang
                )
                self.cache.set(chunk.from_lang, chunk.to_lang, chunk.text, value)
                return value, provider
            finally:
                self._release(chunk.key)
        except EngineError:
            return None, ""

    # ------------------------------------------------------------------
    def _wait_or_claim(self, key: str) -> bool:
        """True => this thread owns the work; False => waited for a peer."""
        with self._inflight_lock:
            ev = self._inflight.get(key)
            if ev is not None:
                ev.wait(timeout=60)
                return False
            ev = threading.Event()
            self._inflight[key] = ev
            return True

    def _release(self, key: str) -> None:
        with self._inflight_lock:
            ev = self._inflight.pop(key, None)
        if ev is not None:
            ev.set()
