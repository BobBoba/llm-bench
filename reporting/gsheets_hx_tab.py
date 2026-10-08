#!/usr/bin/env python3
"""Вкладка «omp vs codex 08.10» — сравнение двух агентских харнессов на одних и тех же моделях (Sol, Luna).

Источник: tts/results-hx.json (5 задач × 2 модели × 2 харнесса × 3 повтора, один выстрел на ячейку).
Цена — эквивалент по прейскуранту OpenRouter (у подписки реальная цена нулевая), одна формула для обоих харнессов.

Запуск:
    .venv-gsheets/bin/python reporting/gsheets_hx_tab.py --dry-run   # таблица в stdout
    .venv-gsheets/bin/python reporting/gsheets_hx_tab.py             # запись во вкладку (создаётся при отсутствии)
"""
import json
import os
import statistics
import sys

from googleapiclient.discovery import build

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gsheets_common as g  # noqa: E402

TAB = "omp vs codex 08.10"
DATA = os.path.join(HERE, "..", "tts", "results-hx.json")
MODELS = [("sol", "gpt-6.1-sol"), ("luna", "gpt-6-luna")]
HARNESSES = ["omp", "codex"]


def med(xs):
    return round(statistics.median(xs), 1)


def build_rows(d):
    rows = [["omp vs codex: одни и те же модели в двух агентских харнессах"],
            ["5 задач (Rust ×3, TS/bun ×2) × 3 повтора, effort=high, один выстрел на ячейку; «решено» = внешний оракул (сборка/тесты/смоук). "
             "Цена — эквивалент по прейскуранту OpenRouter (Sol $2/$10, Luna $0.10/$0.50 за 1M, кэш-чтение $0.10/$0.01); по подписке реальная цена нулевая."],
            [""],
            ["Модель", "Харнесс", "решено", "время, с (медиана)", "вход некэш (мед.)", "вход из кэша (мед.)", "выход (мед.)", "вызовов инструментов (мед.)", "цена, $ (сумма)", "цена, $ (медиана)"]]
    for key, title in MODELS:
        for h in HARNESSES:
            rs = [r for r in d if r["model"] == key and r["harness"] == h]
            rows.append([title, h, f"{sum(r['pass'] for r in rs)}/{len(rs)}", med([r["time_s"] for r in rs]),
                         int(med([r["tokens_in"] for r in rs])), int(med([r["tokens_cached"] for r in rs])),
                         int(med([r["tokens_out"] for r in rs])), med([r["tool_calls"] for r in rs]),
                         round(sum(r["est_usd"] for r in rs), 3), round(statistics.median(r["est_usd"] for r in rs), 4)])
    idx = {(r["harness"], r["model"], r["task"], r["repeat"]): r for r in d}
    rows += [[""], ["Парное сравнение (одна и та же модель, задача и повтор): codex / omp"],
             ["Модель", "время: медиана отношения", "цена: медиана отношения", "codex быстрее в", "решено omp", "решено codex"]]
    for key, title in MODELS:
        tr, cr, wins, n = [], [], 0, 0
        for (h, m, t, rp), r in idx.items():
            if h == "omp" and m == key and ("codex", m, t, rp) in idx:
                c = idx[("codex", m, t, rp)]
                tr.append(c["time_s"] / r["time_s"]); cr.append(c["est_usd"] / r["est_usd"])
                wins += c["time_s"] < r["time_s"]; n += 1
        so = sum(r["pass"] for r in d if r["model"] == key and r["harness"] == "omp")
        sc = sum(r["pass"] for r in d if r["model"] == key and r["harness"] == "codex")
        rows.append([title, round(statistics.median(tr), 2), round(statistics.median(cr), 2), f"{wins} из {n}", f"{so}/{n}", f"{sc}/{n}"])
    rows += [[""], ["По задачам: время, с (медиана по 3 повторам) omp → codex"],
             ["Задача"] + [f"{t} {h}" for _, t in MODELS for h in HARNESSES]]
    for task in sorted({r["task"] for r in d}):
        line = [task]
        for key, _ in MODELS:
            for h in HARNESSES:
                line.append(med([r["time_s"] for r in d if r["task"] == task and r["model"] == key and r["harness"] == h]))
        rows.append(line)
    rows += [[""], ["ПРИМЕЧАНИЯ"],
             ["Качество на этой батарее НЕ различает харнессы: 30/30 у каждой пары — задачи насыщены. Различаются время, число шагов и цена: codex быстрее omp в каждой из 30 парных ячеек."],
             ["Паритет: оба харнесса без личных расширений, навыков и правил оператора (omp --no-extensions --no-skills --no-rules; codex --ignore-user-config --ignore-rules), effort=high, одноразовая копия задачи. "
              "Codex запущен без песочницы (по явному решению владельца), omp — в режиме yolo. Базовый размер промпта первого хода сопоставим (~28k токенов у omp, ~31k у codex), "
              "разница в токенах и цене набегает от числа шагов агента: omp делает больше вызовов инструментов и перечитывает растущий контекст."],
             ["Сырые данные и код: tts/results-hx.json, tts/run-hx-bench.mjs, tts/ask.mjs (CLI для одной задачи в нескольких харнессах) в публичном репозитории llm-bench."]]
    return rows


def main():
    d = json.load(open(DATA))
    rows = build_rows(d)
    if "--dry-run" in sys.argv:
        for r in rows:
            print(" | ".join(str(c)[:60] for c in r))
        return
    sid = open(os.path.join(HERE, "gsheets-sheet-id.txt")).read().strip()
    svc = build("sheets", "v4", credentials=g.credentials(), cache_discovery=False)
    meta = svc.spreadsheets().get(spreadsheetId=sid, fields="sheets.properties(sheetId,title)").execute()
    if TAB not in [s["properties"]["title"] for s in meta["sheets"]]:
        svc.spreadsheets().batchUpdate(spreadsheetId=sid, body={"requests": [{"addSheet": {"properties": {"title": TAB}}}]}).execute()
    svc.spreadsheets().values().clear(spreadsheetId=sid, range=f"'{TAB}'").execute()
    svc.spreadsheets().values().update(spreadsheetId=sid, range=f"'{TAB}'!A1", valueInputOption="RAW", body={"values": rows}).execute()
    print(f"записано: {len(rows)} строк во вкладку «{TAB}»")


if __name__ == "__main__":
    main()
