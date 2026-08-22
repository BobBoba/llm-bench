"""Скрытая оценка задачи patcher.

Тесты идут от простого к трудному намеренно: батарея calc/kvstore/todo-api насытилась —
все модели брали 100 %, и различать перестала. Здесь баллы частичные, поэтому строгий
результат виден как доля, а не как «сдал/не сдал».

Каждый тест проверяет требование, ЯВНО названное в spec.md. Ловушки честные: они не спрятаны,
их легко пропустить при беглом чтении — ровно как в реальном тикете.
"""
import os
import tempfile

import pytest

from patcher import PatchError, apply_patch, apply_to_file


def d(*lines):
    """Собрать диффом с завершающим переводом строки у каждой строки."""
    return "".join(l + "\n" for l in lines)


# ---------------------------------------------------------------- базовое

def test_single_hunk():
    text = d("alpha", "beta", "gamma")
    diff = d("--- a", "+++ b", "@@ -2 +2 @@", "-beta", "+BETA")
    assert apply_patch(text, diff) == d("alpha", "BETA", "gamma")


def test_multiple_hunks():
    text = d(*[f"line{i}" for i in range(1, 11)])
    diff = d("--- a", "+++ b",
             "@@ -2,1 +2,1 @@", "-line2", "+TWO",
             "@@ -9,1 +9,1 @@", "-line9", "+NINE")
    out = apply_patch(text, diff)
    assert out.splitlines()[1] == "TWO"
    assert out.splitlines()[8] == "NINE"
    assert len(out.splitlines()) == 10


def test_pure_insertion():
    text = d("a", "b")
    diff = d("--- a", "+++ b", "@@ -1,2 +1,3 @@", " a", "+inserted", " b")
    assert apply_patch(text, diff) == d("a", "inserted", "b")


def test_pure_deletion():
    text = d("a", "drop", "b")
    diff = d("--- a", "+++ b", "@@ -1,3 +1,2 @@", " a", "-drop", " b")
    assert apply_patch(text, diff) == d("a", "b")


# ------------------------------------------------- содержимое с сюрпризами

def test_content_lines_starting_with_markers():
    """Строки, сами начинающиеся с +, - и @, не должны путаться с разметкой диффа."""
    text = d("+plus", "-minus", "@@at", "tail")
    diff = d("--- a", "+++ b", "@@ -4 +4 @@", "-tail", "+TAIL")
    assert apply_patch(text, diff) == d("+plus", "-minus", "@@at", "TAIL")


def test_unicode_and_blank_lines():
    text = d("привет", "", "мир")
    diff = d("--- a", "+++ b", "@@ -3 +3 @@", "-мир", "+вселенная")
    assert apply_patch(text, diff) == d("привет", "", "вселенная")


# --------------------------------------------------- устаревшие смещения

def test_stale_offsets_shifted_down():
    """Файл уехал на 3 строки вниз; заголовок хунка врёт, контекст — нет."""
    text = d("new1", "new2", "new3", "alpha", "beta", "gamma")
    diff = d("--- a", "+++ b", "@@ -2,1 +2,1 @@", "-beta", "+BETA")
    assert apply_patch(text, diff) == d("new1", "new2", "new3", "alpha", "BETA", "gamma")


def test_stale_offsets_shifted_up():
    text = d("alpha", "beta", "gamma")
    diff = d("--- a", "+++ b", "@@ -42,1 +42,1 @@", "-gamma", "+GAMMA")
    assert apply_patch(text, diff) == d("alpha", "beta", "GAMMA")


# ------------------------------------------------------------ отказы

def test_context_mismatch_raises():
    text = d("alpha", "beta")
    diff = d("--- a", "+++ b", "@@ -1 +1 @@", "-nosuchline", "+x")
    with pytest.raises(PatchError):
        apply_patch(text, diff)


def test_failure_is_atomic():
    """Первый хунк подходит, второй нет — не должно примениться НИЧЕГО."""
    text = d("alpha", "beta", "gamma")
    diff = d("--- a", "+++ b",
             "@@ -1,1 +1,1 @@", "-alpha", "+ALPHA",
             "@@ -3,1 +3,1 @@", "-nosuchline", "+X")
    with pytest.raises(PatchError):
        apply_patch(text, diff)


def test_file_not_written_on_failure():
    text = d("alpha", "beta")
    diff = d("--- a", "+++ b",
             "@@ -1,1 +1,1 @@", "-alpha", "+ALPHA",
             "@@ -2,1 +2,1 @@", "-nope", "+X")
    dirp = tempfile.mkdtemp()
    p = os.path.join(dirp, "f.txt")
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(text)
    with pytest.raises(PatchError):
        apply_to_file(p, diff)
    with open(p, encoding="utf-8") as fh:
        assert fh.read() == text, "файл изменён несмотря на неудачу"


# ------------------------------------------------------------ обратное

def test_reverse_round_trip():
    text = d("alpha", "beta", "gamma")
    diff = d("--- a", "+++ b", "@@ -2 +2 @@", "-beta", "+BETA")
    patched = apply_patch(text, diff)
    assert apply_patch(patched, diff, reverse=True) == text


def test_reverse_multi_hunk_round_trip():
    text = d(*[f"l{i}" for i in range(1, 9)])
    diff = d("--- a", "+++ b",
             "@@ -2,1 +2,2 @@", "-l2", "+L2", "+L2b",
             "@@ -7,1 +8,1 @@", "-l7", "+L7")
    patched = apply_patch(text, diff)
    assert apply_patch(patched, diff, reverse=True) == text


# ------------------------------------------- отсутствующий перевод строки

def test_no_newline_at_eof_preserved():
    text = "alpha\nbeta"                      # без завершающего перевода строки
    diff = ("--- a\n+++ b\n@@ -2 +2 @@\n-beta\n"
            "\\ No newline at end of file\n+BETA\n"
            "\\ No newline at end of file\n")
    assert apply_patch(text, diff) == "alpha\nBETA"


def test_newline_added_at_eof():
    text = "alpha\nbeta"
    diff = ("--- a\n+++ b\n@@ -2 +2 @@\n-beta\n"
            "\\ No newline at end of file\n+beta\n")
    assert apply_patch(text, diff) == "alpha\nbeta\n"


# ------------------------------------------------ создание и удаление

def test_create_from_dev_null():
    diff = d("--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1,2 @@", "+first", "+second")
    assert apply_patch("", diff) == d("first", "second")


def test_delete_to_dev_null():
    text = d("only", "lines")
    diff = d("--- a/old.txt", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-only", "-lines")
    assert apply_patch(text, diff) == ""


# ------------------------------------------------------------ файловый путь

def test_apply_to_file_writes_result():
    text = d("alpha", "beta")
    diff = d("--- a", "+++ b", "@@ -2 +2 @@", "-beta", "+BETA")
    dirp = tempfile.mkdtemp()
    p = os.path.join(dirp, "f.txt")
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(text)
    apply_to_file(p, diff)
    with open(p, encoding="utf-8") as fh:
        assert fh.read() == d("alpha", "BETA")


def test_input_string_not_mutated():
    text = d("alpha", "beta")
    diff = d("--- a", "+++ b", "@@ -2 +2 @@", "-beta", "+BETA")
    apply_patch(text, diff)
    assert text == d("alpha", "beta")
