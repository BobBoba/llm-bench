"""Build the 'RUST time-to-correct' tab — DERIVED from existing RUST results, no re-run, no xlsx.

Answers: how fast does a model reach a CORRECT Rust solution — counting tasks that FAIL one-shot
but SUCCEED in the agentic tool-loop. For each (model, task):
  * correct = final hidden-suite pass rate >= 99.9%
  * time-to-correct = fastest correct single-shot latency, else the agentic tool-loop wall-clock
    (the realistic "try one-shot, fall back to agentic" path)

Columns: solved-single / solved-agentic / any, median one-shot time, median agentic time,
recovered (failed single→passed agentic) and its median time, and the combined median TTC.

Reads every results-*rust*.json. While the fast100 agentic re-run is in flight the live
fast100 file is partial, so the complete backup is merged in (dedup by model|mode|task|run).

    .venv-gsheets/bin/python gsheets_ttc.py
"""
import os
import glob
import json
import statistics
from collections import defaultdict
from googleapiclient.discovery import build
from gsheets_common import credentials, delete_own_rules

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "..", "results")
SID = open(os.path.join(HERE, "gsheets-sheet-id.txt")).read().strip()
TAB = "RUST time-to-correct"
CORR = 0.999
# complete fast100 agentic backup (live file is partial during the re-run); optional.
FAST100_BAK = os.path.join(os.environ.get("CLAUDE_JOB_DIR", "/tmp"), "tmp", "results-fast100-rust.bak2.json")

RED = {"red": 0.97, "green": 0.41, "blue": 0.42}
YEL = {"red": 1, "green": 0.92, "blue": 0.52}
GRN = {"red": 0.39, "green": 0.75, "blue": 0.48}

HEADERS = ["Модель", "задач", "single✓", "agentic✓", "any✓", "one-shot%", "agentic%",
           "медиана TTC, с", "one-shot время, с", "agentic время, с",
           "recovered", "медиана recovery, с"]
HEADER_DOCS = [
    "Модель / идентификатор (все RUST-когорты бенчмарка).",
    "Сколько RUST-задач модель прогнала.",
    "Задач, решённых в one-shot (≥1 из прогонов дал 100% скрытых тестов).",
    "Задач, решённых в агентском tool-loop (финальные скрытые тесты 100%).",
    "Задач, решённых ЛЮБЫМ путём (one-shot или agentic).",
    "Доля задач, решённых в one-shot, %.",
    "Доля задач, решённых в агентском режиме, %.",
    "Медианное ВРЕМЯ ДО ПРАВИЛЬНОГО результата по задачам: для решённых one-shot — самый быстрый корректный single, иначе — wall-clock агентского цикла. Секунды.",
    "Медианная задержка корректного one-shot (только по задачам, решённым в one-shot), с.",
    "Медианный wall-clock агентского цикла по задачам, решённым агентски, с.",
    "Сколько задач ПАДАЮТ в one-shot, но ДОХОДЯТ в агентском (recovery-случаи).",
    "Медианное время recovery — wall-clock агентского цикла для задач, провалленных one-shot. Секунды.",
]


def med(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 1) if xs else None


def gather():
    files = [f for f in glob.glob(os.path.join(RES, "results-*rust*.json"))
             if os.path.basename(f) != "results-fast100-rust.json"]
    recs = []
    seen = set()
    for f in files + ([FAST100_BAK] if os.path.exists(FAST100_BAK) else []):
        try:
            for r in json.load(open(f)):
                k = (r.get("model"), r.get("mode"), r.get("task"), r.get("run"))
                if k in seen:
                    continue
                seen.add(k)
                recs.append(r)
        except Exception:
            pass
    # also fold the live fast100 file's agentic once the re-run finishes (prefer records with cost)
    return recs


def build_rows():
    recs = gather()
    M = defaultdict(lambda: defaultdict(lambda: {"single": [], "ag": None}))
    for r in recs:
        if not r.get("ok"):
            continue
        d = M[r["model"]][r.get("task")]
        if r["mode"] == "single":
            d["single"].append(r)
        elif r["mode"] == "agentic":
            d["ag"] = r
    out = [HEADERS]
    table = []
    for model, tasks in M.items():
        per = []
        for t, d in tasks.items():
            sc = [s for s in d["single"] if (s.get("pct") or 0) >= CORR]
            ag = d["ag"]
            ag_ok = bool(ag and (ag.get("pct") or 0) >= CORR)
            if sc:
                per.append(("single", min(s["latency"] for s in sc), True, ag_ok))
            elif ag_ok:
                per.append(("agentic", ag.get("latency"), False, True))
            else:
                per.append(("none", None, False, ag_ok))
        n = len(per)
        if not n:
            continue
        single_ok = sum(1 for p in per if p[2])
        ag_solved = sum(1 for p in per if p[3])
        any_ok = sum(1 for p in per if p[0] != "none")
        ttc = med([p[1] for p in per if p[1] is not None])
        one_shot_t = med([p[1] for p in per if p[0] == "single"])
        ag_t = med([d["ag"]["latency"] for t, d in tasks.items()
                    if d["ag"] and (d["ag"].get("pct") or 0) >= CORR and d["ag"].get("latency") is not None])
        recov = [p[1] for p in per if p[0] == "agentic"]
        table.append(dict(
            model=model.split("/")[-1], n=n, single=single_ok, ag=ag_solved, anyok=any_ok,
            oneshot_pct=round(100 * single_ok / n), ag_pct=round(100 * ag_solved / n),
            ttc=ttc, one_shot_t=one_shot_t, ag_t=ag_t,
            recov=len(recov), med_recov=med(recov)))
    # sort: most recoveries first, then fastest TTC
    table.sort(key=lambda r: (-r["recov"], r["ttc"] if r["ttc"] is not None else 9e9))
    na = lambda v: "n/a" if v is None else v
    for r in table:
        out.append([r["model"], r["n"], f'{r["single"]}/{r["n"]}', f'{r["ag"]}/{r["n"]}',
                    f'{r["anyok"]}/{r["n"]}', r["oneshot_pct"], r["ag_pct"], na(r["ttc"]),
                    na(r["one_shot_t"]), na(r["ag_t"]), r["recov"], na(r["med_recov"])])
    return out


def grad(sid, col, nrows, vmax, reverse=False):
    lo, hi = (GRN, RED) if reverse else (RED, GRN)
    return {"addConditionalFormatRule": {"index": 0, "rule": {
        "ranges": [{"sheetId": sid, "startRowIndex": 1, "endRowIndex": nrows,
                    "startColumnIndex": col, "endColumnIndex": col + 1}],
        "gradientRule": {
            "minpoint": {"color": lo, "type": "NUMBER", "value": "0"},
            "midpoint": {"color": YEL, "type": "NUMBER", "value": "%g" % (vmax / 2)},
            "maxpoint": {"color": hi, "type": "NUMBER", "value": "%g" % vmax}}}}}


def grad_time(sid, col, nrows):
    """faster (MIN) green, slower (MAX) red — auto-scaled."""
    return {"addConditionalFormatRule": {"index": 0, "rule": {
        "ranges": [{"sheetId": sid, "startRowIndex": 1, "endRowIndex": nrows,
                    "startColumnIndex": col, "endColumnIndex": col + 1}],
        "gradientRule": {
            "minpoint": {"color": GRN, "type": "MIN"},
            "midpoint": {"color": YEL, "type": "PERCENTILE", "value": "50"},
            "maxpoint": {"color": RED, "type": "MAX"}}}}}


def main():
    data = build_rows()
    nrows, ncols = len(data), len(data[0])
    ss = build("sheets", "v4", credentials=credentials()).spreadsheets()
    meta = ss.get(spreadsheetId=SID, fields="sheets(properties(title,sheetId),conditionalFormats,tables(tableId,range))").execute()
    tabs = {sh["properties"]["title"]: sh for sh in meta["sheets"]}
    if TAB not in tabs:
        rep = ss.batchUpdate(spreadsheetId=SID, body={"requests": [{"addSheet": {"properties": {"title": TAB}}}]}).execute()
        sid = rep["replies"][0]["addSheet"]["properties"]["sheetId"]
        sh = {"properties": {"title": TAB, "sheetId": sid}}
    else:
        sh = tabs[TAB]
        sid = sh["properties"]["sheetId"]
    # clear then write (this tab is fully derived — safe to rewrite)
    ss.values().clear(spreadsheetId=SID, range=f"'{TAB}'").execute()
    ss.values().update(spreadsheetId=SID, range=f"'{TAB}'!A1", valueInputOption="RAW", body={"values": data}).execute()

    reqs = []
    # Сносим ТОЛЬКО свои градиенты (см. gsheets_common.delete_own_rules).
    reqs += delete_own_rules(sh.get("conditionalFormats", []), sid)
    reqs.append({"updateSheetProperties": {"properties": {
        "sheetId": sid, "gridProperties": {"frozenRowCount": 1, "frozenColumnCount": 1}},
        "fields": "gridProperties.frozenRowCount,gridProperties.frozenColumnCount"}})
    reqs.append({"repeatCell": {"range": {"sheetId": sid, "startRowIndex": 0, "endRowIndex": 1},
        "cell": {"userEnteredFormat": {"textFormat": {"bold": True},
                 "backgroundColor": {"red": 0.85, "green": 0.89, "blue": 0.95},
                 "wrapStrategy": "WRAP", "verticalAlignment": "MIDDLE"}},
        "fields": "userEnteredFormat(textFormat,backgroundColor,wrapStrategy,verticalAlignment)"}})
    reqs.append({"updateDimensionProperties": {"range": {"sheetId": sid, "dimension": "COLUMNS", "startIndex": 0, "endIndex": 1}, "properties": {"pixelSize": 260}, "fields": "pixelSize"}})
    reqs.append({"updateDimensionProperties": {"range": {"sheetId": sid, "dimension": "COLUMNS", "startIndex": 1, "endIndex": ncols}, "properties": {"pixelSize": 96}, "fields": "pixelSize"}})
    reqs.append({"updateDimensionProperties": {"range": {"sheetId": sid, "dimension": "ROWS", "startIndex": 0, "endIndex": 1}, "properties": {"pixelSize": 56}, "fields": "pixelSize"}})
    reqs.append({"updateCells": {"range": {"sheetId": sid, "startRowIndex": 0, "endRowIndex": 1, "startColumnIndex": 0, "endColumnIndex": len(HEADER_DOCS)},
                 "rows": [{"values": [{"note": d} for d in HEADER_DOCS]}], "fields": "note"}})
    # gradients: %-cols higher=green; time-cols lower=green (auto)
    reqs.append(grad(sid, 5, nrows, 100))   # one-shot%
    reqs.append(grad(sid, 6, nrows, 100))   # agentic%
    for c in (7, 8, 9, 11):                 # TTC, one-shot time, agentic time, recovery time
        reqs.append(grad_time(sid, c, nrows))
    ss.batchUpdate(spreadsheetId=SID, body={"requests": reqs}).execute()

    # logical table
    sh2 = ss.get(spreadsheetId=SID, fields="sheets(properties(title,sheetId),tables(tableId,range))").execute()
    cur = next(s for s in sh2["sheets"] if s["properties"]["title"] == TAB)
    if cur.get("tables"):
        tid = cur["tables"][0]["tableId"]
        ss.batchUpdate(spreadsheetId=SID, body={"requests": [{"updateTable": {"table": {"tableId": str(tid), "range": {
            "sheetId": sid, "startRowIndex": 0, "endRowIndex": nrows, "startColumnIndex": 0, "endColumnIndex": ncols}}, "fields": "range"}}]}).execute()
    else:
        try:
            ss.batchUpdate(spreadsheetId=SID, body={"requests": [{"addTable": {"table": {"name": "RustTTC", "range": {
                "sheetId": sid, "startRowIndex": 0, "endRowIndex": nrows, "startColumnIndex": 0, "endColumnIndex": ncols}}}}]}).execute()
        except Exception as e:
            print("addTable skipped:", str(e)[:80])
    print(f"pushed '{TAB}': {nrows-1} models × {ncols} cols")
    print(f"https://docs.google.com/spreadsheets/d/{SID}/edit")


if __name__ == "__main__":
    main()
