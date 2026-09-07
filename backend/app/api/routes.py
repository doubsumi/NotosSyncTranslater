"""HTTP routes for the translation API.

Endpoints
---------
* ``GET  /api/health``            — liveness + config + provider status.
* ``POST /api/detect``            — lightweight language detection.
* ``POST /api/translate``         — translate one logical text.
* ``POST /api/translate/batch``   — translate many texts with dedupe/parallel.

Payload sizes are not capped at the text level (chunking lives in the
service); only the raw request body is bounded by the server config.
"""
from __future__ import annotations

import threading
import time
from typing import Any

from flask import Blueprint, current_app, g, jsonify, request

from ..core import detection as det
from ..core.service import Item, validate_lang
from .errors import ApiError

api = Blueprint("api", __name__, url_prefix="/api")

# Rate limiting: per-IP token bucket (in-memory, best effort; protects the
# free upstream engines from accidental request storms).
_RATE_LOCK = threading.Lock()
_RATE_BUCKETS: dict[str, "tuple[float, float]"] = {}


def _rate_limited() -> bool:
    """Token bucket: refills at per_min/60 per second up to `burst` tokens."""
    cfg = current_app.extensions["nst_config"]
    per_min = max(1, cfg.rate_limit_per_minute)
    burst = max(1, cfg.rate_limit_burst)
    now = time.monotonic()
    ip = request.remote_addr or "unknown"
    with _RATE_LOCK:
        entry = _RATE_BUCKETS.get(ip)
        if entry is None:
            tokens, last = float(burst), now
        else:
            tokens, last = entry
            tokens = min(float(burst), tokens + (now - last) * per_min / 60.0)
        if tokens >= 1.0:
            _RATE_BUCKETS[ip] = (tokens - 1.0, now)
            if len(_RATE_BUCKETS) > 8192:
                for key in list(_RATE_BUCKETS)[:1024]:  # shed oldest entries
                    _RATE_BUCKETS.pop(key, None)
            return False
        _RATE_BUCKETS[ip] = (tokens, now)
        return True


@api.before_request
def _guard():  # noqa: ANN201
    if request.method in {"POST", "PUT", "DELETE"} and _rate_limited():
        raise ApiError(
            429,
            "RATE_LIMITED",
            "too many requests, please slow down a little",
        )


def _body() -> dict[str, Any]:
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        raise ApiError(400, "BAD_REQUEST", "request body must be a JSON object")
    return payload


@api.get("/health")
def health():  # noqa: ANN201
    cfg = current_app.extensions["nst_config"]
    svc = current_app.extensions["nst_service"]
    engine = svc.engine
    return jsonify(
        {
            "status": "ok",
            "service": "notos-sync-translate",
            "time": time.time(),
            "config": cfg.to_json(),
            "providers": engine.provider_status,
            "cache": {"entries": svc.cache.size},
        }
    )


@api.post("/detect")
def detect():  # noqa: ANN201
    payload = _body()
    text = payload.get("text", "")
    if not isinstance(text, str):
        raise ApiError(400, "BAD_REQUEST", "'text' must be a string")
    result = det.detect(text)
    return jsonify(result.as_dict())


@api.post("/translate")
def translate():  # noqa: ANN201
    payload = _body()
    text = payload.get("text")
    from_lang = str(payload.get("from", "auto")).lower()
    to_lang = str(payload.get("to", "")).lower()
    if not isinstance(text, str):
        raise ApiError(400, "BAD_REQUEST", "'text' must be a string")
    try:
        validate_lang(from_lang, allow_auto=True)
        validate_lang(to_lang, allow_auto=False)
    except ValueError as exc:
        raise ApiError(422, "BAD_LANGUAGE", str(exc)) from exc
    svc = current_app.extensions["nst_service"]
    started = time.perf_counter()
    try:
        result = svc.translate_text(text, from_lang, to_lang)
    except Exception as exc:  # noqa: BLE001 - surfaced as a JSON error
        current_app.logger.warning("translate failed: %s", exc)
        raise ApiError(
            502, "TRANSLATION_FAILED", "no provider could translate this text"
        ) from exc
    result["elapsedMs"] = round((time.perf_counter() - started) * 1000)
    return jsonify(result)


@api.post("/translate/batch")
def translate_batch():  # noqa: ANN201
    payload = _body()
    raw_items = payload.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise ApiError(400, "BAD_REQUEST", "'items' must be a non-empty array")
    if len(raw_items) > 500:
        raise ApiError(400, "BAD_REQUEST", "too many items in one batch")
    items: list[Item] = []
    for index, raw in enumerate(raw_items):
        if not isinstance(raw, dict):
            raise ApiError(400, "BAD_REQUEST", f"items[{index}] must be an object")
        text = raw.get("text")
        if not isinstance(text, str):
            raise ApiError(400, "BAD_REQUEST", f"items[{index}].text must be a string")
        from_lang = str(raw.get("from", "auto")).lower()
        to_lang = str(raw.get("to", "")).lower()
        try:
            validate_lang(from_lang, allow_auto=True)
            validate_lang(to_lang, allow_auto=False)
        except ValueError as exc:
            raise ApiError(
                422, "BAD_LANGUAGE", f"items[{index}]: {exc}"
            ) from exc
        items.append(
            Item(
                id=str(raw.get("id", index)),
                text=text,
                from_lang=from_lang,
                to_lang=to_lang,
                no_cache=bool(raw.get("noCache", False)),
            )
        )
    svc = current_app.extensions["nst_service"]
    started = time.perf_counter()
    results = svc.translate_batch(items)
    return jsonify(
        {
            "results": results,
            "elapsedMs": round((time.perf_counter() - started) * 1000),
        }
    )


# Attach shared state helpers onto g for logging use.
def get_request_id() -> str:
    return getattr(g, "request_id", "-")
