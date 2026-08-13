# App: persistent key-value store with write-ahead log

Build a small Python app (standard library only). A durable key-value store that
survives process restarts by appending every mutation to a log file and replaying
it on load.

## Required public API — must match EXACTLY
Module `kvstore.py` exposing:

```python
class KVStore:
    def __init__(self, path: str): ...       # opens/creates the store backed by file `path`
    def set(self, key: str, value: str) -> None: ...
    def get(self, key: str, default=None):   # returns stored value or `default` if absent
        ...
    def delete(self, key: str) -> bool:      # returns True if key existed and was removed, else False
        ...
    def keys(self) -> list:                  # current keys (any order)
        ...
```

Behaviour:
- String keys and values (values may contain spaces, newlines, unicode, `=`).
- `set` overwrites an existing key.
- Durability: after any `set`/`delete`, constructing a NEW `KVStore(path)` with the
  same path must recover the exact current state (append-only log, replayed on init).
- A fresh path (no file yet) starts empty.

## Deliverables
- `kvstore.py` with the class above.
- Your own tests (`python -m pytest`). Iterate until green, then call `done`.
