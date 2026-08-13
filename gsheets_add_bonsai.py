"""Append the 8 Bonsai (PrismML) models to RUST / humanitarian / TypeScript tabs — LOCAL convention.

Derived from gsheets_add_models.py: SAME append/table/gradient machinery (existing rows never
rewritten, table range + red→yellow→green gradients extended over new rows, idempotent by display
name). Differences vs the cloud path:
  * loads the bonsai result files (results-bonsai-*.json + hum-scores-bonsai.json);
  * emits LOCAL column conventions matching existing local rows (ornith/Heretic/…):
    группа=local, cost columns=local, ratio columns=n/a, provider="local (llama.cpp)";
  * reasoning forced "yes" (Bonsai reason inline in content → reasonTok=0, but they ARE reasoners);
  * CTX = the benchmark run context (8192 → "8k").

DRY_RUN=1 (default) prints the planned rows and writes nothing. Set DRY_RUN=0 to push.
    DRY_RUN=1 .venv-gsheets/bin/python gsheets_add_bonsai.py     # preview
    DRY_RUN=0 .venv-gsheets/bin/python gsheets_add_bonsai.py     # push
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

# 8 Bonsai models. mid == display name (no slash) → short(mid)==mid.
MODELS = ["Ternary-Bonsai-27B", "Ternary-Bonsai-8B", "Ternary-Bonsai-4B", "Ternary-Bonsai-1.7B",
          "Bonsai-27B", "Bonsai-8B", "Bonsai-4B", "Bonsai-1.7B"]
GROUP = "local"
PROV = "local (llama.cpp)"          # PrismML llama.cpp fork on gaming-pc RTX 3090
CTX_LABEL = "8k"                    # benchmark ran at -c 8192
REASONING = "yes"                   # inline reasoning (reasonTok=0 but they reason in content)

RED = {"red": 0.97, "green": 0.41, "blue": 0.42}
YEL = {"red": 1, "green": 0.92, "blue": 0.52}
GRN = {"red": 0.39, "green": 0.75, "blue": 0.48}
GRAD = {
    "RUST":         {3: 100, 5: 100, 9: 100},
    "humanitarian": {2: 10, 3: 10, 4: 10, 5: 10, 6: 10, 7: 10},
    "TypeScript":   {3: 100, 5: 100, 9: 100, 11: 100},
}


def load(name):
    p = os.path.join(RES, name)
    return json.load(open(p)) if os.path.exists(p) else []


def med(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 1) if xs else None


# ---- aggregations (identical semantics to gsheets_add_models.py) ----
def rust_agg(rows, mid):
    s = [r for r in rows if r["model"] == mid and r["mode"] == "single" and r.get("ok")]
    a = [r for r in rows if r["model"] == mid and r["mode"] == "agentic" and r.get("ok") and not r.get("err")]
    if not s:
        return None
    tokps = med([r["tokps"] for r in s if r.get("tokps")])
    out = dict(
        S=round(100 * sum(r["pct"] for r in s) / len(s)),
        full=f"{sum(1 for r in s if r['pct'] >= 0.999)}/{len(s)}",
        cmp=round(100 * sum(1 for r in s if r["compiles"]) / len(s)),
        medLat=med([r["latency"] for r in s]),
        medRsn=round(med([r.get("reasonTok", 0) for r in s]) or 0),
        tokps=tokps,
        ttft=(lambda t: round(t, 2) if t is not None else None)(med([r["ttft"] for r in s if r.get("ttft") is not None])),
    )
    if a:
        out["A"] = round(100 * sum(r["pct"] for r in a) / len(a))
        out["grn"] = f"{sum(1 for r in a if r.get('visibleGreen'))}/{len(a)}"
    return out


def know_agg(rows, mid):
    kc = [r for r in rows if r["model"] == mid and r.get("ok")]
    if not kc:
        return {}
    return dict(tokps=med([r["tokps"] for r in kc if r.get("tokps")]),
                ttft=(lambda t: round(t, 2) if t is not None else None)(med([r["ttft"] for r in kc if r.get("ttft") is not None])))


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
    rust_rows = load("results-bonsai-rust.json")
    ts_rows = load("results-bonsai-ts.json")
    know_rows = load("results-bonsai-knowledge.json")
    hum_scores = json.load(open(os.path.join(RES, "hum-scores-bonsai.json")))

    ss = build("sheets", "v4", credentials=credentials()).spreadsheets()
    meta = ss.get(spreadsheetId=SID, fields="sheets(properties(title,sheetId),conditionalFormats,tables(tableId,range),bandedRanges(bandedRangeId))").execute()
    tabs = {sh["properties"]["title"]: sh for sh in meta["sheets"]}

    def values(tab, rng):
        return ss.values().get(spreadsheetId=SID, range=f"'{tab}'!{rng}",
                               valueRenderOption="UNFORMATTED_VALUE").execute().get("values", [])
    v_ru = values("RUST", "A1:T200")
    v_hu = values("humanitarian", "A1:R200")
    v_ts = values("TypeScript", "A1:Q200")
    have_ru = {str(r[0]).strip() for r in v_ru[1:] if r}
    have_hu = {str(r[0]).strip() for r in v_hu[1:] if r}
    have_ts = {str(r[0]).strip() for r in v_ts[1:] if r}

    add_ru, add_hu, add_ts = [], [], []
    for nm in MODELS:
        ra = rust_agg(rust_rows, nm)
        if ra and nm not in have_ru:
            add_ru.append([nm, GROUP, "local", ra["S"], ra["full"], ra["cmp"], "local",
                           ra["medLat"], ra["medRsn"], na(ra.get("A")), ra.get("grn", "n/a"), "local",
                           "n/a", "n/a", CTX_LABEL, "yes", PROV, REASONING,
                           na(ra["tokps"]), na(ra["ttft"])])

        sc = hum_scores.get(nm)
        if sc and nm not in have_hu:
            ka = know_agg(know_rows, nm)
            avg = sc.get("avg") or round((sc["facts"] + sc["ideas"] + sc["fermi"] + sc["forecast"] + sc["analysis"]) / 5, 2)
            add_hu.append([nm, GROUP, sc["facts"], sc["ideas"], sc["fermi"], sc["forecast"], sc["analysis"],
                           avg, "local", sc.get("empties", 0), "n/a", "n/a", CTX_LABEL, "yes", PROV, REASONING,
                           na(ka.get("tokps")), na(ka.get("ttft"))])

        ta = ts_agg(ts_rows, nm)
        if ta and nm not in have_ts:
            add_ts.append([nm, GROUP, "local", na(ta["S"]), ta["full"], na(ta["typp"]), "",
                           na(ta["medLat"]), na(ta["medRsn"]), na(ta["A"]), ta["green"],
                           na(ta["toolValid"]), ta["recovered"], CTX_LABEL, REASONING,
                           na(ta["tokps"]), na(ta["ttft"])])

    plan = {"RUST": (v_ru, add_ru, 20, ["Модель","группа","бленд$/1M","S%","full/n","cmp%","$/зад","medLat","medRsn","A%","grn/n","$/зад ag","overDS","cheaperOpus","CTX","ZDRtool","провайдер","reason","tok/s","TTFT"]),
            "humanitarian": (v_hu, add_hu, 18, ["Модель","группа","facts","ideas","fermi","forecast","analysis","ср.балл","$/зад","пустых","cheaperOpus","overDS","CTX","ZDRtool","провайдер","reason","tok/s","TTFT"]),
            "TypeScript": (v_ts, add_ts, 17, ["Модель","группа","цена","S%","full-n","type%","$/зад","medLat","medRsn","A%","green-n","toolValid","recov","CTX","reason","tok/s","TTFT"])}

    print(f"{'='*70}\nDRY_RUN={DRY}  (set DRY_RUN=0 to push)\n{'='*70}")
    for tab, (cur, rows_add, ncol, hdr) in plan.items():
        print(f"\n### {tab}: appending {len(rows_add)} rows after existing {len(cur)} rows")
        print("  cols:", " | ".join(hdr))
        for r in rows_add:
            print("  +", r)

    if DRY:
        print("\n[DRY RUN] nothing written. Re-run with DRY_RUN=0 to push.")
        return

    reqs, wrote = [], {}
    for tab, (cur, rows_add, ncol, hdr) in plan.items():
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
        # Сносим ТОЛЬКО свои градиенты: слепой цикл по всем правилам убивал ручные
        # правила владельца (см. gsheets_common.delete_own_rules).
        reqs += delete_own_rules(sh.get("conditionalFormats", []), sid)
        for col, vmax in GRAD[tab].items():
            reqs.append(gradient_rule(sid, col, newn, vmax))

    if reqs:
        ss.batchUpdate(spreadsheetId=SID, body={"requests": reqs}).execute()
    print("\nappended:", wrote or "nothing (all present)")
    print(f"https://docs.google.com/spreadsheets/d/{SID}/edit")


if __name__ == "__main__":
    main()
