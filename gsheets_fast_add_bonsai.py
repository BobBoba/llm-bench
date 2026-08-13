"""Append the two 300+ tok/s Bonsai models (both 1.7B) to the existing 'Fast (300+ tps)' tab.

APPEND-only (does NOT rebuild the tab, so the 11 curated cloud rows are untouched). Bonsai were
not run on this tab's long-context / tool-use batteries, so those columns are N/A. Extends the
logical table + re-issues the tab's existing conditional-format (gradient) rules over the new
extent so colouring covers the new rows without hardcoding the custom fixed/auto gradient mix.

Columns (18): Модель | tok/s | Tool ok% | Valid% | Needle% | Multi-8% | Ctx reach | RUST% | TS% |
Знания | $/задача | ×деш Opus | ×к DS-V3.2 | $/1M in | $/1M out | Контекст | Tools | Вердикт

    DRY_RUN=1 .venv-gsheets/bin/python gsheets_fast_add_bonsai.py   # preview
    DRY_RUN=0 .venv-gsheets/bin/python gsheets_fast_add_bonsai.py   # push
"""
import os
import json
import statistics
from googleapiclient.discovery import build
from gsheets_common import credentials, OWN_MINPOINTS, _same_color

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "results")
SID = open(os.path.join(HERE, "gsheets-sheet-id.txt")).read().strip()
TAB = "Fast (300+ tps)"
DRY = os.environ.get("DRY_RUN", "1") != "0"

# both 1.7B qualify (>300 tok/s); 4B/8B/27B are slower and stay off this tab
MODELS = ["Bonsai-1.7B", "Ternary-Bonsai-1.7B"]
NCOLS = 18


def load(name):
    p = os.path.join(RES, name)
    return json.load(open(p)) if os.path.exists(p) else []


def med(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 1) if xs else None


def main():
    rust = load("results-bonsai-rust.json")
    ts = load("results-bonsai-ts.json")
    know = load("results-bonsai-knowledge.json")
    hum = json.load(open(os.path.join(RES, "hum-scores-bonsai.json")))

    def tps(mid):
        xs = [r["tokps"] for src in (rust, ts, know)
              for r in src if r["model"] == mid and r.get("ok") and r.get("mode", "single") == "single" and r.get("tokps")]
        # knowledge records have no 'mode'; include them
        xs += [r["tokps"] for r in know if r["model"] == mid and r.get("ok") and r.get("tokps")]
        return med(xs)

    def passpct(src, mid):
        rs = [r for r in src if r["model"] == mid and r.get("ok")]
        return round(100 * sum(r["pct"] for r in rs) / len(rs)) if rs else None

    ss = build("sheets", "v4", credentials=credentials()).spreadsheets()
    meta = ss.get(spreadsheetId=SID, fields="sheets(properties(title,sheetId),conditionalFormats,tables(tableId,range))").execute()
    tabs = {sh["properties"]["title"]: sh for sh in meta["sheets"]}
    sh = tabs[TAB]
    sid = sh["properties"]["sheetId"]
    cur = ss.values().get(spreadsheetId=SID, range=f"'{TAB}'!A1:R200",
                          valueRenderOption="UNFORMATTED_VALUE").execute().get("values", [])
    have = {str(r[0]).strip() for r in cur[1:] if r}

    rows = []
    for mid in MODELS:
        if mid in have:
            continue
        verdict = "самая быстрая в наборе (~380 tok/s), но качество низкое: знания низкие, код ≈0%" if mid == "Bonsai-1.7B" \
            else "быстрая (~350 tok/s), знания/код слабые — скорость ради скорости"
        rows.append([
            mid, tps(mid), "N/A", "N/A", "N/A", "N/A", "N/A",
            passpct(rust, mid), passpct(ts, mid), hum.get(mid, {}).get("avg"),
            "local", "N/A", "N/A", "local", "", "8k", "yes", verdict,
        ])

    print(f"DRY_RUN={DRY}  TAB='{TAB}' existing rows={len(cur)}  appending={len(rows)}")
    print("cols:", "Модель|tok/s|Toolok|Valid|Needle|Multi8|Ctxreach|RUST%|TS%|Знания|$/зад|×Opus|×DS|$in|$out|Ctx|Tools|Вердикт")
    for r in rows:
        print("  +", r)
    if DRY:
        print("[DRY] nothing written.")
        return
    if not rows:
        print("nothing to add (already present).")
        return

    last = len(cur)
    ss.values().update(spreadsheetId=SID, range=f"'{TAB}'!A{last+1}",
                       valueInputOption="RAW", body={"values": rows}).execute()
    newn = last + len(rows)
    reqs = []
    if sh.get("tables"):
        tid = sh["tables"][0]["tableId"]
        reqs.append({"updateTable": {"table": {"tableId": str(tid), "range": {
            "sheetId": sid, "startRowIndex": 0, "endRowIndex": newn,
            "startColumnIndex": 0, "endColumnIndex": NCOLS}}, "fields": "range"}})
    # re-issue existing gradient rules over the new extent (preserve custom fixed/auto mix)
    # Растягиваем на новый диапазон строк ТОЛЬКО СВОИ градиенты.
    # ! Прежняя версия сносила все правила и пересоздавала их, переписывая endRowIndex у КАЖДОГО —
    #   ручное правило владельца на всю колонку (1:1000) при этом усыхало до числа строк таблицы.
    #   Формально оно выживало, но переставало красить новые строки, что читается как «пропало».
    existing_cf = sh.get("conditionalFormats", [])
    mine = [(i, cf) for i, cf in enumerate(existing_cf)
            if cf.get("gradientRule") and any(
                _same_color(cf["gradientRule"].get("minpoint", {}).get("color", {}), c)
                for c in OWN_MINPOINTS)]
    for i, _ in sorted(mine, key=lambda kv: -kv[0]):
        reqs.append({"deleteConditionalFormatRule": {"sheetId": sid, "index": i}})
    for _, cf in mine:
        rule = cf
        for rng in rule.get("ranges", []):
            if rng.get("sheetId") == sid:
                rng["endRowIndex"] = newn
        reqs.append({"addConditionalFormatRule": {"index": 0, "rule": rule}})
    if reqs:
        ss.batchUpdate(spreadsheetId=SID, body={"requests": reqs}).execute()
    print(f"appended {len(rows)} rows to '{TAB}'.")
    print(f"https://docs.google.com/spreadsheets/d/{SID}/edit")


if __name__ == "__main__":
    main()
