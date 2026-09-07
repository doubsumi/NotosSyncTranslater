"""HTTP API tests against the Flask test client (engine fully faked)."""
import threading

import pytest

from app import create_app
from app.config import Config


class FakeEngine:
    def __init__(self):
        self.calls = 0
        self.lock = threading.Lock()

    @property
    def provider_status(self):
        return [{"name": "fake", "healthy": True, "latencyMs": 5, "consecutiveFailures": 0}]

    def translate_one(self, text: str, from_lang: str, to_lang: str):
        with self.lock:
            self.calls += 1
        return f"[{text}]", "fake"


class FakeCache:
    def __init__(self):
        self.size = 0

    def get(self, *a):
        return None

    def set(self, *a):
        self.size += 1


@pytest.fixture()
def client():
    cfg = Config()
    cfg.cors_origins = ()
    cfg.rate_limit_per_minute = 100000
    cfg.rate_limit_burst = 100000
    app = create_app(cfg)
    # Replace services with fakes AFTER app creation but BEFORE requests.
    engine = FakeEngine()
    cache = FakeCache()

    class FakeService:
        def __init__(self):
            self.engine = engine
            self.cache = cache

        def translate_batch(self, items):
            return [
                {
                    "id": item.id,
                    "ok": True,
                    "translated": f"[{item.text}]",
                    "from": item.from_lang,
                    "to": item.to_lang,
                    "provider": "fake",
                    "cacheHits": 0,
                }
                for item in items
            ]

        def translate_text(self, text, from_lang, to_lang):
            from app.core.service import Item

            return self.translate_batch([Item("t0", text, from_lang, to_lang)])[0]

    app.extensions["nst_service"] = FakeService()
    app.extensions["nst_engine"] = engine
    app.extensions["nst_cache"] = cache
    app.testing = True
    return app.test_client()


def test_health(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["status"] == "ok"
    assert body["providers"][0]["name"] == "fake"


def test_detect_endpoint(client):
    resp = client.post("/api/detect", json={"text": "今天天气不错"})
    assert resp.status_code == 200
    assert resp.get_json()["lang"] == "zh"


def test_translate_endpoint(client):
    resp = client.post(
        "/api/translate", json={"text": "hello world", "from": "en", "to": "zh"}
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["translated"] == "[hello world]"
    assert body["ok"] is True


def test_translate_bad_language(client):
    resp = client.post(
        "/api/translate", json={"text": "hi", "from": "en", "to": "xyz"}
    )
    assert resp.status_code == 422
    assert resp.get_json()["error"]["code"] == "BAD_LANGUAGE"


def test_batch_returns_request_order(client):
    resp = client.post(
        "/api/translate/batch",
        json={
            "items": [
                {"id": "z", "text": "first", "from": "en", "to": "zh"},
                {"id": "a", "text": "second", "from": "zh", "to": "en"},
            ]
        },
    )
    assert resp.status_code == 200
    ids = [item["id"] for item in resp.get_json()["results"]]
    assert ids == ["z", "a"]


def test_batch_validation(client):
    resp = client.post("/api/translate/batch", json={"items": "nope"})
    assert resp.status_code == 400
    resp = client.post("/api/translate/batch", json={"items": []})
    assert resp.status_code == 400


def test_missing_body_is_json_error(client):
    resp = client.post("/api/translate", data="not json", content_type="text/plain")
    assert resp.status_code == 400
    assert resp.get_json()["error"]["code"] == "BAD_REQUEST"


def test_api_404_is_json(client):
    resp = client.get("/api/does-not-exist")
    assert resp.status_code == 404
    assert "error" in resp.get_json()
