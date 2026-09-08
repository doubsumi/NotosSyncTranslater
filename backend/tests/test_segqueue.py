"""Segment queue (per-document sentence cache) tests — no network."""
import time

import pytest

from app import create_app
from app.config import Config
from app.core.segdoc import SegmentQueue


def fake_ensure(text: str, from_lang: str, to_lang: str):
    return f"[{from_lang}>{to_lang}] {text}", "fake"


def make_queue(**kw) -> SegmentQueue:
    return SegmentQueue(ensure_fn=fake_ensure, **kw)


# ---------------------------------------------------------------------------
# Unit tests
# ---------------------------------------------------------------------------
def test_open_and_sync_translates_and_answers_from_queue():
    calls: list[str] = []

    def counting(text, *_):
        calls.append(text)
        return f"[{text}]", "fake"

    q = SegmentQueue(ensure_fn=counting)
    res = q.sync_segments(
        "doc-1", "en", "zh", [{"sid": 0, "text": "Hello world."}], alive=[0]
    )
    assert res[0]["ok"] is True
    assert res[0]["cache"] is False
    assert res[0]["translated"] == "[Hello world.]"
    assert len(calls) == 1

    # Same sid + same text again -> served from the queue, no ensure call.
    res2 = q.sync_segments("doc-1", "en", "zh", [{"sid": 0, "text": "Hello world."}], alive=[0])
    assert res2[0]["ok"] is True
    assert res2[0]["cache"] is True
    assert len(calls) == 1


def test_edited_sentence_same_sid_replaces_content():
    q = make_queue()
    q.sync_segments("doc-1", "en", "zh", [{"sid": 3, "text": "Old."}], alive=[3])
    res = q.sync_segments("doc-1", "en", "zh", [{"sid": 3, "text": "New."}], alive=[3])
    assert res[0]["ok"] is True
    assert res[0]["cache"] is False
    assert res[0]["translated"] == "[en>zh] New."


def test_alive_prunes_removed_sentences():
    q = make_queue()
    q.sync_segments("doc-1", "en", "zh", [{"sid": 1, "text": "A."}], alive=[1])
    q.sync_segments("doc-1", "en", "zh", [{"sid": 2, "text": "B."}], alive=[1, 2])
    q.sync_segments("doc-1", "en", "zh", [{"sid": 2, "text": "B."}], alive=[2])
    doc = q.get("doc-1")
    assert set(doc.segments.keys()) == {2}


def test_lang_change_retranslates_same_doc():
    q = make_queue()
    q.sync_segments("doc-1", "en", "zh", [{"sid": 0, "text": "Hi."}], alive=[0])
    res = q.sync_segments("doc-1", "en", "fr", [{"sid": 0, "text": "Hi."}], alive=[0])
    assert res[0]["translated"] == "[en>fr] Hi."


def test_ttl_eviction():
    q = make_queue(ttl_seconds=10)
    q.sync_segments("doc-1", "en", "zh", [{"sid": 0, "text": "A."}], alive=[0])
    assert q.stats()["docs"] == 1
    # Age the doc past its TTL.
    q._docs["doc-1"].updated = time.monotonic() - 20  # type: ignore[index]
    q.sync_segments("doc-2", "en", "zh", [{"sid": 0, "text": "B."}], alive=[0])
    assert q.get("doc-1") is None
    assert q.stats()["docs"] == 1


def test_per_item_failure_isolation():
    def flaky(text, *_):
        if text.startswith("bad"):
            raise RuntimeError("boom")
        return f"ok:{text}", "fake"

    q = SegmentQueue(ensure_fn=flaky)
    res = q.sync_segments(
        "doc-1", "en", "zh",
        [{"sid": 0, "text": "good"}, {"sid": 1, "text": "bad"}],
        alive=[0, 1],
    )
    assert res[0]["ok"] is True
    assert res[1]["ok"] is False
    assert res[1]["error"]["code"] == "TRANSLATION_FAILED"


# ---------------------------------------------------------------------------
# HTTP endpoint tests
# ---------------------------------------------------------------------------
@pytest.fixture()
def client():
    cfg = Config()
    cfg.cors_origins = ()
    cfg.rate_limit_per_minute = 100000
    cfg.rate_limit_burst = 100000
    app = create_app(cfg)
    app.extensions["nst_segqueue"] = make_queue()
    app.testing = True
    return app.test_client()


def test_sync_endpoint_roundtrip(client):
    body = {
        "doc": "d-1",
        "from": "en",
        "to": "zh",
        "items": [{"sid": 0, "text": "First sentence."}, {"sid": 1, "text": "Second."}],
        "alive": [0, 1],
    }
    resp = client.post("/api/docs/d-1/segments/sync", json=body)
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["doc"] == "d-1"
    assert [r["sid"] for r in data["results"]] == [0, 1]
    assert all(r["ok"] for r in data["results"])

    # Repeat -> cached from the server queue.
    resp2 = client.post("/api/docs/d-1/segments/sync", json=body)
    assert all(r["cache"] is True for r in resp2.get_json()["results"])


def test_sync_endpoint_validation(client):
    # Empty items with a valid pair -> BAD_REQUEST.
    resp = client.post(
        "/api/docs/d-1/segments/sync",
        json={"from": "en", "to": "zh", "items": []},
    )
    assert resp.status_code == 400
    resp = client.post(
        "/api/docs/bad id!/segments/sync",
        json={"from": "en", "to": "zh", "items": [{"sid": 0, "text": "x"}]},
    )
    assert resp.status_code == 400
    resp = client.post(
        "/api/docs/d-1/segments/sync",
        json={"from": "en", "to": "zh", "items": [{"sid": -1, "text": "x"}]},
    )
    assert resp.status_code == 400
    resp = client.post(
        "/api/docs/d-1/segments/sync",
        json={"items": [{"sid": 0, "text": "x"}], "from": "en", "to": "klingon"},
    )
    assert resp.status_code == 422
