# App: Todo REST API (in-process HTTP, JSON)

Build a small Python app (standard library only — use `http.server` and `json`).
An in-memory JSON REST API for todo items.

## Required public API — must match EXACTLY
Module `todoapp.py` exposing:

```python
def make_server(host: str = "127.0.0.1", port: int = 0):
    """Return a NON-started http.server.HTTPServer serving the todo API.
    The caller will run server.serve_forever() (typically in a thread).
    With port=0 the OS assigns a free port (read it from server.server_address[1])."""
```

Endpoints (all request/response bodies are JSON; set Content-Type: application/json):
- `GET /todos` -> 200, JSON array of todo objects.
- `POST /todos` with body `{"title": "..."}` -> 201, the created todo `{"id": <int>, "title": <str>, "done": false}`. Ids are integers assigned incrementally starting at 1.
- `GET /todos/<id>` -> 200 with the todo, or 404 if not found.
- `PATCH /todos/<id>` with body `{"done": true|false}` -> 200 with the updated todo, or 404 if not found.
- `DELETE /todos/<id>` -> 204 (empty body) if deleted, or 404 if not found.

State is in-memory (per server instance). Malformed JSON body on POST/PATCH -> 400.

## Deliverables
- `todoapp.py` with `make_server`.
- Your own tests (`python -m pytest`) — you can start the server in a thread. Iterate until green, then call `done`.
