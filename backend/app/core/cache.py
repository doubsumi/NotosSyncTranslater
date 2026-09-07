"""Translation-memory caches.

A small, thread-safe in-memory LRU with TTL (L1) and an optional SQLite
backing layer (L2) so translated chunks survive server restarts. The cache is
the key to "do not re-request what already has a translation":

* the client never sends an unchanged block again (client-side diff), and
* when the same text *is* sent again (swaps, undo, paste of old content),
  this cache answers in microseconds without touching any upstream provider.

Keys are SHA-1 over the canonical request tuple (from, to, text), so lookups
are O(1) with a single pass over the text for the digest.
"""
from __future__ import annotations

import hashlib
import sqlite3
import threading
import time
from collections import OrderedDict
from pathlib import Path


def cache_key(from_lang: str, to_lang: str, text: str) -> str:
    payload = f"{from_lang}\x1f{to_lang}\x1f{text}"
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


class MemoryLRU:
    """TTL LRU cache with a hard entry cap (thread-safe)."""

    def __init__(self, ttl: int, max_entries: int) -> None:
        self._ttl = ttl
        self._max = max(max_entries, 1)
        self._data: OrderedDict[str, tuple[float, str]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> str | None:
        now = time.monotonic()
        with self._lock:
            item = self._data.get(key)
            if item is None:
                return None
            expires_at, value = item
            if expires_at <= now:
                del self._data[key]
                return None
            self._data.move_to_end(key)
            return value

    def set(self, key: str, value: str, ttl: int | None = None) -> None:
        expires_at = time.monotonic() + (self._ttl if ttl is None else ttl)
        with self._lock:
            self._data[key] = (expires_at, value)
            self._data.move_to_end(key)
            while len(self._data) > self._max:
                self._data.popitem(last=False)

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)


class DiskCache:
    """Optional SQLite-backed layer. Schema keeps one row per key with an
    expiry column; a single connection guarded by a lock is enough for the
    low write rates this cache sees."""

    def __init__(self, path: str, ttl: int) -> None:
        self._ttl = ttl
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self._path), check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS tm ("
            "  key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at REAL NOT NULL)"
        )
        self._conn.commit()
        self._lock = threading.Lock()

    def get(self, key: str) -> str | None:
        now = time.time()
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM tm WHERE key = ? AND expires_at > ?",
                (key, now),
            ).fetchone()
            if row is None:
                self._conn.execute("DELETE FROM tm WHERE key = ?", (key,))
                self._conn.commit()
                return None
            return row[0]

    def set(self, key: str, value: str, ttl: int | None = None) -> None:
        expires_at = time.time() + (self._ttl if ttl is None else ttl)
        with self._lock:
            self._conn.execute(
                "INSERT INTO tm (key, value, expires_at) VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, "
                "expires_at=excluded.expires_at",
                (key, value, expires_at),
            )
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()


class TranslationCache:
    """Two-tier cache façade used by the translation service."""

    def __init__(
        self, ttl: int, max_entries: int, db_path: str = ""
    ) -> None:
        self._l1 = MemoryLRU(ttl, max_entries)
        self._l2: DiskCache | None = None
        if db_path:
            self._l2 = DiskCache(db_path, ttl)

    def get(self, from_lang: str, to_lang: str, text: str) -> str | None:
        key = cache_key(from_lang, to_lang, text)
        hit = self._l1.get(key)
        if hit is not None:
            return hit
        if self._l2 is not None:
            hit = self._l2.get(key)
            if hit is not None:
                self._l1.set(key, hit)
                return hit
        return None

    def set(self, from_lang: str, to_lang: str, text: str, value: str) -> None:
        key = cache_key(from_lang, to_lang, text)
        self._l1.set(key, value)
        if self._l2 is not None:
            self._l2.set(key, value)

    @property
    def size(self) -> int:
        return len(self._l1)

    def close(self) -> None:
        if self._l2 is not None:
            self._l2.close()
