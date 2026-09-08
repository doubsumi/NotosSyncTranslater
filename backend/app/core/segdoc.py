"""Per-document segment queue (thread-safe, in-process, TTL + LRU).

Purpose
-------
When the frontend edits a sentence it submits ``(docId, sid, text)`` — only
the changed sentence. This module keeps, for each open document, an ordered
queue of segments (``sid -> text``) plus the produced translations, so that:

* repeat requests for an unchanged sentence are answered from the queue or the
  translation-memory cache below it (no upstream call),
* deleting/re-ordering sentences simply prunes/re-indexes the queue,
* a stale document is evicted after ``ttl`` seconds (LRU among docs).

Translation itself is delegated to a callable (the service's engine + TM
cache), keeping this module free of network concerns and fully testable.
"""
from __future__ import annotations

import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable

# (text, from_lang, to_lang) -> (translated, provider_name)
EnsureFn = Callable[[str, str, str], tuple[str, str]]


@dataclass(slots=True)
class Segment:
    text: str
    from_lang: str
    to_lang: str
    translated: str | None = None
    provider: str = ""
    updated: float = field(default_factory=time.monotonic)


@dataclass(slots=True)
class Doc:
    doc_id: str
    from_lang: str
    to_lang: str
    segments: OrderedDict[int, Segment] = field(default_factory=OrderedDict)
    updated: float = field(default_factory=time.monotonic)


class SegmentQueue:
    """Thread-safe LRU+TTL store of per-document segment queues."""

    def __init__(
        self,
        ensure_fn: EnsureFn | None = None,
        ttl_seconds: float = 1800.0,
        max_docs: int = 128,
        max_segments_per_doc: int = 20_000,
    ) -> None:
        self._ensure = ensure_fn
        self.ttl = ttl_seconds
        self.max_docs = max_docs
        self.max_segments = max_segments_per_doc
        self._docs: OrderedDict[str, Doc] = OrderedDict()
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    def _prune_locked(self, now: float) -> None:
        expired = [
            doc_id
            for doc_id, doc in self._docs.items()
            if now - doc.updated > self.ttl
        ]
        for doc_id in expired:
            self._docs.pop(doc_id, None)
        while len(self._docs) > self.max_docs:
            self._docs.popitem(last=False)  # oldest untouched doc first

    def _touch_locked(self, doc: Doc, now: float) -> None:
        doc.updated = now
        self._docs.move_to_end(doc.doc_id)

    # ------------------------------------------------------------------
    def open(self, doc_id: str, from_lang: str, to_lang: str) -> Doc:
        now = time.monotonic()
        with self._lock:
            self._prune_locked(now)
            doc = self._docs.get(doc_id)
            if doc is None:
                doc = Doc(doc_id=doc_id, from_lang=from_lang, to_lang=to_lang)
                self._docs[doc_id] = doc
            else:
                doc.from_lang = from_lang
                doc.to_lang = to_lang
            self._touch_locked(doc, now)
            return doc

    def get(self, doc_id: str) -> Doc | None:
        now = time.monotonic()
        with self._lock:
            self._prune_locked(now)
            doc = self._docs.get(doc_id)
            if doc is not None:
                self._touch_locked(doc, now)
            return doc

    def close(self, doc_id: str) -> None:
        with self._lock:
            self._docs.pop(doc_id, None)

    # ------------------------------------------------------------------
    def sync_segments(
        self,
        doc_id: str,
        from_lang: str,
        to_lang: str,
        items: list[dict[str, Any]],
        alive: list[int] | None = None,
    ) -> list[dict[str, Any]]:
        """Process changed segments.

        ``items`` carry only the edited/new sentences: ``[{sid, text}]``.
        ``alive`` is the full ordered list of currently valid sids; segments no
        longer present are pruned so deleted sentences never linger.

        Returns results in the same order as ``items``:
        ``{sid, ok, translated?, provider?, cache?, error?}``.
        """
        if self._ensure is None:
            raise RuntimeError("SegmentQueue has no translator attached")
        doc = self.open(doc_id, from_lang, to_lang)
        now = time.monotonic()
        with self._lock:
            if alive is not None:
                alive_set = set(alive)
                for sid in [s for s in doc.segments if s not in alive_set]:
                    doc.segments.pop(sid, None)

            results: list[dict[str, Any]] = []
            for raw in items:
                sid = int(raw.get("sid", -1))
                text = str(raw.get("text", ""))
                if sid < 0 or not text:
                    results.append(
                        {
                            "sid": sid,
                            "ok": False,
                            "error": {"code": "BAD_SEGMENT", "message": "invalid sid/text"},
                        }
                    )
                    continue
                seg = doc.segments.get(sid)
                if (
                    seg is not None
                    and seg.text == text
                    and seg.from_lang == from_lang
                    and seg.to_lang == to_lang
                    and seg.translated is not None
                ):
                    self._touch_locked(doc, now)
                    results.append(
                        {
                            "sid": sid,
                            "ok": True,
                            "translated": seg.translated,
                            "provider": seg.provider,
                            "cache": True,
                        }
                    )
                    continue
                try:
                    translated, provider = self._ensure(text, from_lang, to_lang)
                except Exception as exc:  # noqa: BLE001 - per-item isolation
                    results.append(
                        {
                            "sid": sid,
                            "ok": False,
                            "error": {
                                "code": "TRANSLATION_FAILED",
                                "message": str(exc)[:300],
                            },
                        }
                    )
                    continue
                doc.segments[sid] = Segment(
                    text=text,
                    from_lang=from_lang,
                    to_lang=to_lang,
                    translated=translated,
                    provider=provider,
                    updated=now,
                )
                # Bound the per-doc queue (oldest sids first).
                while len(doc.segments) > self.max_segments:
                    doc.segments.popitem(last=False)
                self._touch_locked(doc, now)
                results.append(
                    {
                        "sid": sid,
                        "ok": True,
                        "translated": translated,
                        "provider": provider,
                        "cache": False,
                    }
                )
            return results

    # ------------------------------------------------------------------
    def stats(self) -> dict[str, int]:
        with self._lock:
            return {
                "docs": len(self._docs),
                "segments": sum(len(d.segments) for d in self._docs.values()),
            }
