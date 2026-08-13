"""Добавляет колонку «время до решения» на вкладки RUST / TypeScript / humanitarian — PURE Google Sheet.

МЕТРИКА (та же, что на вкладке «RUST time-to-correct», построенной gsheets_ttc.py):
  * кодовые вкладки (RUST, TypeScript): для каждой задачи берём время САМОГО БЫСТРОГО КОРРЕКТНОГО
    одношота (скрытые тесты ≥ 99.9%); если одношотом задача не решена — wall-clock агентского
    цикла, при условии что он дошёл до зелёного. Итог по модели — медиана по задачам.
    Это реалистичный путь агента: «пробуем одношотом, при провале уходим в tool-loop».
    Задачи, не решённые НИ одним способом, из медианы выпадают — иначе метрика смешивала бы
    «долго, но решил» с «не решил вообще», что уже отражено колонками S% / A%.
  * humanitarian: объективного оракула корректности нет (судья ставит 0–10), поэтому там
    считается медианная задержка ответа по пяти осям. Колонка названа ИНАЧЕ («время ответа, с»),
    чтобы читатель не принял её за то же измерение, что на кодовых вкладках.

ИСТОЧНИК ДАННЫХ — все файлы results/results-*.json. Батарея определяется по СОДЕРЖИМОМУ записи,
а не по имени файла (имена исторически несистемны: results-ts.json, results-cloud-ts.json,
results-dsbench-run-ts-ds.json …): TS-запись имеет поле `typechecks`, RUST-запись — `compiles`,
гуманитарная — `axis`. Дубли между файлами снимаются по ключу model|mode|task|run.

СОПОСТАВЛЕНИЕ ИМЁН — главная сложность. В таблице имена частично автоматические (`short(mid)`),
частично рукописные (`DS-V3.2`, `Sonnet-5`, `Fable 5 (CC sub)`). Матчинг двухступенчатый:
нормализация (нижний регистр, только буквы и цифры) плюс явный ALIASES для рукописных случаев.
Модели, которым не нашлось данных, оставляются ПУСТЫМИ и перечисляются в отчёте — подставлять
чужое значение хуже, чем не подставить никакого.

    .venv-gsheets/bin/python gsheets_add_ttc_column.py --dry-run   # только отчёт о сопоставлении
    .venv-gsheets/bin/python gsheets_add_ttc_column.py             # запись в таблицу
"""
import os
import re
import sys
import glob
import json
import statistics
from collections import defaultdict
from googleapiclient.discovery import build
from gsheets_common import credentials

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "results")
SID = open(os.path.join(HERE, "gsheets-sheet-id.txt")).read().strip()
CORR = 0.999                                  # порог «корректно» — доля пройденных скрытых тестов

HEADER_CODE = "время до решения, с"
HEADER_HUM = "время ответа, с"
DOC_CODE = ("Медианное время до КОРРЕКТНОГО решения по задачам батареи: для решённых одношотом — "
            "самый быстрый корректный прогон, иначе — wall-clock агентского цикла (реалистичный путь "
            "«одношот, при провале tool-loop»). Задачи, не решённые ни одним способом, в медиану не "
            "входят. Секунды. Парная величина к «$/задача»: там цена, здесь время.")
DOC_HUM = ("Медианная задержка ответа по пяти осям. ВНИМАНИЕ: на этой вкладке нет оракула "
           "корректности (судья ставит 0–10), поэтому величина НЕ равна «времени до решения» "
           "кодовых вкладок — здесь это просто время ответа. Секунды.")

# Рукописные имена строк, которые нормализация не сводит к идентификатору модели.
# Ключ — имя в первом столбце таблицы (сравнивается ПОСЛЕ нормализации, поэтому украшения
# вида «⭐» в ключе писать не нужно), значение — идентификатор в файлах результатов.
ALIASES = {
    "DS-V3.2": "deepseek/deepseek-v3.2",
    "DeepSeek-V3.2": "deepseek/deepseek-v3.2",
    "DS-V4-Pro": "deepseek/deepseek-v4-pro",
    "DS-V4-Flash": "deepseek/deepseek-v4-flash",
    "Sonnet-5": "anthropic/claude-sonnet-5",
    "Fable 5 (CC sub)": "claude-fable-5",
    "Nemotron-Cascade-30B": "nvidia_nemotron-cascade-2-30b-a3b",
    "Nemotron3-Nano": "nvidia/nemotron-3-nano",
    "Nemotron-3-Nano": "nvidia/nemotron-3-nano",
    "Ministral-3-14B": "mistralai/ministral-3-14b-reasoning",
    "Qwen3-30B-A3B": "qwen/qwen3-30b-a3b-2507",
    "Qwen3.6-35B-Heretic": "qwen3.6-35b-a3b-uncensored-heretic-native-mtp-preserved-nvfp4-experts-only",
    "Agents-A1-35B": "agents-a1",
    # ! Идентификаторы ниже взяты не по догадке, а из самих июньских агрегатов
    #   (/code/src/zdr-*-bench/results-*.json, поля short/id) — чтобы строка таблицы получила
    #   время ТОЙ ЖЕ модели, что измерялась в июне, а не похожей по названию.
    "Qwen3-Coder-480B": "qwen/qwen3-coder",
    "Qwen3-235B": "qwen/qwen3-235b-a22b-2507",
    "Qwen3.5-122B": "qwen/qwen3.5-122b-a10b",
    "Nemotron3-Super": "nvidia/nemotron-3-super-120b-a12b",
    "Nemotron3-Ultra": "nvidia/nemotron-3-ultra-550b-a55b",
    "Trinity-Lg-Think": "arcee-ai/trinity-large-thinking",
    # Локальные строки Unsloth Studio: имя в таблице сделано читаемым (`gsheets_add_models.DISPLAY`),
    # поэтому с идентификатором репозитория оно не совпадает даже после нормализации.
    "Seed-OSS-36B UD-Q4_K_XL": "unsloth/Seed-OSS-36B-Instruct-GGUF:UD-Q4_K_XL",
    "Seed-OSS-36B UD-Q3_K_XL": "unsloth/Seed-OSS-36B-Instruct-GGUF:UD-Q3_K_XL",
    "Gemma-4-31B-QAT UD-Q4_K_XL": "unsloth/gemma-4-31B-it-qat-GGUF:UD-Q4_K_XL",
    "Apriel-1.5-15B-Thinker UD-Q8_K_XL": "unsloth/Apriel-1.5-15b-Thinker-GGUF:UD-Q8_K_XL",
    "AgentWorld-35B UD-Q3_K_XL": "unsloth/Qwen-AgentWorld-35B-A3B-GGUF:UD-Q3_K_XL",
    "Qwen3-Coder-Next UD-Q4_K_M": "unsloth/Qwen3-Coder-Next-GGUF:UD-Q4_K_M",
    # Строка переименована [[04.08.2026]]: прежнее имя `Qwen3-Coder-Next` не несло ни кванта,
    # ни движка и рядом с UD-строкой читалось так, будто различается только движок. На деле
    # это плоский Q4_K_M на голом llama-server с KV q8_0 — три отличия сразу.
    "Qwen3-Coder-Next Q4_K_M (llama.cpp)": "qwen3-coder-next",
    "Opus-4.8": "anthropic/claude-opus-4.8",
    "Sonnet-4.6": "anthropic/claude-sonnet-4.6",
    "Haiku-4.5": "anthropic/claude-haiku-4.5",
}

# Строки, которые ОСОЗНАННО оставляем пустыми.
# `gpt-oss-20b (loc)` — локальный прогон той же модели через LM Studio; в сырых результатах он
# записан тем же идентификатором `openai/gpt-oss-20b`, что и облачный, поэтому отличить их
# невозможно. Подставить одно из двух значений наугад — хуже, чем оставить пусто.
EXPECTED_MISSING = {"gpt-oss-20b (loc)"}

# Украшения имён в таблице, не относящиеся к идентификатору модели.
DECOR = re.compile(r"(⭐\s*ag|⭐|\(эталон\)|\bref\b|\(CC sub\))", re.IGNORECASE)


def norm(s):
    """Нормализация имени: снимаем украшения, берём последний сегмент пути, оставляем [a-z0-9]."""
    s = DECOR.sub("", str(s)).lstrip("~").split("/")[-1].lower()
    return re.sub(r"[^a-z0-9]", "", s)


def med(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 1) if xs else None


def gather(verbose=False):
    """Читает все результаты и раскладывает записи по батареям ПО СОДЕРЖИМОМУ записи.

    ! Одна и та же модель нередко прогонялась НЕСКОЛЬКО раз в разных конфигурациях (другое
    железо, другой движок инференса, повторный прогон после починки харнесса), и все файлы
    лежат в results/ с ОДИНАКОВЫМИ ключами (model|mode|task|run). Времена при этом расходятся
    кратно: у `ornith-1.0-35b` агентский цикл занимал 21.7 / 32.3 / 50.6 с в трёх разных
    прогонах. Брать «какой попадётся» нельзя — значение тогда определяет порядок чтения файлов.
    Правило: ПОБЕЖДАЕТ ПОСЛЕДНИЙ ПО ВРЕМЕНИ ПРОГОН (файлы читаются от новых к старым, первое
    вхождение ключа выигрывает) — повторный прогон считается уточняющим предыдущий. Все
    конфликты перечисляются в отчёте, чтобы подмена не осталась незаметной.
    """
    buckets = {"rust": [], "ts": [], "know": []}
    seen = {}
    conflicts = defaultdict(set)
    files = sorted(glob.glob(os.path.join(RES, "results-*.json")),
                   key=lambda p: os.path.getmtime(p), reverse=True)
    for f in files:
        try:
            data = json.load(open(f))
        except Exception:
            continue
        if not isinstance(data, list):
            continue
        for r in data:
            if not isinstance(r, dict) or "model" not in r:
                continue
            if "axis" in r:
                kind = "know"
            elif "typechecks" in r:
                kind = "ts"
            elif "compiles" in r:
                kind = "rust"
            else:
                continue                      # tool-use / long-ctx / прочие харнессы — не наша метрика
            key = (kind, r.get("model"), r.get("mode"), r.get("task"), r.get("run"), r.get("axis"))
            if key in seen:
                if seen[key] != os.path.basename(f):
                    conflicts[(kind, r.get("model"))].add(os.path.basename(f))
                continue
            seen[key] = os.path.basename(f)
            buckets[kind].append(r)
    if verbose and conflicts:
        print("\nМОДЕЛИ С ПОВТОРНЫМИ ПРОГОНАМИ (взят самый свежий файл, остальные отброшены):")
        for (kind, mid), files_ in sorted(conflicts.items()):
            print(f"    [{kind}] {mid}: отброшено {', '.join(sorted(files_))}")
    return buckets


NEVER = "n/a"        # записи есть, но ни одной задачи модель не довела до корректного решения
MIN_TASKS = 3        # полный набор задач батареи (expr / lru / wordcount и expr / lru / asyncpool)


def ttc_by_model(rows):
    """model -> медиана времени до корректного решения (одношот, иначе агентский цикл).

    ! Различаем два разных «нет значения»: модель ПРОБОВАЛА и ни разу не решила (возвращаем
    NEVER — это факт о модели) против «данных о модели нет вовсе» (ключа в словаре не будет —
    ячейка останется пустой). Смешивать их нельзя: пустая ячейка и «не справилась» —
    противоположные утверждения.
    """
    per_model = defaultdict(lambda: defaultdict(lambda: {"s": [], "a": None}))
    for r in rows:
        slot = per_model[r["model"]][r.get("task")]
        if r.get("mode") == "single":
            slot["s"].append(r)
        elif r.get("mode") == "agentic" and r.get("ok") and not r.get("err"):
            slot["a"] = r
    out = {}
    for mid, tasks in per_model.items():
        times = []
        for _, d in tasks.items():
            ok = [x for x in d["s"] if (x.get("pct") or 0) >= CORR and x.get("latency")]
            if ok:
                times.append(min(x["latency"] for x in ok))
            elif d["a"] and (d["a"].get("pct") or 0) >= CORR and d["a"].get("latency"):
                times.append(d["a"]["latency"])
        if times:
            out[mid] = med(times)
        elif len(tasks) >= MIN_TASKS:
            # Батарея пройдена целиком, корректного решения нет ни по одной задаче — это факт о
            # модели, пишем n/a.
            out[mid] = NEVER
        # ! Иначе (задач меньше полного набора) значения НЕ выдаём вовсе — ячейка останется пустой.
        #   Так бывает, когда модель вылетела по тайм-ауту клиента и раннер пропустил остаток её
        #   задач (`skipped_after_timeout`): например minimax/minimax-m2.5 дважды не уложилась в
        #   1200 с на задаче `lru`. Написать там n/a значило бы утверждать «пробовала и не решила»,
        #   тогда как на деле мы просто не измерили две задачи из трёх.
    return out


def latency_by_model(rows):
    """model -> медианная задержка ответа (гуманитарная батарея, без оракула корректности)."""
    per = defaultdict(list)
    for r in rows:
        if r.get("ok") and r.get("latency"):
            per[r["model"]].append(r["latency"])
    return {m: med(v) for m, v in per.items() if med(v) is not None}


ALIAS_BY_NORM = {norm(k): v for k, v in ALIASES.items()}


def resolve(names, values):
    """Сопоставляет имена строк таблицы с идентификаторами моделей. -> (значения, не найденные)."""
    by_norm = {}
    for mid, v in values.items():
        by_norm.setdefault(norm(mid), v)
    resolved, missing = {}, []
    for nm in names:
        if nm in EXPECTED_MISSING:
            missing.append(nm)
            continue
        mid = ALIAS_BY_NORM.get(norm(nm))
        v = values.get(mid) if mid else None
        if v is None:
            v = by_norm.get(norm(nm))
        if v is None and mid:
            v = by_norm.get(norm(mid))
        if v is None:
            missing.append(nm)
        else:
            resolved[nm] = v
    return resolved, missing


def main():
    dry = "--dry-run" in sys.argv
    b = gather(verbose=True)
    vals = {
        "RUST": ttc_by_model(b["rust"]),
        "TypeScript": ttc_by_model(b["ts"]),
        "humanitarian": latency_by_model(b["know"]),
    }
    print(f"записей: rust={len(b['rust'])} ts={len(b['ts'])} knowledge={len(b['know'])}")
    print("моделей с метрикой: " + ", ".join(f"{k}={len(v)}" for k, v in vals.items()))

    ss = build("sheets", "v4", credentials=credentials()).spreadsheets()
    meta = ss.get(spreadsheetId=SID,
                  fields="sheets(properties(title,sheetId),tables(tableId,range))").execute()
    tabs = {sh["properties"]["title"]: sh for sh in meta["sheets"]}

    plan = []
    for tab in ("RUST", "TypeScript", "humanitarian"):
        cur = ss.values().get(spreadsheetId=SID, range=f"'{tab}'!A1:AA400",
                              valueRenderOption="UNFORMATTED_VALUE").execute().get("values", [])
        header = cur[0]
        names = [str(r[0]).strip() for r in cur[1:] if r and str(r[0]).strip()]
        want = HEADER_CODE if tab != "humanitarian" else HEADER_HUM
        if want in header:
            col = header.index(want)           # идемпотентность: колонка есть -> обновляем её
        else:
            col = len(header)                  # иначе — первая свободная справа
        resolved, missing = resolve(names, vals[tab])
        noisy = [m for m in missing if m not in EXPECTED_MISSING]
        print(f"\n=== {tab}: строк {len(names)}, сопоставлено {len(resolved)}, "
              f"без данных {len(missing)} (колонка {chr(65+col)}{'' if want in header else ' — новая'})")
        if noisy:
            print("    БЕЗ ДАННЫХ (останутся пустыми): " + ", ".join(noisy))
        plan.append((tab, col, header, names, resolved, want))

    if dry:
        print("\n--dry-run: в таблицу ничего не записано")
        return

    for tab, col, header, names, resolved, want in plan:
        a1col = chr(65 + col) if col < 26 else "A" + chr(65 + col - 26)
        body = [[want]] + [[resolved.get(nm, "")] for nm in names]
        ss.values().update(spreadsheetId=SID, range=f"'{tab}'!{a1col}1",
                           valueInputOption="RAW", body={"values": body}).execute()
        # заметка к заголовку — чтобы определение метрики жило рядом с данными, а не только в README
        sh = tabs[tab]
        note = DOC_CODE if tab != "humanitarian" else DOC_HUM
        reqs = [{"updateCells": {
            "range": {"sheetId": sh["properties"]["sheetId"], "startRowIndex": 0, "endRowIndex": 1,
                      "startColumnIndex": col, "endColumnIndex": col + 1},
            "rows": [{"values": [{"note": note}]}], "fields": "note"}}]
        # логическая таблица вкладки должна накрыть новую колонку, иначе рамки/бэндинг её обрежут
        for t in sh.get("tables", []) or []:
            rng = dict(t["range"])
            if rng.get("endColumnIndex", 0) <= col:
                rng["endColumnIndex"] = col + 1
                reqs.append({"updateTable": {"table": {"tableId": t["tableId"], "range": rng},
                                             "fields": "range"}})
        ss.batchUpdate(spreadsheetId=SID, body={"requests": reqs}).execute()
        print(f"{tab}: колонка {a1col} записана ({sum(1 for nm in names if nm in resolved)}/{len(names)} значений)")
    print(f"https://docs.google.com/spreadsheets/d/{SID}/edit")


if __name__ == "__main__":
    main()
