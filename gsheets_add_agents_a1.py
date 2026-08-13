"""Append Agents-A1 (InternScience, 35B-A3B qwen35moe) to RUST + TypeScript tabs — LOCAL convention.

Same append/table/gradient machinery as gsheets_add_bonsai.py (existing rows never rewritten,
table range + gradients extended, idempotent by display name). Reads THIS session's result files
(results-agents-a1-{rust,ts}.json) and emits local-column rows matching ornith/cascade/bonsai.

No humanitarian row — knowledge suite was not run for agents-a1.

DRY_RUN=1 (default) previews; DRY_RUN=0 pushes.
    DRY_RUN=1 .venv-gsheets/bin/python gsheets_add_agents_a1.py
    DRY_RUN=0 .venv-gsheets/bin/python gsheets_add_agents_a1.py
"""
import os
import json
import statistics
from googleapiclient.discovery import build
from gsheets_common import credentials, delete_own_rules

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "results")
SID = open(os.path.join(HERE, "gsheets-sheet-id.txt")).read().strip()
DRY = os.environ.get("DRY_RUN", "1") != "0"

# display name -> model id in the result JSONs
NAME_MAP = {"Agents-A1-35B": "agents-a1"}
GROUP = "local"
PROV = "local (llama.cpp)"          # LM Studio (llama.cpp) on gaming-pc RTX 3090
CTX_LABEL = "8k"                    # benchmark ran at -c 8192
REASONING = "yes"                   # agents-a1 is a reasoner (real reasonTok, huge)

RED = {"red": 0.97, "green": 0.41, "blue": 0.42}
YEL = {"red": 1, "green": 0.92, "blue": 0.52}
GRN = {"red": 0.39, "green": 0.75, "blue": 0.48}
GRAD = {"RUST": {3: 100, 5: 100, 9: 100}, "TypeScript": {3: 100, 5: 100, 9: 100, 11: 100}}


def load(name):
    p = os.path.join(RES, name)
    return json.load(open(p)) if os.path.exists(p) else []


def med(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 1) if xs else None


def rust_agg(rows, mid):
    s = [r for r in rows if r["model"] == mid and r["mode"] == "single" and r.get("ok")]
    a = [r for r in rows if r["model"] == mid and r["mode"] == "agentic" and r.get("ok") and not r.get("err")]
    if not s:
        return None
    out = dict(
        S=round(100 * sum(r["pct"] for r in s) / len(s)),
        full=f"{sum(1 for r in s if r['pct'] >= 0.999)}/{len(s)}",
        cmp=round(100 * sum(1 for r in s if r["compiles"]) / len(s)),
        medLat=med([r["latency"] for r in s]),
        medRsn=round(med([r.get("reasonTok", 0) for r in s]) or 0),
        tokps=med([r["tokps"] for r in s if r.get("tokps")]),
        ttft=(lambda t: round(t, 2) if t is not None else None)(med([r["ttft"] for r in s if r.get("ttft") is not None])),
    )
    if a:
        out["A"] = round(100 * sum(r["pct"] for r in a) / len(a))
        out["grn"] = f"{sum(1 for r in a if r.get('visibleGreen'))}/{len(a)}"
    return out


def ts_agg(rows, mid):
    single = [r for r in rows if r["model"] == mid and r.get("mode") == "single" and r.get("ok")]
    agentic = [r for r in rows if r["model"] == mid and r.get("mode") == "agentic" and r.get("ok") and not r.get("err")]
    if not single and not agentic:
        return None
    return dict(
        S=round(100 * sum(r["pct"] for r in single) / len(single)) if single else None,
        full=f"{sum(1 for r in single if r['pct'] >= 0.999)}/{len(single)}" if single else "—",
        typp=round(100 * sum(1 for r in single if r.get("typechecks")) / len(single)) if single else None,
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


def gradient_rule(sid, col, nrows, vmax):
    return {"addConditionalFormatRule": {"index": 0, "rule": {
        "ranges": [{"sheetId": sid, "startRowIndex": 1, "endRowIndex": nrows,
                    "startColumnIndex": col, "endColumnIndex": col + 1}],
        "gradientRule": {
            "minpoint": {"color": RED, "type": "NUMBER", "value": "0"},
            "midpoint": {"color": YEL, "type": "NUMBER", "value": "%g" % (vmax / 2)},
            "maxpoint": {"color": GRN, "type": "NUMBER", "value": "%g" % vmax}}}}}


def main():
    rust_rows = load("results-agents-a1-rust.json")
    ts_rows = load("results-agents-a1-ts.json")

    ss = build("sheets", "v4", credentials=credentials()).spreadsheets()
    meta = ss.get(spreadsheetId=SID, fields="sheets(properties(title,sheetId),conditionalFormats,tables(tableId,range))").execute()
    tabs = {sh["properties"]["title"]: sh for sh in meta["sheets"]}

    def values(tab, rng):
        return ss.values().get(spreadsheetId=SID, range=f"'{tab}'!{rng}",
                               valueRenderOption="UNFORMATTED_VALUE").execute().get("values", [])
    v_ru = values("RUST", "A1:T200")
    v_ts = values("TypeScript", "A1:Q200")
    have_ru = {str(r[0]).strip() for r in v_ru[1:] if r}
    have_ts = {str(r[0]).strip() for r in v_ts[1:] if r}

    add_ru, add_ts = [], []
    for disp, mid in NAME_MAP.items():
        ra = rust_agg(rust_rows, mid)
        if ra and disp not in have_ru:
            add_ru.append([disp, GROUP, "local", ra["S"], ra["full"], ra["cmp"], "local",
                           ra["medLat"], ra["medRsn"], na(ra.get("A")), ra.get("grn", "n/a"), "local",
                           "n/a", "n/a", CTX_LABEL, "yes", PROV, REASONING,
                           na(ra["tokps"]), na(ra["ttft"])])
        ta = ts_agg(ts_rows, mid)
        if ta and disp not in have_ts:
            add_ts.append([disp, GROUP, "local", na(ta["S"]), ta["full"], na(ta["typp"]), "",
                           na(ta["medLat"]), na(ta["medRsn"]), na(ta["A"]), ta["green"],
                           na(ta["toolValid"]), ta["recovered"], CTX_LABEL, REASONING,
                           na(ta["tokps"]), na(ta["ttft"])])

    plan = {"RUST": (v_ru, add_ru, 20), "TypeScript": (v_ts, add_ts, 17)}
    print(f"{'='*70}\nDRY_RUN={DRY}  (set DRY_RUN=0 to push)\n{'='*70}")
    for tab, (cur, rows_add, ncol) in plan.items():
        print(f"\n### {tab}: appending {len(rows_add)} rows after existing {len(cur)} rows")
        for r in rows_add:
            print("  +", r)
    if DRY:
        print("\n[DRY RUN] nothing written. Re-run with DRY_RUN=0 to push.")
        return

    reqs, wrote = [], {}
    for tab, (cur, rows_add, ncol) in plan.items():
        if not rows_add:
            continue
        sh = tabs[tab]
        sid = sh["properties"]["sheetId"]
        last = len(cur)
        ss.values().update(spreadsheetId=SID, range=f"'{tab}'!A{last+1}",
                           valueInputOption="RAW", body={"values": rows_add}).execute()
        newn = last + len(rows_add)
        wrote[tab] = len(rows_add)
        if sh.get("tables"):
            tid = sh["tables"][0]["tableId"]
            reqs.append({"updateTable": {"table": {"tableId": str(tid), "range": {
                "sheetId": sid, "startRowIndex": 0, "endRowIndex": newn,
                "startColumnIndex": 0, "endColumnIndex": ncol}}, "fields": "range"}})
        # Сносим ТОЛЬКО свои градиенты (см. gsheets_common.delete_own_rules).
        reqs += delete_own_rules(sh.get("conditionalFormats", []), sid)
        for col, vmax in GRAD[tab].items():
            reqs.append(gradient_rule(sid, col, newn, vmax))

    if reqs:
        ss.batchUpdate(spreadsheetId=SID, body={"requests": reqs}).execute()
    print("\nappended:", wrote or "nothing (all present)")
    print(f"https://docs.google.com/spreadsheets/d/{SID}/edit")


if __name__ == "__main__":
    main()
