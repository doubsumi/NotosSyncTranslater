"""Application configuration.

Every tunable knob lives here and can be overridden through environment
variables prefixed with ``NST_`` so the app can run unchanged in dev,
Docker and CI.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_csv(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return tuple(part.strip() for part in raw.split(",") if part.strip())


# Backend package root: backend/app/config.py -> backend/app -> backend
BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent


def default_static_dir() -> str:
    """Frontend build directory. Prefers an explicit override, then the
    conventional monorepo location ``frontend/dist`` next to ``backend/``."""
    override = os.environ.get("NST_STATIC_DIR")
    if override:
        return override
    candidate = REPO_DIR / "frontend" / "dist"
    return str(candidate) if candidate.is_dir() else ""


@dataclass(slots=True)
class Config:
    """Runtime configuration. Customise via environment variables."""

    #: Host / port for ``python run.py``.
    host: str = os.environ.get("NST_HOST", "127.0.0.1")
    port: int = _env_int("NST_PORT", 5000)
    debug: bool = _env_bool("NST_DEBUG", False)

    #: Comma separated list of upstream free-translation providers, in
    #: preference order. See ``app/core/engine.py`` for the pool logic.
    providers: tuple[str, ...] = _env_csv(
        "NST_PROVIDERS", ("bing", "alibaba", "sogou")
    )
    #: Per-provider HTTP timeout in seconds.
    provider_timeout: float = _env_float("NST_PROVIDER_TIMEOUT", 12.0)
    #: Minimum gap between two consecutive calls *to the same provider*
    #: (gentle pacing that keeps free upstreams happy).
    provider_pacing: float = _env_float("NST_PROVIDER_PACING", 0.4)
    #: How many provider calls may run concurrently across all requests.
    provider_max_workers: int = _env_int("NST_PROVIDER_WORKERS", 3)
    #: After this many consecutive failures a provider is cooled down.
    provider_failure_threshold: int = _env_int("NST_PROVIDER_FAIL_THRESHOLD", 2)
    #: Cool-down (seconds) applied when a provider trips the threshold.
    provider_cooldown: float = _env_float("NST_PROVIDER_COOLDOWN", 60.0)

    #: Per-item translation-memory cache TTL (seconds) and entry cap.
    cache_ttl: int = _env_int("NST_CACHE_TTL", 60 * 60 * 24)  # 24h
    cache_max_entries: int = _env_int("NST_CACHE_MAX", 8192)
    #: Optional SQLite-backed persistent layer for the cache (empty = off).
    cache_db_path: str = os.environ.get("NST_CACHE_DB", "")

    #: Per-document segment queue (live editor incremental sync).
    segqueue_ttl: float = _env_float("NST_SEGQUEUE_TTL", 1800.0)  # seconds
    segqueue_max_docs: int = _env_int("NST_SEGQUEUE_MAX_DOCS", 128)
    segqueue_max_segments: int = _env_int("NST_SEGQUEUE_MAX_SEGMENTS", 20_000)

    #: Longest single chunk sent to an upstream provider. Any text longer than
    #: this is split at sentence boundaries first, so there is *no* upper
    #: input limit while every upstream call stays bounded.
    chunk_max_chars: int = _env_int("NST_CHUNK_MAX_CHARS", 1600)
    #: Blocks above this size are sub-chunked by the server. This only matters
    #: for gigantic single paragraphs pasted without any newline.
    server_split_block_chars: int = _env_int("NST_SERVER_SPLIT_BLOCK", 1600)

    #: CORS. In production the SPA is served from the same origin, so this is
    #: only needed when the frontend dev-server (Vite) talks to the API.
    cors_origins: tuple[str, ...] = _env_csv(
        "NST_CORS_ORIGINS", ("http://localhost:5173", "http://127.0.0.1:5173")
    )

    #: Per-IP token-bucket limits protecting the free upstreams.
    rate_limit_per_minute: int = _env_int("NST_RATE_LIMIT_PER_MIN", 600)
    rate_limit_burst: int = _env_int("NST_RATE_LIMIT_BURST", 90)

    #: Cap on a single request body (bytes). Generous: documents are split
    #: into chunks before they ever reach a provider, so 8 MB still means
    #: "no practical input limit".
    max_content_length: int = 8 * 1024 * 1024

    #: Where the built SPA lives ('' => API-only mode).
    static_dir: str = field(default_factory=default_static_dir)
    #: Secret used for request-id signing / session cookies (optional).
    secret_key: str = os.environ.get("NST_SECRET_KEY", "dev-only-secret")

    log_level: str = os.environ.get("NST_LOG_LEVEL", "INFO")

    def to_json(self) -> dict:
        """Non-secret summary exposed by ``GET /api/health``."""
        return {
            "providers": list(self.providers),
            "chunkMaxChars": self.chunk_max_chars,
            "cacheTtlSeconds": self.cache_ttl,
            "cacheMaxEntries": self.cache_max_entries,
            "rateLimitPerMinute": self.rate_limit_per_minute,
            "staticDir": self.static_dir or None,
            "maxContentLengthBytes": self.max_content_length,
        }
