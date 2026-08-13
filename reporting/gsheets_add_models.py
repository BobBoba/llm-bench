"""Append new models to the RUST / humanitarian / TypeScript tabs — PURE Google Sheet, no xlsx.

The main table used to be xlsx-mirrored; per the owner's decision the Google Sheet is now the sole
source of truth. This computes each new model's row FROM the battery results (same aggregation as
the old injectors) and APPENDS it to each tab in place — existing rows are never rewritten. It then
extends the logical table range (so borders + banding cover the new rows) and refreshes the
red→yellow→green gradients over the new extent. Idempotent: a model already present (by display
name) is skipped.

Cost-ratio columns are computed numerically from each tab's own anchors (the Opus row cost and the
DS-V3.2 row cost), on the single-shot cost basis — consistent with gsheets_backfill_ratios.py.

Configure MODELS / SUFFIX / MODEL_META below, then:
    .venv-gsheets/bin/python gsheets_add_models.py
"""
import os
import json
import statistics
from googleapiclient.discovery import build
from gsheets_common import credentials, sync_gradient_rules

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "..", "results")
SID = open(os.path.join(HERE, "gsheets-sheet-id.txt")).read().strip()

# ---- configure the batch to add ----
MODELS = [
    "unsloth/Seed-OSS-36B-Instruct-GGUF:UD-Q4_K_XL",
    "unsloth/Seed-OSS-36B-Instruct-GGUF:UD-Q3_K_XL",
    "unsloth/gemma-4-31B-it-qat-GGUF:UD-Q4_K_XL",
    "unsloth/Apriel-1.5-15b-Thinker-GGUF:UD-Q8_K_XL",
]
SUFFIX = "unsloth0803b"                      # results-<SUFFIX>-{rust,ts,knowledge}.json + -humscores.json
GROUP = "local"                             # 'группа' label (non-local/ref => treated as cloud)
PROV = "local (Unsloth Studio)"
MODEL_META = {
    # ! Цена ФАКТИЧЕСКОГО ZDR-эндпоинта, а не заголовок каталога ([[02.08.2026]]).
    #   Поле `pricing` на уровне модели показывает самый дешёвый эндпоинт — здесь DeepInfra
    #   $0.09/$0.18, — но ZDR-маршрутизация уводит на SiliconFlow $0.14/$0.28. Подтверждено
    #   обратным счётом по нашим замерам: implied output $0.29/1M против $0.28 по прайсу.
    # Локальные: цены нет, значимы окно и наличие tool-use. Окно 262144 — модели загружены на
    # полное родное окно (журнал сервера подтверждает n_ctx_slot = 262144). Tool-use проверен
    # прямой пробой: обе отдают корректный `tool_calls` с finish=tool_calls.
    # Окна РАЗНЫЕ и это принципиально: 262144 держит только gemma (скользящее окно внимания
    # делает её KV вшестеро дешевле), Seed-OSS при таком окне не влезает в 24 ГиБ.
    # Оба кванта Seed-OSS обязаны иметь ОДНО окно: переопределения Studio ключуются по
    # репозиторию, и при сравнении квантов контекст должен быть контрольной константой.
    "unsloth/Seed-OSS-36B-Instruct-GGUF:UD-Q4_K_XL": {"ctx": 32768, "tools": True},
    "unsloth/Seed-OSS-36B-Instruct-GGUF:UD-Q3_K_XL": {"ctx": 32768, "tools": True},
    "unsloth/gemma-4-31B-it-qat-GGUF:UD-Q4_K_XL": {"ctx": 262144, "tools": True},
    "unsloth/Apriel-1.5-15b-Thinker-GGUF:UD-Q8_K_XL": {"ctx": 98304, "tools": True},
}

# Необязательное переопределение имени строки. По умолчанию имя = short(mid), но у локальных
# моделей идентификатор несёт репозиторий и квант (`unsloth/Repo-GGUF:UD-Q4_K_M`) — как заголовок
# строки это нечитаемо, а квант при этом принципиален и потерять его нельзя.
DISPLAY = {
    "unsloth/Seed-OSS-36B-Instruct-GGUF:UD-Q4_K_XL": "Seed-OSS-36B UD-Q4_K_XL",
    "unsloth/Seed-OSS-36B-Instruct-GGUF:UD-Q3_K_XL": "Seed-OSS-36B UD-Q3_K_XL",
    "unsloth/gemma-4-31B-it-qat-GGUF:UD-Q4_K_XL": "Gemma-4-31B-QAT UD-Q4_K_XL",
    # ! Ноль по кодовым осям у этой строки означает НЕ «ответила неверно», а «не завершила ответ»:
    #   10 из 12 одношотовых прогонов дали finish=length. Проверено повторным прогоном с бюджетом
    #   90000 токенов (в 2.25 раза больше штатного): первая задача исчерпала весь бюджет, так и не
    #   закончив, вторая превысила 20-минутный дедлайн. То есть модель на наших задачах не
    #   останавливается, и ноль — настоящее свойство, а не тесный бюджет.
    "unsloth/Apriel-1.5-15b-Thinker-GGUF:UD-Q8_K_XL": "Apriel-1.5-15B-Thinker UD-Q8_K_XL",
}

# LOCAL=True — модель крутится на своём железе. Токены не тарифицируются, поэтому в ценовые ячейки
# идёт литерал "local", а не вычисленный 0: ноль читался бы как «измерено и равно нулю», тогда как
# на деле величина неприменима. Кратности к Opus и DS-V3.2 по той же причине становятся "n/a".
# Так уже оформлены все прежние локальные строки таблицы (см. gsheets_add_bonsai.py).
LOCAL = True   # обе модели крутятся на GPU-стенде через Unsloth Studio
LOCAL_CELL = "local"

RED = {"red": 0.97, "green": 0.41, "blue": 0.42}
YEL = {"red": 1, "green": 0.92, "blue": 0.52}
GRN = {"red": 0.39, "green": 0.75, "blue": 0.48}

# gradient columns per tab (col index -> vmax), matching gsheets_push.py
GRAD = {
    "RUST":         {3: 100, 5: 100, 9: 100},
    "humanitarian": {2: 10, 3: 10, 4: 10, 5: 10, 6: 10, 7: 10},
    "TypeScript":   {3: 100, 5: 100, 9: 100, 11: 100},
}


def load(name):
    p = os.path.join(RES, name)
    return json.load(open(p)) if os.path.exists(p) else ([] if name.endswith(".json") else {})


def med(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 1) if xs else None


def short(mid):
    return mid.lstrip("~").split("/")[-1]


def ctx_label(n):
    if not n:
        return "—"
    if n >= 1_000_000:
        return f"{n/1_000_000:.2f}".rstrip("0").rstrip(".") + "M"
    return f"{round(n/1000)}k"


# ---- aggregations (mirror inject-fast100 rust_agg/know_agg + inject-ts aggregate) ----
def rust_agg(rows, mid):
    s = [r for r in rows if r["model"] == mid and r["mode"] == "single" and r.get("ok")]
    a = [r for r in rows if r["model"] == mid and r["mode"] == "agentic" and r.get("ok") and not r.get("err")]
    if not s:
        return None
    if all((not r.get("tokOut")) and r.get("ttft") is None for r in s):
        return {"loadfail": True}
    tokps = med([r["tokps"] for r in s if r.get("tokps")])
    burst = tokps is not None and tokps > 1500
    out = dict(
        S=round(100 * sum(r["pct"] for r in s) / len(s)),
        full=f"{sum(1 for r in s if r['pct'] >= 0.999)}/{len(s)}",
        cmp=round(100 * sum(1 for r in s if r["compiles"]) / len(s)),
        cost=round(sum(r.get("cost", 0) for r in s) / len(s), 5),
        medLat=med([r["latency"] for r in s]),
        medRsn=round(med([r.get("reasonTok", 0) for r in s]) or 0),
        tokps=(None if burst else tokps),
        ttft=(lambda t: round(t, 2) if t is not None else None)(med([r["ttft"] for r in s if r.get("ttft") is not None])),
    )
    if a:
        out["A"] = round(100 * sum(r["pct"] for r in a) / len(a))
        out["grn"] = f"{sum(1 for r in a if r.get('visibleGreen'))}/{len(a)}"
        acost = [r.get("cost", 0) for r in a]
        out["acost"] = round(sum(acost) / len(acost), 5) if any(acost) else 0
    return out


def know_agg(rows, mid):
    kc = [r for r in rows if r["model"] == mid and r.get("ok")]
    if not kc:
        return {}
    return dict(cost=round(sum(r.get("cost", 0) for r in kc) / len(kc), 5),
                tokps=med([r["tokps"] for r in kc if r.get("tokps")]),
                ttft=(lambda t: round(t, 2) if t is not None else None)(med([r["ttft"] for r in kc if r.get("ttft") is not None])),
                rsn=med([r.get("reasonTok", 0) for r in kc]) or 0)


def ts_agg(rows, mid):
    single = [r for r in rows if r["model"] == mid and r.get("mode") == "single" and r.get("ok")]
    agentic = [r for r in rows if r["model"] == mid and r.get("mode") == "agentic" and r.get("ok") and not r.get("err")]
    if not single and not agentic:
        return None
    scost = [r.get("cost", 0) for r in single]
    reasoning = "yes" if any((r.get("reasonTok") or 0) > 0 for r in single + agentic) else "no"
    return dict(
        S=round(100 * sum(r["pct"] for r in single) / len(single)) if single else None,
        full=f"{sum(1 for r in single if r['pct'] >= 0.999)}/{len(single)}" if single else "—",
        typp=round(100 * sum(1 for r in single if r.get("typechecks")) / len(single)) if single else None,
        cost=round(sum(scost) / len(scost), 5) if any(scost) else 0,
        medLat=med([r["latency"] for r in single]),
        medRsn=round(med([r["reasonTok"] for r in single]) or 0),
        A=round(100 * sum(r["pct"] for r in agentic) / len(agentic)) if agentic else None,
        green=f"{sum(1 for r in agentic if r.get('visibleGreen'))}/{len(agentic)}" if agentic else "—",
        toolValid=round(100 * sum(r.get("toolValidPct", 0) for r in agentic) / len(agentic)) if agentic else None,
        recovered=f"{sum(1 for r in agentic if r.get('recovered'))}/{len(agentic)}" if agentic else "—",
        tokps=med([r["tokps"] for r in single if r.get("tokps")]),
        ttft=med([r["ttft"] for r in single if r.get("ttft") is not None]),
    )


def na(v):
    return "n/a" if v is None else v


def anchors(rows, cost_i):
    """Opus + DS-V3.2 single-cost anchors from a tab's own rows (unformatted values)."""
    opus = ds = None
    for r in rows[1:]:
        name = str(r[0]).lower() if r else ""
        c = r[cost_i] if len(r) > cost_i and isinstance(r[cost_i], (int, float)) else None
        if c is None:
            continue
        if opus is None and "opus" in name:
            opus = c
        if ds is None and "v3.2" in name:
            ds = c
    return opus, ds


def gradient_rule(sid, col, nrows, vmax):
    return {"addConditionalFormatRule": {"index": 0, "rule": {
        "ranges": [{"sheetId": sid, "startRowIndex": 1, "endRowIndex": nrows,
                    "startColumnIndex": col, "endColumnIndex": col + 1}],
        "gradientRule": {
            "minpoint": {"color": RED, "type": "NUMBER", "value": "0"},
            "midpoint": {"color": YEL, "type": "NUMBER", "value": "%g" % (vmax / 2)},
            "maxpoint": {"color": GRN, "type": "NUMBER", "value": "%g" % vmax}}}}}


def main():
    rust_rows = load(f"results-{SUFFIX}-rust.json")
    ts_rows = load(f"results-{SUFFIX}-ts.json")
    know_rows = load(f"results-{SUFFIX}-knowledge.json")
    hum_scores = load(f"results-{SUFFIX}-humscores.json")

    ss = build("sheets", "v4", credentials=credentials()).spreadsheets()
    meta = ss.get(spreadsheetId=SID, fields="sheets(properties(title,sheetId),conditionalFormats,tables(tableId,range),bandedRanges(bandedRangeId))").execute()
    tabs = {sh["properties"]["title"]: sh for sh in meta["sheets"]}

    # read current values of the three tabs (unformatted) for anchors + existing names + last row
    def values(tab, rng):
        return ss.values().get(spreadsheetId=SID, range=f"'{tab}'!{rng}",
                               valueRenderOption="UNFORMATTED_VALUE").execute().get("values", [])
    v_ru = values("RUST", "A1:T200")
    v_hu = values("humanitarian", "A1:R200")
    v_ts = values("TypeScript", "A1:Q200")
    opus_ru, ds_ru = anchors(v_ru, 6)
    opus_hu, ds_hu = anchors(v_hu, 8)
    have_ru = {str(r[0]).strip() for r in v_ru[1:] if r}
    have_hu = {str(r[0]).strip() for r in v_hu[1:] if r}
    have_ts = {str(r[0]).strip() for r in v_ts[1:] if r}

    add_ru, add_hu, add_ts = [], [], []
    for mid in MODELS:
        nm = DISPLAY.get(mid) or short(mid)
        mm = MODEL_META.get(mid, {})
        blend = LOCAL_CELL if LOCAL else round((mm.get("in", 0) + mm.get("out", 0)) / 2, 3)
        ctx = ctx_label(mm.get("ctx"))
        price = LOCAL_CELL if LOCAL else f'{mm.get("in",0):g}/{mm.get("out",0):g}'
        tools_yn = "yes" if mm.get("tools") else "no"
        # у локальной модели токены не тарифицируются — подменяем вычисленный ноль литералом
        money = (lambda _v: LOCAL_CELL) if LOCAL else (lambda v: v)

        ra = rust_agg(rust_rows, mid)
        if ra and not ra.get("loadfail") and nm not in have_ru:
            has_ag = "A" in ra
            rsn_yn = "yes" if ra["medRsn"] > 50 else "no"
            vsds = round(ra["cost"] / ds_ru, 2) if (ds_ru and ra["cost"]) else "n/a"
            vsopus = round(opus_ru / ra["cost"], 2) if (opus_ru and ra["cost"]) else "n/a"
            add_ru.append([nm, GROUP, blend, ra["S"], ra["full"], ra["cmp"], money(ra["cost"]),
                           ra["medLat"], ra["medRsn"],
                           na(ra.get("A")), ra.get("grn", "n/a"), money(na(ra.get("acost"))),
                           vsds, vsopus, ctx, tools_yn, PROV, rsn_yn,
                           na(ra["tokps"]), na(ra["ttft"])])

        sc = hum_scores.get(mid)
        if sc and nm not in have_hu:
            ka = know_agg(know_rows, mid)
            avg = sc.get("avg") or round((sc["facts"] + sc["ideas"] + sc["fermi"] + sc["forecast"] + sc["analysis"]) / 5, 2)
            kcost = ka.get("cost", 0)
            ktok = ka.get("tokps")
            kburst = ktok is not None and ktok > 1500
            vsopus_h = round(opus_hu / kcost, 2) if (opus_hu and kcost) else "n/a"
            vsds_h = round(kcost / ds_hu, 2) if (ds_hu and kcost) else "n/a"
            krsn = "yes" if (ka.get("rsn") or 0) > 50 else "no"
            add_hu.append([nm, GROUP, sc["facts"], sc["ideas"], sc["fermi"], sc["forecast"], sc["analysis"],
                           avg, money(kcost), sc.get("empties", 0), vsopus_h, vsds_h, ctx, "yes", PROV, krsn,
                           ("n/a" if (ktok is None or kburst) else ktok), na(ka.get("ttft"))])

        ta = ts_agg(ts_rows, mid)
        if ta and nm not in have_ts:
            add_ts.append([nm, GROUP, price, na(ta["S"]), ta["full"], na(ta["typp"]), money(ta["cost"]),
                           na(ta["medLat"]), na(ta["medRsn"]), na(ta["A"]), ta["green"],
                           na(ta["toolValid"]), ta["recovered"], ctx, ("yes" if any((r.get("reasonTok") or 0) > 0 for r in ts_rows if r["model"] == mid) else "no"),
                           na(ta["tokps"]), na(ta["ttft"])])

    plan = {"RUST": (v_ru, add_ru, 20), "humanitarian": (v_hu, add_hu, 18), "TypeScript": (v_ts, add_ts, 17)}
    reqs, wrote = [], {}
    for tab, (cur, rows_add, ncol) in plan.items():
        if not rows_add:
            continue
        sh = tabs[tab]
        sid = sh["properties"]["sheetId"]
        last = len(cur)                       # number of existing rows (incl header) = first empty row-1
        start = last                          # 0-based index of first new row
        # write values at A{last+1}
        ss.values().update(spreadsheetId=SID, range=f"'{tab}'!A{last+1}",
                           valueInputOption="RAW", body={"values": rows_add}).execute()
        newn = last + len(rows_add)           # new total row count
        wrote[tab] = len(rows_add)
        # extend logical table to new extent (borders + banding follow)
        if sh.get("tables"):
            tid = sh["tables"][0]["tableId"]
            reqs.append({"updateTable": {"table": {"tableId": str(tid), "range": {
                "sheetId": sid, "startRowIndex": 0, "endRowIndex": newn,
                "startColumnIndex": 0, "endColumnIndex": ncol}}, "fields": "range"}})
        # Растягиваем СВОИ градиенты на новый диапазон строк.
        # ! Раньше здесь стоял слепой цикл `deleteConditionalFormatRule(index=0)` по числу правил,
        #   сносивший ВСЕ правила вкладки, включая добавленные владельцем вручную (дважды стёр
        #   цветовые шкалы на колонках `$/задача`, `$/задача (ag)` и «время до решения»).
        #   Теперь свои правила обновляются на месте, чужие не затрагиваются вовсе —
        #   см. gsheets_common.sync_gradient_rules.
        reqs += sync_gradient_rules(
            sh.get("conditionalFormats", []), sid,
            {col: vmax for col, vmax in GRAD[tab].items()},
            lambda col, vmax: gradient_rule(sid, col, newn, vmax)["addConditionalFormatRule"]["rule"],
            own_minpoint_colors=[RED],
        )

    if reqs:
        ss.batchUpdate(spreadsheetId=SID, body={"requests": reqs}).execute()
    print("appended:", wrote or "nothing (all present or no data)")
    print(f"anchors RUST Opus=${opus_ru} DS=${ds_ru} | humanitarian Opus=${opus_hu} DS=${ds_hu}")
    print(f"https://docs.google.com/spreadsheets/d/{SID}/edit")


if __name__ == "__main__":
    main()
