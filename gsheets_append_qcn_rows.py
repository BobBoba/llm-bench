"""Append a Qwen3-Coder-Next row to the canonical RUST / humanitarian / TypeScript tabs,
using the SAME scoring logic as score-and-inject.py (RUST/hum) and the observed TS layout,
so numbers are comparable with the other models. Idempotent: skips if already present.
"""
import json, os, statistics as st
import gspread, gsheets_common

SID = "1mhSrYrJU0mIte3nBQ7RHiRTiFXNfZ72QrfRa_WiPhRM"
NAME = "Qwen3-Coder-Next"
MID = "qwen3-coder-next"
PROV = "local (llama.cpp)"
CTX = "262k"
RES = "/code/work/llm-bench/results"

def load(f):
    return json.load(open(os.path.join(RES, f)))
def med(xs):
    xs = [x for x in xs if x is not None]
    return round(st.median(xs), 1) if xs else None

# ---------- RUST (mirror rust_aggregate) ----------
rr = [r for r in load(f"results-{MID}-rust.json") if r.get("ok")]
sg = [r for r in rr if r["mode"] == "single"]
ag = [r for r in rr if r["mode"] == "agentic"]
S = round(100 * sum(r["pct"] for r in sg) / len(sg))
full = f"{sum(1 for r in sg if r['pct'] >= 0.999)}/{len(sg)}"
cmp = round(100 * sum(1 for r in sg if r["compiles"]) / len(sg))
medLat = med([r["latency"] for r in sg]); medRsn = med([r["reasonTok"] for r in sg])
tokps = med([r["tokps"] for r in sg if r.get("tokps")]); ttft = med([r["ttft"] for r in sg if r.get("ttft") is not None])
rsn = "yes" if (medRsn or 0) > 50 else "no"
A = round(100 * sum(r["pct"] for r in ag) / len(ag)); grn = f"{sum(1 for r in ag if r.get('visibleGreen'))}/{len(ag)}"
rust_row = [NAME, "local", "local", S, full, cmp, "local", medLat, medRsn, A, grn,
            "local", "n/a", "n/a", CTX, "yes", PROV, rsn, tokps, ttft]

# ---------- humanitarian (judge scores) ----------
hs = load(f"hum-scores-{MID}.json")[MID]
axes = [hs["facts"], hs["ideas"], hs["fermi"], hs["forecast"], hs["analysis"]]
avg = round(sum(axes) / 5, 2)
kc = [r for r in load(f"results-{MID}-knowledge.json") if r.get("ok")]
ktok = med([r["tokps"] for r in kc if r.get("tokps")]) or tokps
kttft = med([r["ttft"] for r in kc if r.get("ttft") is not None]) or ttft
krsn = "yes" if (med([r.get("reasonTok", 0) for r in kc]) or 0) > 50 else "no"
hum_row = [NAME, "local"] + axes + [avg, "local", hs.get("empties", 0), "n/a", "n/a",
          CTX, "yes", PROV, krsn, ktok, kttft]

# ---------- TypeScript (observed layout) ----------
tt = [r for r in load(f"results-{MID}-ts.json") if r.get("ok")]
ts_s = [r for r in tt if r["mode"] == "single"]; ts_a = [r for r in tt if r["mode"] == "agentic"]
Sts = round(100 * sum(r["pct"] for r in ts_s) / len(ts_s))
full_ts = f"{sum(1 for r in ts_s if r['pct'] >= 0.999)}/{len(ts_s)}"
type_ts = round(100 * sum(1 for r in ts_s if r.get("typechecks")) / len(ts_s))
medLat_ts = med([r["latency"] for r in ts_s]); medRsn_ts = med([r["reasonTok"] for r in ts_s])
tokps_ts = med([r["tokps"] for r in ts_s if r.get("tokps")]); ttft_ts = med([r["ttft"] for r in ts_s if r.get("ttft") is not None])
Ats = round(100 * sum(r["pct"] for r in ts_a) / len(ts_a))
green_ts = f"{sum(1 for r in ts_a if r.get('visibleGreen'))}/{len(ts_a)}"
tv = [r.get("toolValidPct") for r in ts_a if r.get("toolValidPct") is not None]
toolValid = round(100 * st.mean(tv)) if tv else "—"
recovered_ts = f"{sum(1 for r in ts_a if r.get('recovered'))}/{len(ts_a)}"
ts_row = [NAME, "local", "local", Sts, full_ts, type_ts, "local", medLat_ts, medRsn_ts,
          Ats, green_ts, toolValid, recovered_ts, CTX, "no", tokps_ts, ttft_ts]

gc = gspread.authorize(gsheets_common.credentials())
sh = gc.open_by_key(SID)
for tab, row in [("RUST", rust_row), ("humanitarian", hum_row), ("TypeScript", ts_row)]:
    ws = sh.worksheet(tab)
    colA = [c.strip() for c in ws.col_values(1)]
    if NAME in colA:
        print(f"{tab}: skip (present)")
        continue
    ws.append_row(row, value_input_option="RAW")
    print(f"{tab}: + {row}")
print("done")
