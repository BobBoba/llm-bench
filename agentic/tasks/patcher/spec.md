# App: unified-diff patcher

Build a small Python app (standard library only). It applies a unified diff to a
file the way `patch` does — including the awkward parts.

## Required public API — must match EXACTLY
Module `patcher.py` exposing:

```python
class PatchError(Exception):
    """Raised when a patch cannot be applied cleanly."""

def apply_patch(text: str, diff: str, reverse: bool = False) -> str:
    """Return the patched text. Never modifies `text` in place."""

def apply_to_file(path: str, diff: str, reverse: bool = False) -> None:
    """Apply the patch to the file at `path`, writing the result back."""
```

## Diff format

Standard unified diff: a `--- <old>` / `+++ <new>` header, then one or more hunks
introduced by `@@ -oldstart,oldcount +newstart,newcount @@`. Hunk body lines start
with a single character: `' '` context, `'-'` removed, `'+'` added. The counts may
be omitted when they are 1 (`@@ -3 +3 @@`).

## Behaviour that is checked

- **Several hunks in one diff** are applied in a single pass, in order.
- **Line numbers in hunk headers may be stale.** The file may have shifted by a few
  lines since the diff was produced. Locate each hunk by matching its context and
  removed lines, searching outward from the stated position; apply it at the position
  where it actually matches. Do not trust the header offset blindly.
- **Context must match exactly** (whitespace included). A hunk whose context matches
  nowhere is a failure.
- **Failure is atomic.** If any hunk fails, raise `PatchError` and leave the input
  completely untouched — `apply_patch` returns nothing and `apply_to_file` must not
  write a partial result. Never apply "the hunks that did work".
- **`reverse=True`** applies the diff backwards: `+` lines are removed and `-` lines
  restored. Applying a diff and then reversing it must return the original text.
- **Missing final newline.** A line followed by `\ No newline at end of file` has no
  trailing newline; this property must survive both forward and reverse application,
  on either side of the diff.
- **File creation and deletion.** `--- /dev/null` means the old text is empty; the
  result is the added lines. `+++ /dev/null` means the result is the empty string.
- Content is arbitrary text: unicode, empty lines, lines that themselves begin with
  `+`, `-` or `@` must all round-trip correctly.

## Deliverables
- `patcher.py` with the API above.
- Your own tests (`python -m pytest`). Iterate until green, then call `done`.
