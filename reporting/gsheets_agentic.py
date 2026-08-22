#!/usr/bin/env python3
"""Вкладка агентного app-bench: модель строит приложение, скрытый pytest его судит.

Читает agentic/results/<task>__<model>[__rN].json и СВОДИТ повторы в одну строку на пару
(задача, модель): средний исход, разброс по повторам, медианы шагов и времени. Без сведения
повторы выглядели бы как отдельные модели, а разница в пару процентов между соседними
строками — как результат.

Путь к результатам берётся от корня репозитория. Прежняя версия склеивала его от каталога
reporting/ и после реструктуризации b73f61d не находила НИЧЕГО — молча выводила пустую
таблицу вместо ошибки. Отсюда явная проверка «нет результатов» ниже.
"""
import glob
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from googleapiclient.discovery import build          # noqa: E402
from gsheets_common import credentials               # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RESULTS = os.path.join(ROOT, "agentic", "results")
# Серии с разным бюджетом лежат в подкаталогах: бюджет — параметр эксперимента,
# а не служебная деталь, поэтому обе серии показываем рядом, а не подменяем одну другой.
# Основная точка измерения лежит в results/; серии с другим бюджетом — в подкаталогах рядом.
# Бюджет вывода записан в каждом файле, поэтому группировка разведёт их сама, а не по каталогу.
RESULT_GLOBS = [os.path.join(RESULTS, "*__*.json"),
                os.path.join(RESULTS, "budget100k", "*__*.json")]
SID = open(os.path.join(HERE, "gsheets-sheet-id.txt")).read().strip()
TAB = "Agentic app-bench 23.07"

# Электричество по методике claudedocs/llm-cost-per-solution: 500 Вт под нагрузкой, €0.03/кВт·ч.
# У облачных строк в этом столбце реальная плата провайдеру; у локальных ставим сопоставимую
# величину, а не ноль — ноль не с чем сравнивать.
WATTS, PRICE_KWH = 500, 0.03

HEAD = [
    ["Агентная сборка приложений — результат судят СКРЫТЫЕ тесты. [[23.07.2026]]; локальные модели на арендованной RTX 5090 добавлены [[22.08.2026]]"],
    ["Модель строит приложение на стандартной библиотеке за много шагов (write_file / read_file / run / done, изоляция podman без сети), затем его оценивает набор pytest, которого модель не видела. Оценка объективна — в отличие от repo-task, где дифф судит эксперт"],
    ["Задачи полностью синтетические, поэтому арендованная карта здесь допустима. Локальные прогоны: окно 131072, KV q4_0, один слот, усилие рассуждения — умолчание модели, по три повтора на точку"],
    ["Столбец «разброс» — минимум и максимум исхода по повторам. Одинаковое среднее при разном разбросе означает разную надёжность, и это важнее среднего"],
    ["Столбец «отброшено» — прогоны, упёршиеся в потолок вывода. Они измеряют лимит, а не модель (рассуждение съедает бюджет до первого вызова инструмента), поэтому в среднее не входят. Ненулевое значение здесь — повод поднять бюджет и перемерить, а не вывод о модели"],
    [],
    ["Задача", "модель", "тип", "бюджет вывода", "исход %", "разброс", "повторов", "отброшено", "шагов", "время с", "стоимость $", "финал"],
]


def load():
    recs = [json.load(open(f)) for g in RESULT_GLOBS for f in sorted(glob.glob(g))]
    if not recs:
        raise SystemExit(f"нет результатов в {RESULTS} — проверьте путь или кампанию")
    groups = {}
    for r in recs:
        groups.setdefault((r["task"], r["model"], r["client"], r.get("max_tokens_out", 16000)), []).append(r)
    return groups


def agg(rs):
    # Прогон, упёршийся в потолок вывода, измеряет ЛИМИТ, а не модель: рассуждение съедает
    # бюджет до первого вызова инструмента, исход выходит нулевым. Включать такой ноль в среднее
    # нельзя — он занижает модель тем сильнее, чем подробнее та рассуждает. Считаем отдельно.
    # Отбрасываем не всякое отсечение, а только то, при котором модель НЕ УСПЕЛА НИЧЕГО СДЕЛАТЬ:
    # `budget_exhausted` описывает, как завершился цикл, а не была ли выполнена работа. Прогон,
    # где модель построила приложение за двенадцать шагов и лишь на последнем ушла в бесконечное
    # рассуждение, дал настоящие 19/19 — выбрасывать его значит терять измерение. Недействителен
    # случай `steps == 1`: рассуждение съело бюджет до первого вызова инструмента.
    valid = [r for r in rs
             if not (r.get("finished") == "budget_exhausted" and r.get("steps", 0) <= 1)]
    dropped = len(rs) - len(valid)
    if not valid:
        return {"n": 0, "dropped": dropped, "outcome": "—", "spread": "—",
                "steps": "—", "wall": "—", "cost": 0.0, "finished": "budget_exhausted"}
    out = [r["outcome_pct"] for r in valid]
    cost = [r["cost_usd"] or WATTS / 1000 * r["wall_s"] / 3600 * PRICE_KWH for r in valid]
    return {
        "n": len(valid),
        "dropped": dropped,
        "outcome": round(statistics.mean(out)),
        "spread": f"{min(out)}–{max(out)}" if len(out) > 1 and min(out) != max(out) else "—",
        "steps": round(statistics.median(r["steps"] for r in valid)),
        "wall": round(statistics.median(r["wall_s"] for r in valid), 1),
        "cost": statistics.mean(cost),
        "finished": ", ".join(sorted({r["finished"] for r in valid})),
    }


def read_conclusions():
    """Выводы лежат текстовым файлом рядом: правка формулировки не должна требовать правки кода."""
    p = os.path.join(HERE, "agentic-conclusions.txt")
    if not os.path.exists(p):
        return ["• (выводы не заполнены)"]
    return [ln.rstrip() for ln in open(p, encoding="utf-8") if ln.strip()]


def build_rows():
    groups = load()
    rows = list(HEAD)
    for (task, model, client, budget), rs in sorted(
            groups.items(),
            key=lambda kv: (kv[0][0], kv[0][3],
                            -(agg(kv[1])["outcome"] if isinstance(agg(kv[1])["outcome"], int) else -1))):
        a = agg(rs)
        rows.append([task, model, "локаль" if client == "local" else "облако", str(budget),
                     str(a["outcome"]), a["spread"], str(a["n"]), str(a["dropped"]),
                     str(a["steps"]), str(a["wall"]), "$%.4f" % a["cost"], a["finished"]])
    rows += [[], ["ВЫВОДЫ"]] + [[c] for c in read_conclusions()]
    return rows, groups


def main():
    rows, groups = build_rows()
    if "--dry-run" in sys.argv:
        for r in rows:
            print(" | ".join(str(x)[:36] for x in r))
        print(f"\nточек: {len(groups)}, строк: {len(rows)}")
        return
    ss = build("sheets", "v4", credentials=credentials()).spreadsheets()
    meta = ss.get(spreadsheetId=SID).execute()
    if TAB not in {s["properties"]["title"] for s in meta["sheets"]}:
        ss.batchUpdate(spreadsheetId=SID, body={"requests": [
            {"addSheet": {"properties": {"title": TAB}}}]}).execute()
    # Очистка, а НЕ удаление вкладки: удаление теряет ручное форматирование владельца,
    # а строк после сведения повторов стало меньше — без очистки остался бы хвост прежней версии.
    ss.values().clear(spreadsheetId=SID, range=f"'{TAB}'").execute()
    ss.values().update(spreadsheetId=SID, range=f"'{TAB}'!A1",
                       valueInputOption="RAW", body={"values": rows}).execute()
    print(f"OK: вкладка «{TAB}» записана ({len(rows)} строк, точек {len(groups)})")


if __name__ == "__main__":
    main()
