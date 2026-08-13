import json
import threading
import urllib.request
import urllib.error
import pytest
from todoapp import make_server


@pytest.fixture
def base():
    srv = make_server("127.0.0.1", 0)
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{port}"
    srv.shutdown()


def req(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    try:
        # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        # Test-only: URL is always http://127.0.0.1:<ephemeral-port> from the local fixture,
        # never external/attacker input; benchmark harness, not production.
        with urllib.request.urlopen(r, timeout=5) as resp:  # noqa
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, (json.loads(raw) if raw else None)
        except Exception:
            return e.code, None


def test_empty_list(base):
    st, body = req("GET", f"{base}/todos")
    assert st == 200 and body == []


def test_create_and_get(base):
    st, t = req("POST", f"{base}/todos", {"title": "buy milk"})
    assert st == 201
    assert t["id"] == 1 and t["title"] == "buy milk" and t["done"] is False
    st, got = req("GET", f"{base}/todos/1")
    assert st == 200 and got == t


def test_incrementing_ids_and_list(base):
    req("POST", f"{base}/todos", {"title": "a"})
    st, t2 = req("POST", f"{base}/todos", {"title": "b"})
    assert t2["id"] == 2
    st, lst = req("GET", f"{base}/todos")
    assert st == 200 and len(lst) == 2


def test_patch_done(base):
    req("POST", f"{base}/todos", {"title": "x"})
    st, upd = req("PATCH", f"{base}/todos/1", {"done": True})
    assert st == 200 and upd["done"] is True
    st, got = req("GET", f"{base}/todos/1")
    assert got["done"] is True


def test_delete(base):
    req("POST", f"{base}/todos", {"title": "x"})
    st, _ = req("DELETE", f"{base}/todos/1")
    assert st == 204
    st, _ = req("GET", f"{base}/todos/1")
    assert st == 404


def test_404s(base):
    assert req("GET", f"{base}/todos/999")[0] == 404
    assert req("PATCH", f"{base}/todos/999", {"done": True})[0] == 404
    assert req("DELETE", f"{base}/todos/999")[0] == 404
