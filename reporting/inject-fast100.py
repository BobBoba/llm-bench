#!/usr/bin/env python3
# Generalized N-model injector for the ">100 tok/s under ZDR" cohort ([[03.07.2026]], group
# "fast100") into the RUST (sheet1) + humanitarian (sheet2) tabs of "AI price comparison.xlsx".
# Edits worksheet XML *inside the zip* so the x14 conditional formatting / tables / comments /
# styles survive byte-for-byte (same technique as inject-xml.py). Idempotent per sheet (skips a
# model already present by display name). Also emits META-fast100.json for the TypeScript tab.
#
# Data sources (all under results/):
#   results-fast100-{rust,ts,knowledge}.json  — the battery runs (LLM_CLIENT=openrouter, ZDR)
#   hum-scores-fast100.json                   — Opus-4.8 auto-judge verdicts (judge-knowledge.mjs)
#   or-models-meta.json                       — OpenRouter /models metadata (name, price, ctx, tools)
#   fast100-run.json                          — the 35 model ids to inject
#
# ! Honesty guards:
#   - LOAD/STREAM-FAIL: a model whose single-shot RUST all returned empty (0 tokens, no ttft) gets
#     NO RUST row (a misleading 0% is worse than absence); it is reported and still gets a
#     humanitarian row if the judge scored it.
#   - AGENTIC N/A: models without working tool-use (metadata tools=false, or no agentic records)
#     get "n/a" in A%/grn/$ag and the cost-multiplier formulas — never a false 0.
#   - BURST OUTPUT: diffusion / single-chunk models report absurd streaming tok/s (>1500); recorded
#     as "n/a" (streaming tok/s is undefined for non-token-streamed output), noted on stdout.

import sys, os, re, json, zipfile, shutil, statistics

DIR = "/sync/Homie/Obsidian/Primary/claudedocs"
XLSX = sys.argv[1] if len(sys.argv) > 1 else os.path.join(DIR, "AI price comparison.xlsx")
HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "..", "results")
GROUP = "fast100"
PROV = "OpenRouter (ZDR)"
TOKPS_BURST = 1500  # above this, streaming tok/s is a burst-output artifact -> n/a

def med(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 1) if xs else None

def load(name):
    p = os.path.join(RES, name)
    return json.load(open(p)) if os.path.exists(p) else {}

RUN   = json.load(open(os.path.join(RES, "fast100-run.json")))
META  = load("or-models-meta.json")
HUM   = load("hum-scores-fast100.json")
RUST  = json.load(open(os.path.join(RES, "results-fast100-rust.json")))
KNOW  = json.load(open(os.path.join(RES, "results-fast100-knowledge.json")))

def short(mid): return mid.lstrip("~").split("/")[-1]
def ctx_label(n):
    if not n: return "—"
    if n >= 1_000_000: return f"{n/1_000_000:.2f}".rstrip("0").rstrip(".") + "M"
    return f"{round(n/1000)}k"

def rust_agg(mid):
    s = [r for r in RUST if r["model"] == mid and r["mode"] == "single" and r.get("ok")]
    a = [r for r in RUST if r["model"] == mid and r["mode"] == "agentic" and r.get("ok") and not r.get("err")]
    if not s: return None
    # load/stream-fail: nothing was actually generated
    if all((not r.get("tokOut")) and r.get("ttft") is None for r in s):
        return {"loadfail": True}
    tokps = med([r["tokps"] for r in s if r.get("tokps")])
    burst = tokps is not None and tokps > TOKPS_BURST
    out = dict(
        S=round(100 * sum(r["pct"] for r in s) / len(s)),
        full=f"{sum(1 for r in s if r['pct'] >= 0.999)}/{len(s)}",
        cmp=round(100 * sum(1 for r in s if r["compiles"]) / len(s)),
        cost=round(sum(r.get("cost", 0) for r in s) / len(s), 5),
        medLat=med([r["latency"] for r in s]),
        medRsn=round(med([r.get("reasonTok", 0) for r in s]) or 0),
        tokps=(None if burst else tokps), burst=burst,
        ttft=(lambda t: round(t, 2) if t is not None else None)(med([r["ttft"] for r in s if r.get("ttft") is not None])),
    )
    if a:
        out["A"] = round(100 * sum(r["pct"] for r in a) / len(a))
        out["grn"] = f"{sum(1 for r in a if r.get('visibleGreen'))}/{len(a)}"
        acost = [r.get("cost", 0) for r in a]
        out["acost"] = round(sum(acost) / len(acost), 5) if any(acost) else 0
    return out

def know_agg(mid):
    kc = [r for r in KNOW if r["model"] == mid and r.get("ok")]
    if not kc: return {}
    return dict(cost=round(sum(r.get("cost", 0) for r in kc) / len(kc), 5),
                tokps=med([r["tokps"] for r in kc if r.get("tokps")]),
                ttft=(lambda t: round(t, 2) if t is not None else None)(med([r["ttft"] for r in kc if r.get("ttft") is not None])),
                rsn=med([r.get("reasonTok", 0) for r in kc]) or 0)

def esc(v): return str(v).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def last_row_styles(xml):
    rows = list(re.finditer(r'<row [^>]*\br="(\d+)"[^>]*>(.*?)</row>', xml, re.S))
    if not rows: return {}, 1
    last = max(rows, key=lambda m: int(m.group(1)))
    styles = {}
    for c in re.finditer(r'<c\b[^>]*\br="([A-Z]+)\d+"[^>]*>', last.group(0)):
        sm = re.search(r'\bs="(\d+)"', c.group(0))
        styles[c.group(1)] = sm.group(1) if sm else None
    return styles, int(last.group(1))

def build_row(rownum, plan, styles):
    cells = []
    for col, kind, val in plan:
        s_idx = styles.get(col)
        s_attr = f' s="{s_idx}"' if s_idx is not None else ""
        ref = f"{col}{rownum}"
        if kind == "n" and val is not None:
            cells.append(f'<c r="{ref}"{s_attr}><v>{val}</v></c>')
        elif kind == "f":
            cells.append(f'<c r="{ref}"{s_attr}><f>{esc(val).format(r=rownum)}</f></c>')
        else:
            cells.append(f'<c r="{ref}"{s_attr} t="inlineStr"><is><t xml:space="preserve">{esc(val)}</t></is></c>')
    return f'<row r="{rownum}">' + "".join(cells) + "</row>"

def inject_sheet(xml, plans):
    """plans: list of (name, plan). Appends those whose name is not already in the sheet."""
    styles, lastrow = last_row_styles(xml)
    add = [(n, p) for (n, p) in plans if n not in xml]
    if not add: return xml, []
    newxml = ""; added = []
    for i, (n, plan) in enumerate(add):
        rn = lastrow + 1 + i
        newxml += build_row(rn, plan, styles); added.append((rn, n))
    xml = xml.replace("</sheetData>", newxml + "</sheetData>", 1)
    xml = re.sub(r'<dimension ref="([A-Z]+\d+):([A-Z]+)\d+"/>',
                 lambda m: f'<dimension ref="{m.group(1)}:{m.group(2)}{added[-1][0]}"/>', xml)
    return xml, added

# ---- build row plans ----
rust_plans, hum_plans, meta_ts = [], [], {}
loadfail, burst_models = [], []
for mid in RUN:
    nm = short(mid); mm = META.get(mid, {})
    blend = round((mm.get("in", 0) + mm.get("out", 0)) / 2, 3)
    ctx = ctx_label(mm.get("ctx"))
    tools = bool(mm.get("tools"))
    price = f'{mm.get("in",0):g}/{mm.get("out",0):g}'
    meta_ts[mid] = [nm, GROUP, price, ctx]

    ra = rust_agg(mid)
    if ra and ra.get("loadfail"):
        loadfail.append(nm)
    elif ra:
        if ra.get("burst"): burst_models.append(nm)
        has_ag = "A" in ra
        rsn = "yes" if ra["medRsn"] > 50 else "no"
        J = ("n", ra["A"]) if has_ag else ("s", "n/a")
        K = ("s", ra["grn"]) if has_ag else ("s", "n/a")
        L = ("n", ra["acost"]) if has_ag else ("s", "n/a")
        M = ("f", "=L{r}/DS32Cost") if has_ag else ("s", "n/a")
        N = ("f", "=OpusCost/L{r}") if has_ag else ("s", "n/a")
        S = ("n", ra["tokps"]) if ra["tokps"] is not None else ("s", "n/a")
        T = ("n", ra["ttft"]) if ra["ttft"] is not None else ("s", "n/a")
        plan = [("A","s",nm),("B","s",GROUP),("C","n",blend),("D","n",ra["S"]),("E","s",ra["full"]),
            ("F","n",ra["cmp"]),("G","n",ra["cost"]),("H","n",ra["medLat"]),("I","n",ra["medRsn"]),
            (J[0]=="n" and "J" or "J", J[0], J[1]),("K",K[0],K[1]),("L",L[0],L[1]),("M",M[0],M[1]),("N",N[0],N[1]),
            ("O","s",ctx),("P","s","yes" if tools else "no"),("Q","s",PROV),("R","s",rsn),("S",S[0],S[1]),("T",T[0],T[1])]
        # normalize J tuple form
        plan[9] = ("J", J[0], J[1])
        rust_plans.append((nm, plan))

    sc = HUM.get(mid)
    if sc:
        ka = know_agg(mid)
        avg = sc.get("avg") or round((sc["facts"]+sc["ideas"]+sc["fermi"]+sc["forecast"]+sc["analysis"])/5, 2)
        kcost = ka.get("cost", 0)
        ktok = ka.get("tokps"); kburst = ktok is not None and ktok > TOKPS_BURST
        Q = ("s", "n/a") if (ktok is None or kburst) else ("n", ktok)
        R = ("n", ka["ttft"]) if ka.get("ttft") is not None else ("s", "n/a")
        Kf = ("f", "=OpusCost/I{r}") if kcost else ("s", "n/a")
        Lf = ("f", "=I{r}/DS32Cost") if kcost else ("s", "n/a")
        krsn = "yes" if (ka.get("rsn") or 0) > 50 else "no"
        hp = [("A","s",nm),("B","s",GROUP),("C","n",sc["facts"]),("D","n",sc["ideas"]),("E","n",sc["fermi"]),
            ("F","n",sc["forecast"]),("G","n",sc["analysis"]),("H","n",avg),("I","n",kcost),("J","n",sc.get("empties",0)),
            ("K",Kf[0],Kf[1]),("L",Lf[0],Lf[1]),("M","s",ctx),("N","s","yes"),("O","s",PROV),("P","s",krsn),
            ("Q",Q[0],Q[1]),("R",R[0],R[1])]
        hum_plans.append((nm, hp))

# ---- write ----
json.dump(meta_ts, open(os.path.join(RES, "META-fast100.json"), "w"), ensure_ascii=False, indent=1)

zin = zipfile.ZipFile(XLSX, "r")
s1, a1 = inject_sheet(zin.read("xl/worksheets/sheet1.xml").decode("utf-8"), rust_plans)
s2, a2 = inject_sheet(zin.read("xl/worksheets/sheet2.xml").decode("utf-8"), hum_plans)
repl = {"xl/worksheets/sheet1.xml": s1.encode("utf-8"), "xl/worksheets/sheet2.xml": s2.encode("utf-8")}
tmp = XLSX + ".tmp"
with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        zout.writestr(item, repl.get(item.filename, zin.read(item.filename)))
zin.close(); shutil.move(tmp, XLSX)

print(f"RUST  sheet: +{len(a1)} rows")
print(f"HUMAN sheet: +{len(a2)} rows")
print(f"META-fast100.json: {len(meta_ts)} entries for the TS tab")
if loadfail: print(f"LOAD/STREAM-FAIL (no RUST row): {', '.join(loadfail)}")
if burst_models: print(f"BURST OUTPUT (tok/s -> n/a): {', '.join(burst_models)}")
print("x14 CF / tables / comments preserved byte-for-byte.")
