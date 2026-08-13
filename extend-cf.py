#!/usr/bin/env python3
# Maintain the gradient coloring when rows are appended: extend any FIXED-row conditional-formatting
# range that starts at the data top (row 1 or 2) but ends short of the current last data row, up to
# the real last row. Full-column ranges (…:1048576) already auto-extend and are left alone; so are
# intentional sub-block ranges that start mid-sheet (e.g. the local-models block C20:C25).
#
# Operates on sheet1 (RUST) + sheet2 (humanitarian) by editing worksheet XML inside the xlsx zip,
# so x14 rules / tables / styles survive byte-for-byte. Idempotent (re-running is a no-op once
# ranges reach the last row). Run after any row-append injector. Usage: python3 extend-cf.py [xlsx]

import sys, os, re, zipfile, shutil

XLSX = sys.argv[1] if len(sys.argv) > 1 else "/sync/Homie/Obsidian/Primary/claudedocs/AI price comparison.xlsx"
FULLCOL = 1048576

def max_row(xml):
    return max(int(m) for m in re.findall(r'<row r="(\d+)"', xml))

def bump(xml, maxrow):
    changed = 0
    def repl(m):
        nonlocal changed
        sqref = m.group(1)
        # only single-range sqrefs (no spaces = one contiguous range)
        if " " in sqref:
            return m.group(0)
        rm = re.fullmatch(r'([A-Z]+)(\d+):([A-Z]+)(\d+)', sqref)
        if not rm:
            return m.group(0)
        c1, r1, c2, r2 = rm.group(1), int(rm.group(2)), rm.group(3), int(rm.group(4))
        # extend only ranges that begin at the data top and stop short of the last row
        if r1 <= 2 and r2 != FULLCOL and r2 < maxrow:
            changed += 1
            return f'<conditionalFormatting sqref="{c1}{r1}:{c2}{maxrow}">'
        return m.group(0)
    xml = re.sub(r'<conditionalFormatting sqref="([^"]+)">', repl, xml)
    return xml, changed

zin = zipfile.ZipFile(XLSX, "r")
repl = {}
report = []
for sheet in ("sheet1", "sheet2"):
    xml = zin.read(f"xl/worksheets/{sheet}.xml").decode("utf-8")
    mr = max_row(xml)
    new, n = bump(xml, mr)
    if n:
        repl[f"xl/worksheets/{sheet}.xml"] = new.encode("utf-8")
    report.append(f"{sheet}: maxrow={mr}, extended {n} fixed CF range(s)")

if not repl:
    zin.close()
    print("No fixed CF ranges needed extending (all already cover the last row).")
    for r in report: print(" ", r)
    sys.exit(0)

tmp = XLSX + ".tmp"
with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        zout.writestr(item, repl.get(item.filename, zin.read(item.filename)))
zin.close(); shutil.move(tmp, XLSX)
for r in report: print(" ", r)
print("Gradient coloring extended over the new rows. x14 rules / tables / styles preserved.")
