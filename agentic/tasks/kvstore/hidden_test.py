import os
import tempfile
import pytest
from kvstore import KVStore


@pytest.fixture
def path():
    d = tempfile.mkdtemp()
    yield os.path.join(d, "store.log")


def test_set_get(path):
    s = KVStore(path)
    s.set("a", "1")
    s.set("b", "two")
    assert s.get("a") == "1"
    assert s.get("b") == "two"


def test_missing_default(path):
    s = KVStore(path)
    assert s.get("nope") is None
    assert s.get("nope", "d") == "d"


def test_overwrite(path):
    s = KVStore(path)
    s.set("k", "old")
    s.set("k", "new")
    assert s.get("k") == "new"


def test_delete(path):
    s = KVStore(path)
    s.set("k", "v")
    assert s.delete("k") is True
    assert s.get("k") is None
    assert s.delete("k") is False


def test_keys(path):
    s = KVStore(path)
    s.set("x", "1")
    s.set("y", "2")
    assert set(s.keys()) == {"x", "y"}
    s.delete("x")
    assert set(s.keys()) == {"y"}


def test_persistence_across_reload(path):
    s = KVStore(path)
    s.set("a", "1")
    s.set("b", "2")
    s.set("a", "overwritten")
    s.delete("b")
    s.set("c", "line1\nline2 = ok  спасибо")
    del s
    s2 = KVStore(path)
    assert s2.get("a") == "overwritten"
    assert s2.get("b") is None
    assert s2.get("c") == "line1\nline2 = ok  спасибо"
    assert set(s2.keys()) == {"a", "c"}


def test_fresh_empty(path):
    assert KVStore(path).keys() == [] or set(KVStore(path).keys()) == set()
