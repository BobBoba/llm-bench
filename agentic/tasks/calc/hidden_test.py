import math
import pytest
from calc import evaluate


def approx(a, b):
    return math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-9)


def test_basic():
    assert approx(evaluate("2+3"), 5)
    assert approx(evaluate("10-4"), 6)


def test_precedence():
    assert approx(evaluate("2+3*4"), 14)
    assert approx(evaluate("2*3+4"), 10)
    assert approx(evaluate("2+3*4-1"), 13)


def test_parens():
    assert approx(evaluate("(2+3)*4"), 20)
    assert approx(evaluate("2*(3+4)*2"), 28)


def test_division_float():
    assert approx(evaluate("10/4"), 2.5)
    assert approx(evaluate("1/2+1/2"), 1.0)


def test_unary_minus():
    assert approx(evaluate("-5+3"), -2)
    assert approx(evaluate("-(2+3)"), -5)
    assert approx(evaluate("3*-2"), -6)


def test_decimals_and_ws():
    assert approx(evaluate("  3.5 +  .5 "), 4.0)


def test_malformed_raises():
    for bad in ["", "2+", "(2+3", "2 3", "2**3", "abc", "2+*3"]:
        with pytest.raises(ValueError):
            evaluate(bad)


def test_div_zero_raises():
    with pytest.raises(ValueError):
        evaluate("1/0")
