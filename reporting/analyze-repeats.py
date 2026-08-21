#!/usr/bin/env python3
"""Разбор ночных прогонов на 5090 с честной оценкой значимости.

ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ. Первый заход дал «KV q4_0 — 17/22, KV q8_0 — 15/22», и соблазн
объявить грубый кэш лучшим велик. Но при трёх повторах на задачу у каждой конфигурации
66 измерений, и разницу надо мерить, а не разглядывать: считаем долю решённых, стандартную
ошибку доли и разницу в единицах этой ошибки. Меньше двух ошибок — разницы не показано.
"""
import glob, json, math, os, sys

def load(path):
    d = json.load(open(path))
    return d if isinstance(d, list) else d.get("records", d.get("results", []))

def stats(recs):
    n = len(recs)
    soi = sum(1 for r in recs if r.get("solved"))
    p = soi / n if n else 0
    se = math.sqrt(p * (1 - p) / n) if n else 0
    tps = [r["tokps"] for r in recs if r.get("tokps")]
    # pct — частичный балл (доля пройденных скрытых тестов), чувствительнее бинарного «решено»
    pct = [r.get("pct") for r in recs if isinstance(r.get("pct"), (int, float))]
    return {"n": n, "solved": soi, "p": p, "se": se,
            "tps": sum(tps) / len(tps) if tps else 0,
            "pct": sum(pct) / len(pct) if pct else None,
            "gate": sum(1 for r in recs if r.get("gate"))}

def main():
    pattern = sys.argv[1] if len(sys.argv) > 1 else "/code/work/llm-bench/results/results-EXP-5090r-*.json"
    out = {}
    for f in sorted(glob.glob(pattern)):
        name = os.path.basename(f).replace("results-EXP-5090r-", "").replace(".json", "")
        out[name] = stats(load(f))
    print(f"{'конфигурация':<10} {'решено':>10} {'доля':>7} {'ошибка':>7} {'частич.':>8} {'гейт':>6} {'т/с':>7}")
    for k, v in out.items():
        pct = f"{v['pct']:.3f}" if v["pct"] is not None else "  —  "
        print(f"{k:<10} {v['solved']:>4}/{v['n']:<5} {v['p']:>7.3f} {v['se']:>7.3f} {pct:>8} {v['gate']:>6} {v['tps']:>7.1f}")

    keys = list(out)
    print("\nпопарные сравнения (разница в стандартных ошибках; <2 — различие НЕ показано):")
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            a, b = out[keys[i]], out[keys[j]]
            se = math.sqrt(a["se"] ** 2 + b["se"] ** 2)
            z = (a["p"] - b["p"]) / se if se else 0
            verdict = "различие показано" if abs(z) >= 2 else "в пределах шума"
            print(f"  {keys[i]:<10} против {keys[j]:<10} разница {a['p']-b['p']:+.3f} = {z:+.2f} ошибки — {verdict}")

if __name__ == "__main__":
    main()
