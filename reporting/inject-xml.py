#!/usr/bin/env python3
# Formatting-preserving row appender for "AI price comparison.xlsx" (see header of the
# original version): edits worksheet XML *inside the xlsx zip directly* so conditional
# formatting (x14), tables, comments and styles survive byte-for-byte — only new <row>s
# are inserted and <dimension> widened. New cells reuse the last data row's style indices.
#
# This run appends TWO models: nemotron-cascade (local) + Sonnet 5 (cloud ref, real cost).
# Usage: python3 inject-xml.py [path-to-xlsx]

import sys, os, re, json, zipfile, shutil, statistics

DIR = "/sync/Homie/Obsidian/Primary/claudedocs"
XLSX = sys.argv[1] if len(sys.argv) > 1 else os.path.join(DIR, "AI price comparison.xlsx")
HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "..", "results")

def med(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 1) if xs else None

def rust_agg(slug):
    d = json.load(open(os.path.join(RES, f"results-{slug}-rust.json")))
    s = [r for r in d if r["mode"] == "single" and r.get("ok")]
    a = [r for r in d if r["mode"] == "agentic" and r.get("ok")]
    scost = [r.get("cost", 0) for r in s]
    return dict(
        S=round(100 * sum(r["pct"] for r in s) / len(s)),
        full=f"{sum(1 for r in s if r['pct'] >= 0.999)}/{len(s)}",
        cmp=round(100 * sum(1 for r in s if r["compiles"]) / len(s)),
        A=round(100 * sum(r["pct"] for r in a) / len(a)) if a else None,
        grn=f"{sum(1 for r in a if r.get('visibleGreen'))}/{len(a)}" if a else "—",
        medLat=med([r["latency"] for r in s]), medRsn=round(med([r["reasonTok"] for r in s])),
        tokps=med([r["tokps"] for r in s if r.get("tokps")]),
        ttft=round(med([r["ttft"] for r in s if r.get("ttft") is not None]), 2),
        cost=round(sum(scost) / len(scost), 5) if any(scost) else 0,
    )

def know_speed(slug):
    d = json.load(open(os.path.join(RES, f"results-{slug}-knowledge.json")))
    kc = [r.get("cost", 0) for r in d if r.get("ok")]
    return (med([r["tokps"] for r in d if r.get("ok") and r.get("tokps")]),
            round(med([r["ttft"] for r in d if r.get("ok") and r.get("ttft") is not None]), 2),
            round(sum(kc) / len(kc), 5) if any(kc) else 0)

CAS = rust_agg("cascade"); CAS_K = know_speed("cascade")
SON = rust_agg("sonnet5"); SON_K = know_speed("sonnet5")

# Humanitarian scores judged by Opus 4.8 [[30.06.2026]]/[[01.07.2026]].
CAS_H = dict(facts=7.5, ideas=6.5, fermi=5.0, forecast=8.0, analysis=8.5)
SON_H = dict(facts=9.7, ideas=8.0, fermi=9.5, forecast=8.8, analysis=8.5)
def avg(h): return round(sum(h.values()) / len(h), 2)

# Row plans: (col, kind, value). kind: n=number, s=string, f=formula ({r}=rownum).
CAS_RUST = [("A","s","Nemotron-Cascade-30B"),("B","s","local"),("C","s","local"),("D","n",CAS["S"]),
    ("E","s",CAS["full"]),("F","n",CAS["cmp"]),("G","s","local"),("H","n",CAS["medLat"]),("I","n",CAS["medRsn"]),
    ("J","n",CAS["A"]),("K","s",CAS["grn"]),("L","s","local"),("M","s","n/a"),("N","s","n/a"),
    ("O","s","1.05M"),("P","s","yes"),("Q","s","local (LM Studio)"),("R","s","yes"),("S","n",CAS["tokps"]),("T","n",CAS["ttft"])]
CAS_HUM = [("A","s","Nemotron-Cascade-30B"),("B","s","local"),("C","n",CAS_H["facts"]),("D","n",CAS_H["ideas"]),
    ("E","n",CAS_H["fermi"]),("F","n",CAS_H["forecast"]),("G","n",CAS_H["analysis"]),("H","n",avg(CAS_H)),
    ("I","s","local"),("J","n",0),("K","s","n/a"),("L","s","n/a"),("M","s","1.05M"),("N","s","yes"),
    ("O","s","local (LM Studio)"),("P","s","yes"),("Q","n",CAS_K[0]),("R","n",CAS_K[1])]

SON_RUST = [("A","s","Sonnet-5"),("B","s","ref"),("C","s","2/10"),("D","n",SON["S"]),("E","s",SON["full"]),
    ("F","n",SON["cmp"]),("G","n",SON["cost"]),("H","n",SON["medLat"]),("I","n",SON["medRsn"]),("J","n",SON["A"]),
    ("K","s",SON["grn"]),("L","n",SON["cost"]),("M","f","=L{r}/$L$5"),("N","f","=$M$2/M{r}"),
    ("O","s","1M"),("P","s","yes"),("Q","s","Anthropic"),("R","s","yes"),("S","n",SON["tokps"]),("T","n",SON["ttft"])]
SON_HUM = [("A","s","Sonnet-5"),("B","s","ref"),("C","n",SON_H["facts"]),("D","n",SON_H["ideas"]),("E","n",SON_H["fermi"]),
    ("F","n",SON_H["forecast"]),("G","n",SON_H["analysis"]),("H","n",avg(SON_H)),("I","n",SON_K[2]),("J","n",0),
    ("K","f","=OpusCost/I{r}"),("L","f","=I{r}/DS32Cost"),("M","s","1M"),("N","s","yes"),("O","s","Anthropic"),
    ("P","s","yes"),("Q","n",SON_K[0]),("R","n",SON_K[1])]

RUST_ROWS = [CAS_RUST, SON_RUST]
HUM_ROWS = [CAS_HUM, SON_HUM]

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
    styles, lastrow = last_row_styles(xml)
    newxml = ""
    added = []
    for i, plan in enumerate(plans):
        rn = lastrow + 1 + i
        newxml += build_row(rn, plan, styles)
        added.append(rn)
    xml = xml.replace("</sheetData>", newxml + "</sheetData>", 1)
    xml = re.sub(r'<dimension ref="([A-Z]+\d+):([A-Z]+)\d+"/>',
                 lambda m: f'<dimension ref="{m.group(1)}:{m.group(2)}{added[-1]}"/>', xml)
    return xml, added

tmp = XLSX + ".tmp"
zin = zipfile.ZipFile(XLSX, "r")
s1, r1 = inject_sheet(zin.read("xl/worksheets/sheet1.xml").decode("utf-8"), RUST_ROWS)
s2, r2 = inject_sheet(zin.read("xl/worksheets/sheet2.xml").decode("utf-8"), HUM_ROWS)
repl = {"xl/worksheets/sheet1.xml": s1.encode("utf-8"), "xl/worksheets/sheet2.xml": s2.encode("utf-8")}
with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        zout.writestr(item, repl.get(item.filename, zin.read(item.filename)))
zin.close()
shutil.move(tmp, XLSX)

print(f"RUST rows {r1}: Nemotron-Cascade-30B (S%={CAS['S']} A%={CAS['A']} tok/s={CAS['tokps']}), Sonnet-5 (S%={SON['S']} A%={SON['A']} $/task={SON['cost']})")
print(f"humanitarian rows {r2}: Cascade avg={avg(CAS_H)}, Sonnet-5 avg={avg(SON_H)}")
print("CF / table / comments preserved.")
