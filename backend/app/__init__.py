"""Application factory for the Notos Sync Translator backend.

Builds the Flask app, wires the translation service (engine + cache), JSON
error handling, CORS, request-id/timing logging, optional gzip compression
and — when a frontend build exists — serves the SPA from the same origin.
"""
from __future__ import annotations

import gzip
import logging
import time
import uuid
from pathlib import Path

from flask import Flask, abort, g, jsonify, request, send_from_directory
from flask_cors import CORS

from .api.errors import register_error_handlers
from .api.routes import api
from .config import Config
from .core.cache import TranslationCache
from .core.engine import Engine
from .core.service import TranslationService


def _configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )


def _spa_routes(app: Flask, static_dir: str) -> None:
    """Serve the built SPA and fall back to ``index.html`` for client routes."""
    root = Path(static_dir)

    @app.get("/")
    def _index():  # noqa: ANN202
        return send_from_directory(root, "index.html")

    @app.get("/<path:path>")
    def _assets(path: str):  # noqa: ANN202
        if path.startswith(("api", "static")):
            abort(404)
        candidate = root / path
        if candidate.is_file():
            return send_from_directory(root, path)
        return send_from_directory(root, "index.html")


def _gzip_json(response):  # noqa: ANN001, ANN201
    """Compress JSON payloads over 1 KiB when the client accepts gzip."""
    if (
        response.direct_passthrough  # streaming file responses: never touch
        or response.status_code < 200
        or response.status_code >= 300
        or (response.mimetype or "") != "application/json"
        or "gzip" not in request.headers.get("Accept-Encoding", "")
    ):
        return response
    data = response.get_data()
    if len(data) < 1024:
        return response
    compressed = gzip.compress(data, mtime=0)
    response.set_data(compressed)
    response.headers["Content-Encoding"] = "gzip"
    response.headers["Vary"] = "Accept-Encoding"
    return response


def create_app(config: Config | None = None) -> Flask:
    """Application factory."""
    cfg = config or Config()
    _configure_logging(cfg.log_level)

    app = Flask(__name__, static_folder=None)
    # Flask-native settings only; the rest of the config object is available
    # through app.extensions["nst_config"].
    app.config["DEBUG"] = cfg.debug
    app.config["SECRET_KEY"] = cfg.secret_key
    app.config["MAX_CONTENT_LENGTH"] = cfg.max_content_length

    CORS(app, origins=list(cfg.cors_origins), methods=["GET", "POST", "OPTIONS"])

    # ---- request lifecycle: request-id, timing, logs, gzip -----------------
    @app.before_request
    def _before():  # noqa: ANN202
        g.request_id = request.headers.get("X-Request-Id") or uuid.uuid4().hex[:12]
        g.request_started = time.perf_counter()

    @app.after_request
    def _after(response):  # noqa: ANN202
        response = _gzip_json(response)
        response.headers["X-Request-Id"] = getattr(g, "request_id", "-")
        elapsed_ms = (time.perf_counter() - getattr(g, "request_started", time.perf_counter())) * 1000
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
            app.logger.info(
                '%s %s -> %s (%.1f ms) rid=%s',
                request.method,
                request.path,
                response.status_code,
                elapsed_ms,
                g.request_id,
            )
        return response

    # ---- services ----------------------------------------------------------
    engine = Engine(
        providers=cfg.providers,
        timeout=cfg.provider_timeout,
        pacing=cfg.provider_pacing,
        max_workers=cfg.provider_max_workers,
        failure_threshold=cfg.provider_failure_threshold,
        cooldown=cfg.provider_cooldown,
    )
    cache = TranslationCache(cfg.cache_ttl, cfg.cache_max_entries, cfg.cache_db_path)
    service = TranslationService(
        engine=engine,
        cache=cache,
        split_block_chars=cfg.server_split_block_chars,
        max_parallel=cfg.provider_max_workers,
    )
    app.extensions["nst_config"] = cfg
    app.extensions["nst_engine"] = engine
    app.extensions["nst_cache"] = cache
    app.extensions["nst_service"] = service

    # ---- routes ------------------------------------------------------------
    app.register_blueprint(api)
    register_error_handlers(app)
    if cfg.static_dir:
        _spa_routes(app, cfg.static_dir)
        app.logger.info("serving SPA from %s", cfg.static_dir)
    else:
        app.logger.warning(
            "frontend build not found; API only. Build it with "
            "`npm run build` inside frontend/ or set NST_STATIC_DIR."
        )
    return app
