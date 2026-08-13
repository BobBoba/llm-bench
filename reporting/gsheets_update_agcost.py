"""Update the RUST tab's '$/задача (ag)' column (col L / index 11) with the REAL agentic cost
per fast100 model — PURE Google Sheet, no xlsx.

The agentic cost was $0 because run-rust.mjs (now fixed) didn't sum res.cost in the tool-loop; the
agentic battery was re-run to capture it. This reads the refreshed results-fast100-rust.json,
computes mean agentic cost per model (over runs that actually billed), matches each to its RUST row
by display name (last path segment), and writes only that one cell — nothing else is touched.

    .venv-gsheets/bin/python gsheets_update_agcost.py
"""
import os
import json
import statistics
from collections import defaultdict
from googleapiclient.discovery import build
from gsheets_common import credentials

HERE = os.path.dirname(os.path.abspath(__file__))
SID = open(os.path.join(HERE, "gsheets-sheet-id.txt")).read().strip()
AGCOL_LETTER = "L"   # index 11 = '$/задача (ag)'
AGCOL_INDEX = 11


def agentic_cost_by_model():
    rows = json.load(open(os.path.join(HERE, "results", "results-fast100-rust.json")))
    costs = defaultdict(list)
    for r in rows:
        if r.get("mode") == "agentic" and r.get("ok") and isinstance(r.get("cost"), (int, float)) and r["cost"] > 0:
            costs[r["model"]].append(r["cost"])
    # mean across the (up to 3) tasks; key by display name = last path segment
    out = {}
    for full, cs in costs.items():
        out[full.split("/")[-1]] = round(statistics.mean(cs), 6)
    return out


def main():
    ag = agentic_cost_by_model()
    print(f"agentic cost computed for {len(ag)} models")
    ss = build("sheets", "v4", credentials=credentials()).spreadsheets()
    rows = ss.values().get(spreadsheetId=SID, range="'RUST'!A1:T90",
                           valueRenderOption="UNFORMATTED_VALUE").execute().get("values", [])
    updates, misses = [], []
    for i, r in enumerate(rows[1:], start=1):        # sheet row = i+1
        name = str(r[0]).strip() if r else ""
        if name in ag:
            row_no = i + 1
            updates.append({"range": f"'RUST'!{AGCOL_LETTER}{row_no}", "values": [[ag[name]]]})
    matched = {u["range"] for u in updates}
    for name in ag:
        if not any(True for i, r in enumerate(rows[1:], start=1) if r and str(r[0]).strip() == name):
            misses.append(name)
    if misses:
        print(f"WARN: {len(misses)} models had no RUST row: {misses}")
    if not updates:
        print("nothing to update.")
        return
    ss.values().batchUpdate(spreadsheetId=SID,
                            body={"valueInputOption": "RAW", "data": updates}).execute()
    print(f"updated agentic cost for {len(updates)} RUST rows.")
    print(f"https://docs.google.com/spreadsheets/d/{SID}/edit")


if __name__ == "__main__":
    main()
