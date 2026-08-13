#!/usr/bin/env python3
# Append the Morph V3 Large row (group "new0702" = added [[02.07.2026]]) to the RUST (sheet1)
# and humanitarian (sheet2) tabs of "AI price comparison.xlsx", editing the worksheet XML
# *inside the zip* so the x14 conditional-formatting rules, tables, comments and styles survive
# byte-for-byte. (Same technique as inject-xml.py / inject-fable5.py.)
#
# ! Morph V3 is a fast-APPLY specialist run through the dedicated morph-client.mjs, which folds
#   system+user into a single user turn (Morph rejects multi-turn) and refuses tool-loops. So:
#     - single-shot RUST/knowledge columns ARE real (measured via OpenRouter usage.cost) and Morph
#       is a genuine ZDR peer for plain completion -> humanitarian ZDR = "yes";
#     - the AGENTIC columns (A%, grn, $/task-ag, price-over-DS, cheaper-than-opus) are "n/a":
#       Morph exposes NO tool-use ("No endpoints found that support tool use") -> the whole agentic
#       tool-loop is impossible. On the RUST sheet the "ZDR tool-use" column is therefore "no"
#       (the benchmark's ZDR+tool-use premise is unmet) even though ZDR data-retention itself is
#       fine — the humanitarian ZDR column ("yes") reflects that privacy property directly.
#     - reasoning = "no" (Morph has no reasoning channel).
#
# * Humanitarian scores are the Opus-4.8 judge verdict [[02.07.2026]] on the same blind rubric:
#   facts 8.0 (rejected most traps but one confident hallucination + 2 over-declines),
#   ideas 6.5 (pedestrian), fermi 7.5 (clean arithmetic), forecast 5.0 (flat 0% = miscalibrated),
#   analysis 8.5 (strong causal deconstruction) -> avg 7.1.
#
# Idempotent: skips a sheet if the Morph row is already present. Usage: python3 inject-morph.py [xlsx]

import sys, os, re, json, zipfile, shutil, statistics

DIR = "/sync/Homie/Obsidian/Primary/claudedocs"
XLSX = sys.argv[1] if len(sys.argv) > 1 else os.path.join(DIR, "AI price comparison.xlsx")
HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "results")
NAME = "Morph-V3-Large"
GROUP = "new0702"
PROV = "Morph"
CTX = "262k"
BLEND = 1.4  # blended $/1M = (0.90 in + 1.90 out) / 2 — informational; G/I hold the real measured cost


def med(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 1) if xs else None

# ---- RUST single-shot aggregate from the raw results (agentic is N/A: Morph has no tool-use) ----
ru = json.load(open(os.path.join(RES, "results-morph-rust.json")))
s = [r for r in ru if r["mode"] == "single" and r.get("ok")]
RS = round(100 * sum(r["pct"] for r in s) / len(s))
RFULL = "%d/%d" % (sum(1 for r in s if r["pct"] >= 0.999), len(s))
RCMP = round(100 * sum(1 for r in s if r["compiles"]) / len(s))
RCOST = round(sum(r.get("cost", 0) for r in s) / len(s), 5)
RLAT = med([r["latency"] for r in s])
RTOKPS = med([r["tokps"] for r in s if r.get("tokps")])

# ---- knowledge speed/cost ----
kn = json.load(open(os.path.join(RES, "results-morph-knowledge.json")))
kok = [r for r in kn if r.get("ok")]
KCOST = round(sum(r.get("cost", 0) for r in kok) / len(kok), 5)
KTOKPS = med([r["tokps"] for r in kok if r.get("tokps")])

# ---- humanitarian: Opus-4.8 judge scores (manual, blind rubric) ----
H = dict(facts=8.0, ideas=6.5, fermi=7.5, forecast=5.0, analysis=8.5)
HAVG = round(sum(H.values()) / len(H), 2)

# Row plans: (col, kind, value). kind: n=number, s=string, f=formula ({r}=rownum).
# RUST cols A..T: name group blend$ S% full cmp $single medLat medRsn A% grn $ag DS-mult opus-mult CTX ZDR provider reasoning tok/s TTFT
RUST_ROW = [("A","s",NAME),("B","s",GROUP),("C","n",BLEND),("D","n",RS),("E","s",RFULL),
    ("F","n",RCMP),("G","n",RCOST),("H","n",RLAT),("I","n",0),("J","s","n/a"),
    ("K","s","n/a"),("L","s","n/a"),("M","s","n/a"),("N","s","n/a"),
    ("O","s",CTX),("P","s","no"),("Q","s",PROV),("R","s","no"),("S","n",RTOKPS),("T","s","n/a")]
# humanitarian cols A..R: name group facts ideas fermi forecast analysis avg $task empties opus-mult DS-mult CTX ZDR provider reasoning tok/s TTFT
HUM_ROW = [("A","s",NAME),("B","s",GROUP),("C","n",H["facts"]),("D","n",H["ideas"]),
    ("E","n",H["fermi"]),("F","n",H["forecast"]),("G","n",H["analysis"]),("H","n",HAVG),
    ("I","n",KCOST),("J","n",0),("K","f","=OpusCost/I{r}"),("L","f","=I{r}/DS32Cost"),
    ("M","s",CTX),("N","s","yes"),("O","s",PROV),("P","s","no"),("Q","n",KTOKPS),("R","s","n/a")]


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

def inject_sheet(xml, plan):
    if NAME in xml:                       # idempotent: already injected -> leave untouched
        return xml, None
    styles, lastrow = last_row_styles(xml)
    rn = lastrow + 1
    xml = xml.replace("</sheetData>", build_row(rn, plan, styles) + "</sheetData>", 1)
    xml = re.sub(r'<dimension ref="([A-Z]+\d+):([A-Z]+)\d+"/>',
                 lambda m: f'<dimension ref="{m.group(1)}:{m.group(2)}{rn}"/>', xml)
    return xml, rn


zin = zipfile.ZipFile(XLSX, "r")
s1, r1 = inject_sheet(zin.read("xl/worksheets/sheet1.xml").decode("utf-8"), RUST_ROW)
s2, r2 = inject_sheet(zin.read("xl/worksheets/sheet2.xml").decode("utf-8"), HUM_ROW)

if r1 is None and r2 is None:
    zin.close()
    print(f"'{NAME}' already present in both sheets — nothing to do (idempotent).")
    sys.exit(0)

repl = {"xl/worksheets/sheet1.xml": s1.encode("utf-8"), "xl/worksheets/sheet2.xml": s2.encode("utf-8")}
tmp = XLSX + ".tmp"
with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        zout.writestr(item, repl.get(item.filename, zin.read(item.filename)))
zin.close()
shutil.move(tmp, XLSX)

print(f"RUST row {r1}: {NAME} S%={RS} full={RFULL} cmp%={RCMP} $single={RCOST} medLat={RLAT} tok/s={RTOKPS} A%=n/a (no tool-use)")
print(f"humanitarian row {r2}: {NAME} facts={H['facts']} ideas={H['ideas']} fermi={H['fermi']} forecast={H['forecast']} analysis={H['analysis']} avg={HAVG} $task={KCOST} tok/s={KTOKPS}")
print("x14 CF / tables / comments preserved byte-for-byte.")
