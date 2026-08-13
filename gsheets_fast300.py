"""Build & push the 4th tab — "Fast (300+ tps)" — into the shared Google Sheet.

Self-contained: unlike gsheets_push.py (which mirrors the xlsx), this tab is aggregated
directly from results/*.json (the user asked to leave the xlsx alone). It combines:
  * speed        — streaming-median tok/s across the fast100 battery calls
  * tool-use     — results-fast300-tooluse.json (success% + valid-call%)
  * long-context — results-<model>-longctx.json (retrieval% overall + at the top rung)
  * code/know    — reused fast100 RUST/TS pass% + Opus-judged knowledge
  * economics    — median $/task + list prices + context window + tool support

Creates a native logical Table (addTable) + red→yellow→green gradients, matching the other
three tabs. Idempotent: re-run to refresh values/formatting.

    .venv-gsheets/bin/python gsheets_fast300.py
"""
import os
import json
import statistics
from collections import defaultdict
from googleapiclient.discovery import build
from gsheets_common import credentials, delete_own_rules

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "results")
SID = open(os.path.join(HERE, "gsheets-sheet-id.txt")).read().strip()
TAB = "Fast (300+ tps)"

RED = {"red": 0.97, "green": 0.41, "blue": 0.42}
YEL = {"red": 1, "green": 0.92, "blue": 0.52}
GRN = {"red": 0.39, "green": 0.75, "blue": 0.48}

# The 11 models on this page: 8 in the 300+ tok/s tier + 3 comparison anchors (200-300).
MODELS = [
    "google/gemini-3.1-flash-lite",
    "google/gemini-3.1-flash-lite-preview",
    "google/gemini-2.5-flash-lite-preview-09-2025",
    "google/gemini-2.5-flash-lite",
    "amazon/nova-2-lite-v1",
    "amazon/nova-micro-v1",
    "inception/mercury-2",
    "x-ai/grok-4.20-multi-agent",
    # anchors
    "x-ai/grok-4.20",
    "moonshotai/kimi-k2-thinking",
    "google/gemini-3.5-flash",
]

HEADERS = [
    "Модель", "tok/s", "Tool ok%", "Valid%", "Needle%", "Multi-8%", "Ctx reach (k tok)",
    "RUST%", "TS%", "Знания", "$/задача", "×деш. Opus", "×к DS-V3.2", "$/1M in", "$/1M out",
    "Контекст", "Tools", "Вердикт",
]

HEADER_DOCS = [
    "Модель / идентификатор. 8 моделей тира 300+ tok/s + 3 якоря сравнения (200-300 tok/s).",
    "tok/s — медианная скорость генерации (streaming), по реальным вызовам батарей fast100.",
    "Tool ok% — доля УСПЕШНЫХ прогонов tool-loop с ВЕРНЫМ итогом (mock бизнес-API, цепочка list→orders→price→submit, 3 прогона; ошибки провайдера не считаются провалом задачи). N/A — модель без tool-use в ZDR.",
    "Valid% — доля КОРРЕКТНЫХ tool-call (парсится JSON + известное имя + валидна схема). Механика инструментов отдельно от арифметики.",
    "Needle% — одиночный needle-in-haystack: retrieval одного факта по сетке 8k..75% окна × глубины 10/50/90. В 2026 насыщён (≈100% у всех).",
    "Multi-8% — 8 разных кодов, разбросанных по всему контексту, задача «перечисли ВСЕ». Recall на глубоком рунге (min 50% окна, cap 256k). Разделяющая метрика: внимание ко ВСЕМУ окну, а не к одной заметной строке.",
    "Ctx reach (k tok) — реальный достижимый потолок под ZDR (макс. фактический promptTok, тыс.). Часто МЕНЬШЕ заявленного окна: провайдер отвергает верхние рунги (напр. grok 2M → ~735k, 400 на 1.5M).",
    "RUST% — single-shot: средний % пройденных скрытых тестов (cargo test), из прогона fast100.",
    "TS% — TypeScript: средний % пройденных тестов (tsc --strict + bun test), из прогона fast100.",
    "Знания — средний балл по 5 осям гуманитарной батареи (судья Opus 4.8).",
    "Средняя стоимость одной задачи (RUST+TS), USD.",
    "Во сколько раз ДЕШЕВЛЕ Claude Opus 4.8 (якорь single-cost Opus / $задача). Больше = дешевле; <1 = дороже Opus.",
    "Отношение к DeepSeek-V3.2 ($задача / якорь DS-V3.2). >1 = дороже DS, <1 = дешевле DS (value-якорь). Якоря читаются со вкладки RUST.",
    "Цена за 1 млн входных токенов, USD.",
    "Цена за 1 млн выходных токенов, USD.",
    "Заявленное максимальное окно контекста (по прайсу провайдера).",
    "Поддерживает ли tool-use в ZDR-режиме. yes/no.",
    "Краткий вердикт: для какой роли модель пригодна.",
]


def load(f):
    p = os.path.join(RES, f)
    return json.load(open(p)) if os.path.exists(f if os.path.isabs(f) else p) else None


def safe(model):
    import re
    return re.sub(r"[^a-z0-9]+", "-", model, flags=re.I)


def median_tps():
    calls = []
    for f in ["results-fast100-rust.json", "results-fast100-ts.json", "results-fast100-knowledge.json"]:
        d = load(f)
        if d:
            calls += d
    tps = defaultdict(list)
    for c in calls:
        if c.get("ok") and c.get("tokps") and c.get("tokOut", 0) > 50 and c["tokps"] <= 2000:
            tps[c["model"]].append(c["tokps"])
    return {m: round(statistics.median(v)) for m, v in tps.items()}


def quality(fname):
    rows = load(fname) or []
    agg = defaultdict(list)
    for r in rows:
        if r.get("ok") and r.get("mode") == "single" and r.get("pct") is not None:
            agg[r["model"]].append(r["pct"])
    return {m: round(100 * statistics.mean(v)) for m, v in agg.items() if v}


def task_cost():
    cost = defaultdict(list)
    for f in ["results-fast100-rust.json", "results-fast100-ts.json"]:
        for r in (load(f) or []):
            if r.get("ok") and r.get("cost"):
                cost[r["model"]].append(r["cost"])
    return {m: round(statistics.median(v), 5) for m, v in cost.items() if v}


def tool_metrics():
    rows = load("results-fast300-tooluse.json") or []
    succ = defaultdict(list)
    valid = defaultdict(list)
    for r in rows:
        if not r.get("ok"):
            continue
        succ[r["model"]].append(1 if r.get("success") else 0)
        valid[r["model"]].append(r.get("validRate", 0))
    out = {}
    for m in set(list(succ) + list(valid)):
        out[m] = {
            "ok": round(100 * statistics.mean(succ[m])) if succ.get(m) else None,
            "valid": round(100 * statistics.mean(valid[m])) if valid.get(m) else None,
        }
    return out


def longctx_metrics(model):
    """Single-needle overall% + real reachable ceiling (max actual promptTok served).

    For a "multi-agent" model the billed promptTok is inflated ~6-9× by internal prompt
    replication (grok-4.20-multi-agent processed 2.95M tokens for a 500k-token document), so
    that number is NOT a context ceiling. For such models we report the document size (targetTok)
    instead; the raw billed promptTok stays in the JSON and is discussed in the report.
    """
    rows = load(f"results-{safe(model)}-longctx.json") or []
    ok = [r for r in rows if r.get("ok")]
    if not ok:
        return {"needle": None, "reach_k": None}
    needle = round(100 * statistics.mean([1 if r["found"] else 0 for r in ok]))
    if "multi-agent" in model:
        reach = max(r.get("targetTok", 0) for r in ok)
    else:
        reach = max(r.get("promptTok", 0) for r in ok)
    return {"needle": needle, "reach_k": round(reach / 1000)}


def multineedle_metrics(model):
    """Recall of 8 spread codes at the DEEPEST completed rung (the discriminating number)."""
    rows = load(f"results-{safe(model)}-multineedle.json") or []
    ok = [r for r in rows if r.get("ok")]
    if not ok:
        return {"multi": None}
    deepest = max(ok, key=lambda r: r.get("promptTok", 0))
    return {"multi": round(100 * deepest["recall"])}


def verdict(row):
    """Short role tag from the measured numbers."""
    tool = row["tool_ok"]
    multi = row["multi"] or 0
    cost = row["cost"] or 0
    if row["tools"] == "no":
        return "Без tool-use — только чат/суммаризация/длинный контекст"
    if tool is not None and tool >= 100 and multi >= 90 and cost <= 0.005:
        return "★ Универсал: агент + весь контекст, дёшево"
    if tool is not None and tool >= 100 and cost <= 0.002:
        return "Дешёвый высоконагруженный агент"
    if multi >= 90:
        return "Силён на полном длинном контексте"
    if tool is not None and tool < 34:
        return "Ненадёжен в tool-loop — избегать в агентах"
    return "Ограниченно годен"


def read_anchors(ss):
    """Read Opus-4.8 and DS-V3.2 single-task cost anchors straight from the RUST tab (col G, index
    6) as UNFORMATTED numbers. Keeps the fast300 ratios in one language with the rest of the sheet
    and avoids hardcoding — if the RUST anchors change, this follows. Google Sheet is the ONLY
    source of truth here (no xlsx)."""
    vals = ss.values().get(spreadsheetId=SID, range="'RUST'!A1:G90",
                           valueRenderOption="UNFORMATTED_VALUE").execute().get("values", [])
    opus = ds = None
    for row in vals:
        if not row:
            continue
        name = str(row[0]).lower()
        cost = row[6] if len(row) > 6 else None
        if isinstance(cost, (int, float)):
            if opus is None and "opus" in name:
                opus = cost
            # match DS-V3.2 SPECIFICALLY (not deepseek-v4-flash, which also contains "deepseek")
            if ds is None and "v3.2" in name:
                ds = cost
    return opus, ds


def build_rows(opus_anchor=None, ds_anchor=None):
    meta = load("or-models-meta.json") or {}
    metaf = load("META-fast100.json") or {}
    tps = median_tps()
    rq = quality("results-fast100-rust.json")
    tqv = quality("results-fast100-ts.json")
    hum = load("hum-scores-fast100.json") or {}
    cst = task_cost()
    tools = tool_metrics()

    out = [HEADERS]
    for m in MODELS:
        mm = meta.get(m, {})
        mf = metaf.get(m, ["", "", "", ""])
        name = mf[0] or m.split("/")[-1]
        price = mf[2] if len(mf) > 2 else ""
        pin, pout = "", ""
        if "/" in str(price):
            pin, pout = price.split("/", 1)
        lc = longctx_metrics(m)
        mn = multineedle_metrics(m)
        t = tools.get(m, {})
        row = {
            "name": name, "tps": tps.get(m, ""),
            "tool_ok": t.get("ok"), "valid": t.get("valid"),
            "needle": lc["needle"], "multi": mn["multi"], "reach_k": lc["reach_k"],
            "rust": rq.get(m), "ts": tqv.get(m),
            "know": hum.get(m, {}).get("avg"),
            "cost": cst.get(m), "pin": pin, "pout": pout,
            "ctx": mf[3] if len(mf) > 3 else "",
            "tools": "yes" if mm.get("tools") else "no",
        }
        row["verdict"] = verdict(row)
        # cost ratios vs the two anchors (only when we have both a task cost and the anchor)
        c = row["cost"]
        vs_opus = round(opus_anchor / c, 1) if (opus_anchor and c) else None
        vs_ds = round(c / ds_anchor, 2) if (ds_anchor and c) else None
        na = lambda v: "N/A" if v is None else v
        out.append([
            row["name"], row["tps"], na(row["tool_ok"]), na(row["valid"]),
            na(row["needle"]), na(row["multi"]), na(row["reach_k"]),
            na(row["rust"]), na(row["ts"]), na(row["know"]), na(row["cost"]),
            na(vs_opus), na(vs_ds),
            row["pin"], row["pout"], row["ctx"], row["tools"], row["verdict"],
        ])
    return [["" if v is None else v for v in r] for r in out]


def grad(sid, col, nrows, vmax, reverse=False):
    """Fixed 0..vmax gradient (higher=greener). Used for the 0-100 / 0-10 / speed columns so the
    colour reflects the ABSOLUTE scale (100% is green in every quality column)."""
    return {"addConditionalFormatRule": {"index": 0, "rule": {
        "ranges": [{"sheetId": sid, "startRowIndex": 1, "endRowIndex": nrows,
                    "startColumnIndex": col, "endColumnIndex": col + 1}],
        "gradientRule": {
            "minpoint": {"color": RED, "type": "NUMBER", "value": "0"},
            "midpoint": {"color": YEL, "type": "NUMBER", "value": "%g" % (vmax / 2)},
            "maxpoint": {"color": GRN, "type": "NUMBER", "value": "%g" % vmax},
        }}}}


def grad_auto(sid, col, nrows, greener="max"):
    """AUTO gradient scaled to the column's own MIN/MAX (avoids fragile NUMBER values). greener=
    'min' → smallest value green (cost: cheaper=better); 'max' → largest value green (ratio
    "×дешевле Opus": bigger=cheaper=better)."""
    lo, hi = (GRN, RED) if greener == "min" else (RED, GRN)
    return {"addConditionalFormatRule": {"index": 0, "rule": {
        "ranges": [{"sheetId": sid, "startRowIndex": 1, "endRowIndex": nrows,
                    "startColumnIndex": col, "endColumnIndex": col + 1}],
        "gradientRule": {
            "minpoint": {"color": lo, "type": "MIN"},
            "midpoint": {"color": YEL, "type": "PERCENTILE", "value": "50"},
            "maxpoint": {"color": hi, "type": "MAX"},
        }}}}


def grad_cost(sid, col, nrows):
    """Backward-compatible alias: cost column, cheaper (MIN) green."""
    return grad_auto(sid, col, nrows, greener="min")


def main():
    sheets = build("sheets", "v4", credentials=credentials())
    ss = sheets.spreadsheets()
    opus_anchor, ds_anchor = read_anchors(ss)
    print(f"anchors from RUST tab: Opus=${opus_anchor} DS-V3.2=${ds_anchor}")
    data = build_rows(opus_anchor, ds_anchor)
    nrows, ncols = len(data), len(data[0])

    meta = ss.get(spreadsheetId=SID, fields="sheets(properties(title,sheetId),conditionalFormats,tables(tableId,range),bandedRanges(bandedRangeId))").execute()
    existing = {sh["properties"]["title"]: sh for sh in meta["sheets"]}

    if TAB not in existing:
        rep = ss.batchUpdate(spreadsheetId=SID, body={"requests": [{"addSheet": {"properties": {"title": TAB}}}]}).execute()
        sid = rep["replies"][0]["addSheet"]["properties"]["sheetId"]
        sh_meta = {"properties": {"title": TAB, "sheetId": sid}}
    else:
        sh_meta = existing[TAB]
        sid = sh_meta["properties"]["sheetId"]

    # write values
    ss.values().update(spreadsheetId=SID, range=f"'{TAB}'!A1",
                       valueInputOption="RAW", body={"values": data}).execute()

    reqs = []
    # clear prior gradient rules on this sheet (idempotent)
    # Сносим ТОЛЬКО свои градиенты (см. gsheets_common.delete_own_rules).
    reqs += delete_own_rules(sh_meta.get("conditionalFormats", []), sid)
    # freeze + bold header
    reqs.append({"updateSheetProperties": {"properties": {
        "sheetId": sid, "gridProperties": {"frozenRowCount": 1, "frozenColumnCount": 1}},
        "fields": "gridProperties.frozenRowCount,gridProperties.frozenColumnCount"}})
    reqs.append({"repeatCell": {
        "range": {"sheetId": sid, "startRowIndex": 0, "endRowIndex": 1},
        "cell": {"userEnteredFormat": {"textFormat": {"bold": True},
                 "backgroundColor": {"red": 0.85, "green": 0.89, "blue": 0.95},
                 "wrapStrategy": "WRAP", "verticalAlignment": "MIDDLE"}},
        "fields": "userEnteredFormat(textFormat,backgroundColor,wrapStrategy,verticalAlignment)"}})
    # widths: model col + verdict col wider
    reqs.append({"updateDimensionProperties": {
        "range": {"sheetId": sid, "dimension": "COLUMNS", "startIndex": 0, "endIndex": 1},
        "properties": {"pixelSize": 240}, "fields": "pixelSize"}})
    reqs.append({"updateDimensionProperties": {
        "range": {"sheetId": sid, "dimension": "COLUMNS", "startIndex": 17, "endIndex": 18},
        "properties": {"pixelSize": 340}, "fields": "pixelSize"}})
    # Explicit widths instead of autoResize: with WRAP headers, autoResize collapses numeric
    # columns to ~30px, wrapping the header one-letter-per-line. Fixed widths keep headers on 2
    # tidy lines. (col 0 model=240, col 17 verdict=340 set above.)
    def width(a, b, px):
        reqs.append({"updateDimensionProperties": {
            "range": {"sheetId": sid, "dimension": "COLUMNS", "startIndex": a, "endIndex": b},
            "properties": {"pixelSize": px}, "fields": "pixelSize"}})
    width(1, 15, 88)     # tok/s .. $/1M out — numeric block
    width(6, 7, 108)     # "Ctx reach (k tok)" needs a touch more
    width(15, 16, 96)    # Контекст
    width(16, 17, 62)    # Tools
    # taller header row so 2-line wrapped titles fit
    reqs.append({"updateDimensionProperties": {
        "range": {"sheetId": sid, "dimension": "ROWS", "startIndex": 0, "endIndex": 1},
        "properties": {"pixelSize": 56}, "fields": "pixelSize"}})
    # header notes
    reqs.append({"updateCells": {
        "range": {"sheetId": sid, "startRowIndex": 0, "endRowIndex": 1,
                  "startColumnIndex": 0, "endColumnIndex": len(HEADER_DOCS)},
        "rows": [{"values": [{"note": d} for d in HEADER_DOCS]}], "fields": "note"}})
    # gradients: higher-is-better on speed & quality; lower-is-better on cost cols
    reqs.append(grad(sid, 1, nrows, 450))          # tok/s
    for col in (2, 3, 4, 5):                        # tool ok, valid, needle, multi-8 (0-100)
        reqs.append(grad(sid, col, nrows, 100))
    reqs.append(grad(sid, 6, nrows, 800))          # ctx reach (k tok), higher greener
    for col in (7, 8):                              # rust, ts (0-100)
        reqs.append(grad(sid, col, nrows, 100))
    reqs.append(grad(sid, 9, nrows, 10))           # знания (0-10)
    reqs.append(grad_cost(sid, 10, nrows))         # $/task (cheaper greener)
    reqs.append(grad_auto(sid, 11, nrows, greener="max"))  # ×дешевле Opus (bigger=cheaper=green)
    reqs.append(grad_cost(sid, 12, nrows))         # ×к DS-V3.2 (lower=cheaper=green)
    reqs.append(grad_cost(sid, 13, nrows))         # $/1M in
    reqs.append(grad_cost(sid, 14, nrows))         # $/1M out

    ss.batchUpdate(spreadsheetId=SID, body={"requests": reqs}).execute()

    # native logical Table (separate call: addTable can conflict with CF in one batch)
    has_table = bool(sh_meta.get("tables"))
    if not has_table:
        try:
            ss.batchUpdate(spreadsheetId=SID, body={"requests": [{"addTable": {"table": {
                "name": "Fast300", "range": {
                    "sheetId": sid, "startRowIndex": 0, "endRowIndex": nrows,
                    "startColumnIndex": 0, "endColumnIndex": ncols}}}}]}).execute()
            print("logical Table 'Fast300' created")
        except Exception as e:
            print(f"addTable skipped ({str(e)[:80]}); banding+gradient still applied")
    else:
        tid = sh_meta["tables"][0]["tableId"]
        ss.batchUpdate(spreadsheetId=SID, body={"requests": [{"updateTable": {"table": {
            "tableId": str(tid), "range": {
                "sheetId": sid, "startRowIndex": 0, "endRowIndex": nrows,
                "startColumnIndex": 0, "endColumnIndex": ncols}}, "fields": "range"}}]}).execute()
        print("logical Table range extended")

    print(f"pushed '{TAB}': {nrows-1} models × {ncols} cols")
    print(f"https://docs.google.com/spreadsheets/d/{SID}/edit")


if __name__ == "__main__":
    main()
