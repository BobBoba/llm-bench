"""Backfill empty cost-ratio cells on the RUST & humanitarian tabs — PURE Google Sheet, no xlsx.

The injected rows (fast100 / morph / fable) carry a $/задача but no "X дешевле Opus" / "vs DS-V3.2"
formula, so those cells are blank. This reads each tab straight from the Sheet, computes the
missing ratios from that tab's own anchors (the Opus row cost and the DS-V3.2 row cost), and writes
back ONLY the blank cells — existing formula cells are left untouched.

  vsOpus = OpusCost / cost   (>1 = дешевле Opus)
  vsDS   = cost / DSCost      (>1 = дороже DS-V3.2)

    .venv-gsheets/bin/python gsheets_backfill_ratios.py
"""
import os
from googleapiclient.discovery import build
from gsheets_common import credentials

HERE = os.path.dirname(os.path.abspath(__file__))
SID = open(os.path.join(HERE, "gsheets-sheet-id.txt")).read().strip()

# tab -> (read range, cost col index, vsOpus col index+letter, vsDS col index+letter)
TABS = {
    "RUST":         {"rng": "A1:T90", "cost": 6, "vsopus": (13, "N"), "vsds": (12, "M")},
    "humanitarian": {"rng": "A1:R90", "cost": 8, "vsopus": (10, "K"), "vsds": (11, "L")},
}


def num(v):
    return v if isinstance(v, (int, float)) else None


def main():
    ss = build("sheets", "v4", credentials=credentials()).spreadsheets()
    updates = []
    for tab, cfg in TABS.items():
        rows = ss.values().get(spreadsheetId=SID, range=f"'{tab}'!{cfg['rng']}",
                               valueRenderOption="UNFORMATTED_VALUE").execute().get("values", [])
        ci = cfg["cost"]
        (vo_i, vo_L), (vd_i, vd_L) = cfg["vsopus"], cfg["vsds"]
        # anchors from this tab's own rows
        opus = ds = None
        for r in rows[1:]:
            name = str(r[0]).lower() if r else ""
            c = num(r[ci]) if len(r) > ci else None
            if c is None:
                continue
            if opus is None and "opus" in name:
                opus = c
            if ds is None and "v3.2" in name:          # DS-V3.2 (not deepseek-v4-flash)
                ds = c
        if not opus or not ds:
            print(f"{tab}: anchors not found (opus={opus} ds={ds}) — skipped")
            continue
        filled = 0
        for i, r in enumerate(rows[1:], start=1):       # i is 0-based data index; sheet row = i+1
            c = num(r[ci]) if len(r) > ci else None
            if not c or c <= 0:
                continue
            row_no = i + 1
            vo = r[vo_i] if len(r) > vo_i else ""
            vd = r[vd_i] if len(r) > vd_i else ""
            if vo == "":
                updates.append({"range": f"'{tab}'!{vo_L}{row_no}", "values": [[round(opus / c, 2)]]})
                filled += 1
            if vd == "":
                updates.append({"range": f"'{tab}'!{vd_L}{row_no}", "values": [[round(c / ds, 2)]]})
                filled += 1
        print(f"{tab}: anchors Opus=${opus} DS-V3.2=${ds} → {filled} blank cells to fill")

    if not updates:
        print("nothing to backfill.")
        return
    ss.values().batchUpdate(spreadsheetId=SID,
                            body={"valueInputOption": "RAW", "data": updates}).execute()
    print(f"backfilled {len(updates)} cells.")
    print(f"https://docs.google.com/spreadsheets/d/{SID}/edit")


if __name__ == "__main__":
    main()
