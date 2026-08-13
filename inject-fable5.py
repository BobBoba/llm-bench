#!/usr/bin/env python3
# Append the Claude Fable 5 row (group "sub" = run via Claude Code headless `claude -p`,
# subscription auth) to the RUST (sheet1) and humanitarian (sheet2) tabs of
# "AI price comparison.xlsx", editing the worksheet XML *inside the zip* so the 72 x14
# conditional-formatting rules, tables, comments and styles survive byte-for-byte — only new
# <row>s are inserted and <dimension> widened. New cells reuse the last data row's styles.
# (Same technique as inject-xml.py; that file's header has the full rationale.)
#
# ! Fable 5 is NOT a raw-endpoint peer to the OpenRouter ZDR rows — it is measured INSIDE the
#   Claude Code agent harness. So the harness-inflated / subscription columns are "n/a":
#   $/task (API-equivalent, not a real charge), A%/grn (agentic tool-loop unsupported via
#   `claude -p`), medLat/medRsn/tok-s/TTFT (dominated by ~46k-token harness prefill). Fable 5
#   also CANNOT run ZDR (that is exactly why OpenRouter refused it) -> ZDR column = "no".
#   Correctness columns (S%, cmp%, facts..analysis) stay — the objective oracles + Opus-4.8
#   judge are robust to prompt contamination.
#
# * Humanitarian scores are the Opus-4.8 judge verdict [[02.07.2026]]:
#   facts 9.5 (14/14 probes, zero hallucinations), ideas 9.0, fermi 9.0, forecast 9.0,
#   analysis 9.5 -> avg 9.2 (top of the table).
#
# Idempotent: skips a sheet if the Fable row is already present. Usage: python3 inject-fable5.py [xlsx]

import sys, os, re, json, zipfile, shutil

DIR = "/sync/Homie/Obsidian/Primary/claudedocs"
XLSX = sys.argv[1] if len(sys.argv) > 1 else os.path.join(DIR, "AI price comparison.xlsx")
HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "results")
NAME = "Fable 5 (CC sub)"

# ---- RUST single-shot aggregate from the raw results (agentic is N/A, excluded) ----
ru = json.load(open(os.path.join(RES, "results-fable5-rust.json")))
s = [r for r in ru if r["mode"] == "single" and r.get("ok")]
RS = round(100 * sum(r["pct"] for r in s) / len(s))
RFULL = "%d/%d" % (sum(1 for r in s if r["pct"] >= 0.999), len(s))
RCMP = round(100 * sum(1 for r in s if r["compiles"]) / len(s))

# ---- humanitarian: Opus-4.8 judge scores (manual, blind rubric) ----
H = dict(facts=9.5, ideas=9.0, fermi=9.0, forecast=9.0, analysis=9.5)
HAVG = round(sum(H.values()) / len(H), 2)

# Row plans: (col, kind, value). kind: n=number, s=string. "n/a" strings for non-comparable cols.
# RUST columns A..T: name group price S% full cmp $single medLat medRsn A% grn $agentic DS-mult opus-mult CTX ZDR provider reasoning tok/s TTFT
RUST_ROW = [("A","s",NAME),("B","s","sub"),("C","s","sub"),("D","n",RS),("E","s",RFULL),
    ("F","n",RCMP),("G","s","sub"),("H","s","n/a"),("I","s","n/a"),("J","s","n/a"),
    ("K","s","n/a"),("L","s","sub"),("M","s","n/a"),("N","s","n/a"),
    ("O","s","1M"),("P","s","no"),("Q","s","Claude Code (sub)"),("R","s","yes"),("S","s","n/a"),("T","s","n/a")]
# humanitarian columns A..R: name group facts ideas fermi forecast analysis avg $task empties opus-mult DS-mult CTX ZDR provider reasoning tok/s TTFT
HUM_ROW = [("A","s",NAME),("B","s","sub"),("C","n",H["facts"]),("D","n",H["ideas"]),
    ("E","n",H["fermi"]),("F","n",H["forecast"]),("G","n",H["analysis"]),("H","n",HAVG),
    ("I","s","sub"),("J","n",0),("K","s","n/a"),("L","s","n/a"),("M","s","1M"),("N","s","no"),
    ("O","s","Claude Code (sub)"),("P","s","yes"),("Q","s","n/a"),("R","s","n/a")]


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

print(f"RUST row {r1}: {NAME} S%={RS} full={RFULL} cmp%={RCMP} A%=n/a (agentic N/A via claude -p)")
print(f"humanitarian row {r2}: {NAME} facts={H['facts']} ideas={H['ideas']} fermi={H['fermi']} forecast={H['forecast']} analysis={H['analysis']} avg={HAVG}")
print("x14 CF / tables / comments preserved byte-for-byte.")
