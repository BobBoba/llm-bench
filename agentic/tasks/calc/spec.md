# App: arithmetic expression evaluator (library + CLI)

Build a small Python app (standard library only).

## Required public API — must match EXACTLY
Module `calc.py` exposing:

```python
def evaluate(expr: str) -> float:
    """Evaluate an arithmetic expression string and return the numeric result."""
```

Supported grammar:
- Integer and decimal literals (e.g. `3`, `3.5`, `.5`).
- Binary operators `+ - * /` with standard precedence (`*`/`/` bind tighter than `+`/`-`), left-associative.
- Parentheses `( )` for grouping.
- Unary minus (e.g. `-5`, `-(2+3)`).
- Arbitrary whitespace between tokens.
- Division is floating-point (`10 / 4 == 2.5`).

Errors: on a malformed expression (empty, unbalanced parentheses, unexpected token, trailing garbage, division by zero) raise `ValueError`.

## CLI
`python -m calc` reads ONE line from stdin, prints the numeric result to stdout, or prints `error` (and exits non-zero) on a malformed expression.

## Deliverables
- `calc.py` with `evaluate` and CLI (`if __name__ == '__main__'` or `__main__.py`).
- Your own tests. Run them with `python -m pytest`. Iterate until green, then call `done`.
