#!/usr/bin/env python3
"""Вкладка «Hard 3-lang 04.08» — итоги кампании hard0804.

12 тяжёлых задач (3 языка × edit / edit-long / algo / conc), одношот. Метрики по каждому языку:
решено из 4, медианное время до решения (только решённые задачи), суммарная стоимость; средние
по всем языкам; и контролируемая пара edit → edit-long (замедление на длинном контексте ~63k
токенов — главный вопрос кампании local vs cloud).

Запуск:
    .venv-gsheets/bin/python gsheets_hard_tab.py --dry-run   # таблица в stdout, без записи
    .venv-gsheets/bin/python gsheets_hard_tab.py             # запись в Google Sheets

Форматирование: ТОЛЬКО через sync_gradient_rules из gsheets_common — правила пользователя
(дефолтная палитра Google на диапазонах 1:1000) не трогаем; свои правила распознаём по
палитре OWN_MINPOINTS. История дефекта — в комментариях gsheets_common.py.
"""

import glob
import json
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "results")
TAB = "Hard 6-lang 04.08"
OLD_TABS = ["Hard 3-lang 04.08"]          # прежние имена вкладки — переименовываются на месте
LANGS = ["rust", "ts", "julia", "csharp", "bash", "pwsh"]
LANG_TITLE = {"rust": "RUST", "ts": "TS", "julia": "Julia", "csharp": "C#", "bash": "Bash", "pwsh": "PwSh"}
TASKS = ["edit", "edit-long", "algo", "conc"]

# Исключённые из отчёта модели (данные в results-файлах сохраняются).
# grok-4.20-multi-agent — вердикт владельца [[04.08.2026]]: непригодна. Самая дорогая модель
# кампании ($4.53/набор — в 8.5 раза дороже gpt-5.6-luna) при том же 19/22 и вдвое худшей
# медиане времени (47.3 с против 14.3). Мультиагентная маршрутизация не даёт здесь ничего,
# кроме умножения токенов.
EXCLUDED = {
    "x-ai/grok-4.20-multi-agent",
    # gemini-3.1-flash-lite-preview — решение владельца [[04.08.2026]]: исключить. 0/12 на первых
    # трёх языках (Rust/TS/Julia — библиотеки собирались, но API ломала и тесты валила), а C#/
    # Bash/PwSh недоизмеримы: её deny-эндпоинт OpenRouter исчез в течение того же дня (404).
    # Строка с частичным покрытием и нулями лишь загромождает сравнение.
    "google/gemini-3.1-flash-lite-preview",
}

# Читаемые имена строк: облачные — хвост идентификатора, локальные — с квантом.
DISPLAY = {
    "InternScience/Agents-A1-Q4_K_M-GGUF": "Agents-A1 Q4_K_M (local, бюджет 100k)",
    # gaming-pc CachyOS Studio, кампания hard0812 [[13.08.2026]]:
    "unsloth/Qwen3.6-35B-A3B-MTP-GGUF": "Qwen3.6-35B-A3B-MTP UD-IQ4_NL (local)",
    "unsloth/Ornith-1.0-35B-GGUF": "Ornith-1.0-35B UD-IQ4_NL (local)",
    "unsloth/Qwen3.6-27B-MTP-GGUF": "Qwen3.6-27B-MTP UD-Q4_K_XL (local, окно 32k)",
    "unsloth/Muse-Glimmer-30B-GGUF": "Muse-Glimmer-30B UD-Q4_K_XL (local)",
    "unsloth/Qwen3-Coder-Next-GGUF:UD-Q4_K_M": "Qwen3-Coder-Next UD-Q4_K_M (local)",
    "unsloth/Qwen3-Coder-Next-GGUF:Q4_K_M": "Qwen3-Coder-Next Q4_K_M (local)",
    "openai/gpt-oss-120b": "gpt-oss-120b (pilot)",
}


def display(model):
    return DISPLAY.get(model, model.split("/")[-1])


def is_local(model):
    return model.startswith("unsloth/") or model.startswith("InternScience/")


# Локальные модели НЕ бесплатны — они жгут электричество (поправка владельца [[04.08.2026]]).
# Стенд потребляет ~500 Вт под нагрузкой, тариф в Испании €0.03/кВт·ч. Стоимость юнита
# считается по фактическому стенному времени вызова (latency), включая нерешённые задачи
# и prefill — ватты идут всё это время.
STAND_KW = 0.5
EUR_PER_KWH = 0.03


def electricity_eur(latency_seconds):
    return latency_seconds / 3600.0 * STAND_KW * EUR_PER_KWH


def gather():
    """Все записи hard-кампании: файлы results-hard*.json, свежий файл побеждает при дубле ключа."""
    recs = {}
    files = sorted(glob.glob(os.path.join(RES, "results-hard*.json")), key=os.path.getmtime)
    for f in files:
        try:
            data = json.load(open(f))
        except Exception:
            continue
        for r in data:
            if not isinstance(r, dict) or "task" not in r:
                continue
            key = (r.get("model"), r.get("lang"), r.get("task"), r.get("run", 1))
            recs[key] = r
    return list(recs.values())


def agg(records):
    """Сводка по моделям. Время до решения = latency решённых задач; нерешённые в медиану не входят.

    Записи ok=false (ошибка вызова: нет ZDR-эндпоинта, таймаут клиента) — НЕ провал задачи,
    модель её не видела; в знаменатель не входят. Модель без единой ok-записи в таблицу не попадает.
    """
    by_model = {}
    for r in records:
        if not r.get("ok") or r.get("model") in EXCLUDED:
            continue
        by_model.setdefault(r["model"], []).append(r)
    rows = []
    for model, rs in by_model.items():
        row = {"model": model, "langs": {}, "solved": 0, "cost": 0.0, "times": []}
        for lang in LANGS:
            lrs = [r for r in rs if r.get("lang") == lang]
            solved = [r for r in lrs if r.get("solved")]
            times = [r["latency"] for r in solved if r.get("latency")]
            if is_local(model):
                cost = electricity_eur(sum(r.get("latency") or 0 for r in lrs))
            else:
                cost = sum(r.get("cost") or 0 for r in lrs)
            row["langs"][lang] = {
                "solved": len(solved),
                "of": len(lrs),
                "med_t": statistics.median(times) if times else None,
                "cost": cost,
            }
            row["solved"] += len(solved)
            row["cost"] += cost
            row["times"] += times
        # Контролируемая пара edit → edit-long: замедление считаем по языкам, где решены ОБА
        # варианта (иначе сравнивали бы время решения с временем провала).
        ratios, t_short, t_long = [], [], []
        for lang in LANGS:
            e = next((r for r in rs if r.get("lang") == lang and r.get("task") == "edit" and r.get("solved")), None)
            el = next((r for r in rs if r.get("lang") == lang and r.get("task") == "edit-long" and r.get("solved")), None)
            if e and el and e.get("latency") and el.get("latency"):
                ratios.append(el["latency"] / e["latency"])
                t_short.append(e["latency"])
                t_long.append(el["latency"])
        row["edit_t"] = statistics.median(t_short) if t_short else None
        row["editlong_t"] = statistics.median(t_long) if t_long else None
        row["long_ratio"] = statistics.median(ratios) if ratios else None
        row["med_t"] = statistics.median(row["times"]) if row["times"] else None
        row["total"] = sum(row["langs"][l]["of"] for l in LANGS)
        # «Качество %» — среднее pct по ВСЕМ задачам модели: частичные решения учитываются,
        # в отличие от «решено /22», где задача либо закрыта целиком, либо ноль.
        pcts = [r.get("pct") or 0 for r in rs]
        row["quality"] = 100 * statistics.mean(pcts) if pcts else 0
        row["cost_per_solved"] = (row["cost"] / row["solved"]) if row["solved"] else None
        rows.append(row)
    rows.sort(key=lambda r: (-r["solved"], r["med_t"] if r["med_t"] is not None else 1e9))
    _add_profiles(rows)
    return rows


def _quartiles(vals):
    s = sorted(v for v in vals if v is not None)
    if len(s) < 4:
        return None, None
    return s[len(s) // 4], s[3 * len(s) // 4]


def _add_profiles(rows):
    """Автопрофиль «сильное/слабое» из самих данных: языки-лидеры и провалы, квартили цены/скорости."""
    q1_c, q3_c = _quartiles([r["cost"] for r in rows if not is_local(r["model"])])
    q1_t, q3_t = _quartiles([r["med_t"] for r in rows])
    for r in rows:
        langs_pct = {}
        for lang in LANGS:
            L = r["langs"][lang]
            if L["of"]:
                langs_pct[LANG_TITLE[lang]] = L["solved"] / L["of"]
        strong = [t for t, p in langs_pct.items() if p == 1.0]
        weak = [t for t, p in langs_pct.items() if p <= 1 / 3]
        bits_plus, bits_minus = [], []
        if strong:
            bits_plus.append("силён: " + ", ".join(strong))
        if not is_local(r["model"]) and q1_c is not None and r["cost"] <= q1_c:
            bits_plus.append("дёшев")
        if q1_t is not None and r["med_t"] is not None and r["med_t"] <= q1_t:
            bits_plus.append("быстр")
        if weak:
            bits_minus.append("слаб: " + ", ".join(weak))
        if not is_local(r["model"]) and q3_c is not None and r["cost"] >= q3_c:
            bits_minus.append("дорог")
        if q3_t is not None and r["med_t"] is not None and r["med_t"] >= q3_t:
            bits_minus.append("медлен")
        if is_local(r["model"]) and r["long_ratio"] is not None and r["long_ratio"] > 5:
            bits_minus.append(f"длинный контекст ×{r['long_ratio']:.0f} по времени")
        r["profile"] = ("+ " + "; ".join(bits_plus) if bits_plus else "") + \
                       ("  |  − " + "; ".join(bits_minus) if bits_minus else "") or "ровный середняк"


def fmt_t(v):
    return round(v, 1) if v is not None else "n/a"


def fmt_c(v, local):
    # Локальные — стоимость электроэнергии в евро (≈доллару в масштабе таблицы), облако — $ по usage.cost.
    return round(v, 4)


# 22 задачи: rust/ts/julia/csharp по 4 (с edit-long), bash/pwsh по 3 (без него).
HEADER = ["Модель", "решено /22"]
for _lang in LANGS:
    _t = LANG_TITLE[_lang]
    HEADER += [f"{_t} %", f"{_t} t, с", f"{_t} $"]
HEADER += ["медиана t, с", "$ всего", "качество %", "$/решённая", "edit t, с", "edit-long t, с", "long ×", "профиль"]

# Всплывающие подсказки на заголовках (просьба владельца [[04.08.2026]]): помощь живёт в hover,
# а не в видимом тексте — легенда под таблицей дублирует то же подробнее.
_TASKS4 = "4 задачи: edit (найти неназванный дефект в рабочем модуле + доработка), edit-long (та же правка в репозитории ~63k токенов), algo, conc"
_TASKS3 = "3 задачи: edit (дефект + доработка), algo, conc; без edit-long"
_LANG_NOTE = {
    "rust": f"Rust. {_TASKS4}. Оракул: cargo build + скрытые тесты.",
    "ts": f"TypeScript. {_TASKS4}. Оракул — ДВА гейта: tsc --strict И bun test.",
    "julia": f"Julia. {_TASKS4}. Оракул: julia -t N, скрытые проверки.",
    "csharp": f"C#. {_TASKS4}. Набор зеркалит Rust-набор (та же семантика задач) — пара Rust↔C# изолирует эффект языка. Оракул: dotnet run (net10.0).",
    "bash": f"Bash. {_TASKS3} (ротация бэкапов, semver-компаратор, параллельный исполнитель). Оракул: bash, скрытые проверки.",
    "pwsh": f"PowerShell 7.4. {_TASKS3} (разбор журнала, диапазоны целых, Invoke-Throttled). Оракул: pwsh, скрытые проверки.",
}


def header_notes():
    """Подсказка для каждой колонки заголовка, по позициям HEADER."""
    notes = ["Идентификатор модели. (local) = квант на Unsloth Studio (GPU-стенд), (pilot) = пилотная модель харнесса, в отбор S%>80 не входила.",
             "Полностью решённые задачи из 22. «Решено» = пройден гейт (компиляция/типы/загрузка) И 100% скрытых тестов."]
    for lang in LANGS:
        of = 3 if lang in ("bash", "pwsh") else 4
        notes += [
            f"Процент полностью решённых задач языка (из {of}). {_LANG_NOTE[lang]}",
            "Медианное время до решения, секунды — только по РЕШЁННЫМ задачам этого языка (нерешённые в медиану не входят). n/a = не решено ни одной.",
            "Суммарная стоимость всех задач языка. Облако — $ по usage.cost OpenRouter (реальная маршрутизация). Локальные — электроэнергия стенда в € (500 Вт × €0.03/кВт·ч × фактическое время всех задач, включая нерешённые и prefill).",
        ]
    notes += [
        "Медиана времени до решения по ВСЕМ решённым задачам модели (все языки), секунды.",
        "Суммарная стоимость всех 22 задач. Облако — $ (usage.cost), локальные — электроэнергия в € (500 Вт × €0.03/кВт·ч).",
        "Средний процент пройденных скрытых тестов по ВСЕМ 22 задачам — частичные решения учитываются (в отличие от «решено», где задача либо закрыта целиком, либо ноль). Мера «насколько хорошо делает все задачи».",
        "Стоимость одной ПОЛНОСТЬЮ решённой задачи: «$ всего» / «решено». Мера эффективности затрат; n/a = ничего не решено.",
        "Медианное время решённых КОРОТКИХ правок (edit) по языкам, где решены и edit, и edit-long, секунды.",
        "Медианное время решённых ДЛИННЫХ правок (edit-long, ~63k токенов входа) по тем же языкам, секунды.",
        "Цена длинного контекста: медиана отношения времени edit-long/edit по языкам, где решены ОБА варианта. Облако ≈0.3–3.5 (prefill стоит денег, не времени); локальные кванты ≈13 (prefill 63k токенов ≈ 200+ с до первого токена).",
        "Автопрофиль из данных: «силён» = языки, решённые на 100%; «слаб» = решено треть и меньше; «дёшев»/«дорог» и «быстр»/«медлен» — нижний/верхний квартиль по цене и медиане времени.",
    ]
    return notes


def to_values(rows):
    values = [HEADER]
    for row in rows:
        loc = is_local(row["model"])
        line = [display(row["model"]), row["solved"]]
        for lang in LANGS:
            L = row["langs"][lang]
            # Числовой процент вместо строки «4/4»: строке градиент недоступен (просьба владельца).
            pct = round(100 * L["solved"] / L["of"]) if L["of"] else "n/a"
            line += [pct, fmt_t(L["med_t"]), fmt_c(L["cost"], loc)]
        line += [fmt_t(row["med_t"]), fmt_c(row["cost"], loc),
                 round(row["quality"], 1),
                 round(row["cost_per_solved"], 4) if row["cost_per_solved"] is not None else "n/a",
                 fmt_t(row["edit_t"]), fmt_t(row["editlong_t"]),
                 round(row["long_ratio"], 2) if row["long_ratio"] is not None else "n/a",
                 row["profile"]]
        values.append(line)
    return values


def main():
    records = gather()
    rows = agg(records)
    values = to_values(rows)
    # Контроль полноты (просьба владельца [[04.08.2026]]): каждая модель из результатов обязана
    # либо попасть в таблицу, либо числиться в EXCLUDED. Молчаливая потеря строки недопустима —
    # прецедент был (4 юнита затёрла гонка процессов, и это заметили только по вопросу владельца).
    measured = {r["model"] for r in records if r.get("ok")}
    shown = {row["model"] for row in rows}
    lost = measured - shown - EXCLUDED
    if lost:
        raise SystemExit(f"ПОТЕРЯНЫ СТРОКИ (есть замеры, нет в таблице и не в EXCLUDED): {sorted(lost)}")
    print(f"полнота: {len(shown)} строк, {len(EXCLUDED & measured)} исключено осознанно, потерь нет")
    if "--dry-run" in sys.argv:
        w = [max(len(str(v[i])) for v in values) for i in range(len(HEADER))]
        for v in values:
            print("  ".join(str(x).ljust(w[i]) for i, x in enumerate(v)))
        print(f"\nмоделей: {len(rows)}, записей: {len(records)}")
        return

    from googleapiclient.discovery import build
    from gsheets_common import credentials, sync_gradient_rules, OWN_MINPOINTS, OWN_RED, OWN_GRN

    SID = open(os.path.join(HERE, "gsheets-sheet-id.txt")).read().strip()
    svc = build("sheets", "v4", credentials=credentials(), cache_discovery=False)
    meta = svc.spreadsheets().get(spreadsheetId=SID).execute()
    sheet_id = None
    old_id = None
    for s in meta["sheets"]:
        if s["properties"]["title"] == TAB:
            sheet_id = s["properties"]["sheetId"]
        if s["properties"]["title"] in OLD_TABS:
            old_id = s["properties"]["sheetId"]
    if sheet_id is None and old_id is not None:
        # Переименование на месте: сохраняются sheetId, ссылки и правила форматирования.
        svc.spreadsheets().batchUpdate(spreadsheetId=SID, body={
            "requests": [{"updateSheetProperties": {
                "properties": {"sheetId": old_id, "title": TAB}, "fields": "title"}}]
        }).execute()
        sheet_id = old_id
    if sheet_id is None:
        r = svc.spreadsheets().batchUpdate(spreadsheetId=SID, body={
            "requests": [{"addSheet": {"properties": {"title": TAB, "gridProperties": {"frozenRowCount": 1, "frozenColumnCount": 1}}}}]
        }).execute()
        sheet_id = r["replies"][0]["addSheet"]["properties"]["sheetId"]
    # Старая версия была уже; строк/колонок могло быть больше нового объёма — чистим хвост.
    svc.spreadsheets().values().clear(spreadsheetId=SID, range=f"'{TAB}'!A1:ZZ1000").execute()

    svc.spreadsheets().values().update(
        spreadsheetId=SID, range=f"'{TAB}'!A1",
        valueInputOption="RAW", body={"values": values}).execute()

    # Легенда и краткая методика ПОД таблицей (просьба владельца [[04.08.2026]]): что тестировалось,
    # как, и что означает каждая колонка. Пишется тем же скриптом — переживает перезаписи вкладки.
    legend = [[""], ["ЧТО ТЕСТИРОВАЛОСЬ"],
        ["22 тяжёлые задачи = 6 языков: Rust, TypeScript, Julia, C# — по 4 задачи; Bash, PowerShell — по 3 (без edit-long). Одношот (без агентного цикла), temperature 0.2, max_tokens 40000. Облако — OpenRouter с data_collection: deny; локальные кванты — Unsloth Studio на GPU-стенде (окно 262144, KV q4_0)."],
        ["Типы задач: edit — в РАБОЧЕМ модуле найти неназванный дефект и добавить возможность, не сломав публичный API; edit-long — ТА ЖЕ правка, но модуль закопан в сгенерированный репозиторий ~63k токенов (контролируемая пара к edit: разница только в длине контекста); algo — алгоритмическая глубина (медиана скользящего окна, адаптивное интегрирование, semver, диапазоны); conc — корректность под параллелизмом (каналы с обратным давлением, ограниченные исполнители)."],
        ["Оракулы: Rust — cargo build + скрытые тесты; TypeScript — ДВА независимых гейта: tsc --strict И bun test; Julia — julia -t N; C# — dotnet run (net10.0, без NuGet); Bash/PowerShell — скрытые проверки (bash / pwsh 7.4). «Решено» = пройден гейт И 100% скрытых тестов. C#-набор зеркалит Rust-набор (те же задачи, та же семантика) — пара Rust↔C# изолирует эффект языка."],
        [""], ["КОЛОНКИ"],
        ["решено /22 — полностью решённые задачи из 22."],
        ["<Язык> % — процент полностью решённых задач языка (Rust/TS/Julia/C# — из 4, Bash/PwSh — из 3); <Язык> t, с — МЕДИАННОЕ время до решения по решённым задачам языка (нерешённые не входят; n/a = не решено ни одной); <Язык> $ — суммарная стоимость всех задач языка: облако — $ по usage.cost, локальные — электроэнергия стенда в € (500 Вт × €0.03/кВт·ч × полное время, включая нерешённые)."],
        ["медиана t, с — медиана времени по всем решённым задачам модели; $ всего — стоимость всех задач."],
        ["edit t, с / edit-long t, с — медианное время решённых коротких правок против длинных (~63k токенов входа)."],
        ["long × — медиана отношения времени edit-long/edit по языкам, где решены ОБА варианта. Это цена длинного контекста: у облака ≈0.3–3.5 (prefill стоит денег, но не времени), у локальных квантов ≈13 (prefill 63k токенов ≈ 200+ секунд до первого токена)."],
        [""], ["СНОСКИ"],
        ["kat-coder-pro-v2 исключена: исчез эндпоинт OpenRouter, совместимый с data_collection: deny (404). gemini-3.1-flash-lite-preview исключена: 0/12 на Rust/TS/Julia (библиотеки собирались, но API ломала и тесты валила), а C#/Bash/PwSh недоизмеримы — её deny-эндпоинт исчез в течение того же дня. gpt-oss-120b — пилотная модель харнесса, в отбор S%>80 не входила."],
        ["Agents-A1 (local) — рассуждающая модель: на 10 из 22 задач сожгла стандартный бюджет 40k токенов размышлением, не дойдя до ответа (finish=length, пустой контент); эти юниты перемерены с бюджетом 100k — как Apriel [[03.08.2026]]. Остальные модели укладывались в 40k."],
        ["grok-4.20-multi-agent — НЕПРИГОДНА, из отчёта исключена: самая дорогая модель кампании ($4.53/набор, в 8.5 раза дороже gpt-5.6-luna) при том же результате 19/22 и вдвое худшей медиане времени (47.3 с против 14.3). Мультиагентная маршрутизация умножает токены, не добавляя качества."],
        [f"Кампания hard0804 [[04.08.2026]]: ~580 ok-юнитов, ≈$22.5 суммарно. Скрипты: /code/work/llm-bench/run-hard.mjs (+ --selftest), tasks-hard-*.js, gsheets_hard_tab.py."],
    ]
    svc.spreadsheets().values().update(
        spreadsheetId=SID, range=f"'{TAB}'!A{len(values) + 2}",
        valueInputOption="RAW", body={"values": legend}).execute()

    # Сброс числового формата области данных: при сдвиге колонок ячейки наследуют формат
    # ПРЕЖНЕЙ колонки (целые секунды), и «$/решённая» 0.0566 отображалась как «0».
    svc.spreadsheets().batchUpdate(spreadsheetId=SID, body={"requests": [{
        "repeatCell": {
            "range": {"sheetId": sheet_id, "startRowIndex": 1, "endRowIndex": len(values),
                      "startColumnIndex": 1, "endColumnIndex": len(HEADER)},
            "cell": {},
            "fields": "userEnteredFormat.numberFormat",
        }
    }]}).execute()

    # Подсказки на заголовках: одна batchUpdate-строка updateCells по row 0 с полем note.
    notes = header_notes()
    svc.spreadsheets().batchUpdate(spreadsheetId=SID, body={"requests": [{
        "updateCells": {
            "range": {"sheetId": sheet_id, "startRowIndex": 0, "endRowIndex": 1,
                      "startColumnIndex": 0, "endColumnIndex": len(notes)},
            "rows": [{"values": [{"note": n} for n in notes]}],
            "fields": "note",
        }
    }]}).execute()

    # Градиенты своей палитрой: время и $ — меньше=лучше (зелёный минимум), решено — больше=лучше.
    n = len(values)
    existing = svc.spreadsheets().get(spreadsheetId=SID, fields="sheets(properties(sheetId),conditionalFormats)").execute()
    ex_rules = []
    for s in existing.get("sheets", []):
        if s.get("properties", {}).get("sheetId") == sheet_id:
            ex_rules = s.get("conditionalFormats", [])

    # Перцентильные точки вместо MIN/MAX (просьба владельца [[04.08.2026]]): один выброс
    # (сверхдорогая или сверхмедленная модель) при MIN/MAX сплющивает всю шкалу в один цвет,
    # а 10-й/50-й/90-й перцентили держат контраст в рабочей части распределения.
    OWN_MID = {"red": 1.0, "green": 1.0, "blue": 1.0}   # середина — белая (просьба владельца)
    def rule(col, better_low):
        lo, hi = (OWN_GRN, OWN_RED) if better_low else (OWN_RED, OWN_GRN)
        return {"ranges": [{"sheetId": sheet_id, "startRowIndex": 1, "endRowIndex": n,
                            "startColumnIndex": col, "endColumnIndex": col + 1}],
                "gradientRule": {"minpoint": {"color": lo, "type": "PERCENTILE", "value": "10"},
                                 "midpoint": {"color": OWN_MID, "type": "PERCENTILE", "value": "50"},
                                 "maxpoint": {"color": hi, "type": "PERCENTILE", "value": "90"}}}

    # {индекс колонки: меньше=лучше}: решено — нет, времена и деньги — да.
    # Колонки языков идут тройками (X /n, X t, X $) начиная с индекса 2 — градиенты на t и $.
    wanted = {1: False}
    for li in range(len(LANGS)):
        base = 2 + li * 3
        wanted[base] = False      # % решённых (больше = лучше)
        wanted[base + 1] = True   # t, с
        wanted[base + 2] = True   # $
    tail = 2 + len(LANGS) * 3
    # медиана t, $ всего, качество % (больше=лучше!), $/решённая, edit t, edit-long t, long ×;
    # последняя колонка «профиль» — текст, без градиента.
    for c, better_low in [(tail, True), (tail + 1, True), (tail + 2, False), (tail + 3, True),
                          (tail + 4, True), (tail + 5, True), (tail + 6, True)]:
        wanted[c] = better_low
    reqs = sync_gradient_rules(ex_rules, sheet_id, wanted,
                               lambda col, better_low: rule(col, better_low),
                               OWN_MINPOINTS)
    if reqs:
        svc.spreadsheets().batchUpdate(spreadsheetId=SID, body={"requests": reqs}).execute()
    print(f"записано: {len(rows)} моделей во вкладку «{TAB}»")


if __name__ == "__main__":
    main()
