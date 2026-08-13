"""Push the LLM benchmark into the shared Google Sheet (id in gsheets-sheet-id.txt).

Three tabs:
  * RUST, humanitarian — values read from the existing xlsx (data_only), so the Google
    copy mirrors the local archive.
  * TypeScript — aggregated fresh from results/*.json via inject-ts-sheet.py's aggregate().

Formatting applied via the Sheets API (cleaner than xlsx x14): frozen bold header, column
widths, NATIVE cell notes documenting each TypeScript header, and red→yellow→green gradient
conditional formatting on the score columns. Idempotent: re-run any time to refresh.

    .venv-gsheets/bin/python gsheets_push.py
"""
import os
import importlib.util
import openpyxl
from googleapiclient.discovery import build
from gsheets_common import credentials, delete_own_rules

HERE = os.path.dirname(os.path.abspath(__file__))
XLSX = "/sync/Homie/Obsidian/Primary/claudedocs/AI price comparison.xlsx"
SID = open(os.path.join(HERE, "gsheets-sheet-id.txt")).read().strip()

# ---- load TS aggregation from the (hyphenated) injector module ----
spec = importlib.util.spec_from_file_location("inject_ts", os.path.join(HERE, "inject-ts-sheet.py"))
inject_ts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inject_ts)

RED, YEL, GRN = {"red": 0.97, "green": 0.41, "blue": 0.42}, {"red": 1, "green": 0.92, "blue": 0.52}, {"red": 0.39, "green": 0.75, "blue": 0.48}

# Header hover-notes for the RUST tab (20 columns A..T), in order.
RUST_DOCS = [
    "Модель / идентификатор.",
    "group: local — локальная модель (LM Studio, бесплатно); ref — эталон Anthropic; иначе облачная.",
    "Усреднённая (blend) цена за 1 млн токенов вход+выход, USD. Для локальных — 'local'.",
    "S% — single-shot: средний % пройденных СКРЫТЫХ тестов (cargo test) за 2 прогона × 3 задачи, БЕЗ инструментов.",
    "full/n — сколько single-прогонов набрали 100% скрытых тестов, из общего числа прогонов.",
    "cmp% — доля single-решений, которые КОМПИЛИРУЮТСЯ (cargo build --offline), независимо от прохождения тестов.",
    "Средняя стоимость одной single-задачи, USD (для облачных).",
    "medLat — медианная задержка single-запроса, секунды.",
    "medRsn — медианное число reasoning-токенов на single-задачу (0 = не reasoning-модель).",
    "A% — agentic: средний % пройденных СКРЫТЫХ тестов в tool-loop (write_lib+run_tests, до 5 шагов). Самокоррекция по фидбэку компилятора.",
    "grn/n = green/n: сколько agentic-задач довели ВИДИМЫЕ тесты до зелёного (прошли в tool-loop), из общего числа. Т.е. модель реально дошла до рабочего решения в цикле.",
    "Средняя стоимость одной agentic-задачи, USD (для облачных).",
    "Во сколько раз стоимость задачи дороже/дешевле DeepSeek-V3.2 (value-якорь).",
    "Во сколько раз модель дешевле Claude Opus (X = множитель).",
    "Максимальное окно контекста модели.",
    "Поддерживает ли модель tool-use в ZDR-режиме (zero-data-retention). yes/no.",
    "Провайдер, дающий ZDR-доступ к модели (или local).",
    "Есть ли у модели выделенная reasoning-фаза. yes/no.",
    "tok/s — медианная скорость генерации (single, фаза декодирования).",
    "TTFT — time-to-first-token: медианная задержка до первого токена, секунды.",
]

# Header hover-notes for the humanitarian tab (18 columns A..R), in order.
HUM_DOCS = [
    "Модель / идентификатор.",
    "group: local / ref / облачная.",
    "Ось facts (фактология), 0–10: батарея из 14 проб с ключом — V (проверяемые), F (ложная предпосылка, надо опровергнуть), U (неотвечаемые, честно «не знаю»). Уверенная выдумка = галлюцинация.",
    "Ось ideas (идеи/креативность), 0–10: качество и оригинальность идей. Судья Opus 4.8.",
    "Ось fermi (оценки Ферми), 0–10: порядковые прикидки с методом (напр. TDP GPU). Главный разделитель моделей.",
    "Ось forecast (прогнозирование), 0–10: калиброванность и обоснованность прогнозов.",
    "Ось analysis (анализ), 0–10: глубина и строгость рассуждения.",
    "ср.балл — средняя оценка по 5 осям (итоговый знаниевый балл).",
    "Средняя стоимость одной задачи, USD (для облачных).",
    "Сколько осей остались без ответа (напр. reasoning-runaway сжёг бюджет).",
    "Во сколько раз модель дешевле Claude Opus.",
    "Во сколько раз стоимость задачи дороже DeepSeek-V3.2.",
    "Максимальное окно контекста модели.",
    "Поддерживает ли tool-use в ZDR-режиме. yes/no.",
    "Провайдер ZDR-доступа (или local).",
    "Есть ли reasoning-фаза. yes/no.",
    "tok/s — медианная скорость генерации.",
    "TTFT — задержка до первого токена, секунды.",
]


def xlsx_values(sheet_name):
    """All rows of an xlsx sheet as list-of-lists (cached values, None -> "")."""
    wb = openpyxl.load_workbook(XLSX, data_only=True)
    ws = wb[sheet_name]
    rows = []
    for row in ws.iter_rows(values_only=True):
        rows.append(["" if v is None else v for v in row])
    # trim fully-empty trailing rows
    while rows and all(c == "" for c in rows[-1]):
        rows.pop()
    return rows


def ts_values():
    """TypeScript tab as header + rows, same column order as the injector."""
    rows = inject_ts.aggregate()
    header = list(inject_ts.HEADERS)
    out = [header]
    for r in rows:
        out.append([
            r["name"], r["group"], r["price"], r["S"], r["full"], r["typp"],
            (r["cost"] if r["cost"] else ""), r["medLat"], r["medRsn"], r["A"],
            r["green"], r["toolValid"], r["recovered"], r["ctx"], r["reasoning"],
            r["tokps"], r["ttft"],
        ])
    return [["" if v is None else v for v in row] for row in out]


def gradient_rule(sid, col, nrows, vmax):
    """0..vmax/2..vmax red→yellow→green gradient over a column's data rows."""
    return {"addConditionalFormatRule": {"index": 0, "rule": {
        "ranges": [{"sheetId": sid, "startRowIndex": 1, "endRowIndex": nrows,
                    "startColumnIndex": col, "endColumnIndex": col + 1}],
        "gradientRule": {
            "minpoint": {"color": RED, "type": "NUMBER", "value": "0"},
            "midpoint": {"color": YEL, "type": "NUMBER", "value": "%g" % (vmax / 2)},
            "maxpoint": {"color": GRN, "type": "NUMBER", "value": "%g" % vmax},
        }}}}


def fill_ratios(rows, cost_i, vsopus_i, vsds_i):
    """Fill empty 'X cheaper than Opus' / 'vs DeepSeek-V3.2' cells for rows that have a cost but no
    ratio (the injected fast100 / morph / fable rows carry a cost but no formula). Computed IN
    MEMORY at push time — the Google Sheet is the source of truth, the xlsx is never written.
    Anchors are taken from this same tab: the Opus row's cost and the DS-V3.2 row's cost.
    vsOpus = OpusCost / cost (>1 = cheaper than Opus); vsDS = cost / DSCost (>1 = pricier than DS)."""
    def num(v):
        return v if isinstance(v, (int, float)) else None
    opus = ds = None
    for r in rows[1:]:
        name = str(r[0]).lower() if r else ""
        c = num(r[cost_i]) if len(r) > cost_i else None
        if c is None:
            continue
        if opus is None and "opus" in name:
            opus = c
        if ds is None and "v3.2" in name:      # DS-V3.2 specifically (not deepseek-v4-flash)
            ds = c
    if not opus and not ds:
        return 0
    filled = 0
    for r in rows[1:]:
        c = num(r[cost_i]) if len(r) > cost_i else None
        if not c or c <= 0:
            continue
        while len(r) <= max(vsopus_i, vsds_i):
            r.append("")
        if r[vsopus_i] == "" and opus:
            r[vsopus_i] = round(opus / c, 2); filled += 1
        if r[vsds_i] == "" and ds:
            r[vsds_i] = round(c / ds, 2); filled += 1
    return filled


def main():
    sheets = build("sheets", "v4", credentials=credentials())
    ss = sheets.spreadsheets()

    # ---- data for each tab ----
    data = {"RUST": xlsx_values("RUST"), "humanitarian": xlsx_values("humanitarian"), "TypeScript": ts_values()}
    # backfill cost-ratio columns (Sheet-only): RUST vsDS=12/vsOpus=13 (cost G=6);
    # humanitarian vsOpus=10/vsDS=11 (cost=8). Injected rows lacked the ratio formulas.
    nru = fill_ratios(data["RUST"], 6, 13, 12)
    nhu = fill_ratios(data["humanitarian"], 8, 10, 11)
    print(f"backfilled cost-ratios: RUST {nru} cells, humanitarian {nhu} cells")

    # ---- phase 1: ensure the three tabs exist (rename default, add the rest) ----
    meta = ss.get(spreadsheetId=SID, fields="sheets(properties(title,sheetId),conditionalFormats,tables(tableId,range),bandedRanges(bandedRangeId))").execute()
    existing = {sh["properties"]["title"]: sh["properties"]["sheetId"] for sh in meta["sheets"]}
    # current CF-rule counts per sheetId — so we can clear them before re-adding (idempotent).
    cf_counts = {sh["properties"]["sheetId"]: len(sh.get("conditionalFormats", [])) for sh in meta["sheets"]}
    reqs = []
    order = ["RUST", "humanitarian", "TypeScript"]
    if "RUST" not in existing:                       # rename the default first sheet to RUST
        first_id = list(existing.values())[0]
        reqs.append({"updateSheetProperties": {"properties": {"sheetId": first_id, "title": "RUST"},
                                               "fields": "title"}})
        existing["RUST"] = first_id
    for t in order:
        if t not in existing:
            reqs.append({"addSheet": {"properties": {"title": t}}})
    if reqs:
        rep = ss.batchUpdate(spreadsheetId=SID, body={"requests": reqs}).execute()
        for r in rep.get("replies", []):
            if "addSheet" in r:
                p = r["addSheet"]["properties"]; existing[p["title"]] = p["sheetId"]

    ids = {t: existing[t] for t in order}

    # ---- phase 2: write values ----
    value_data = [{"range": f"'{t}'!A1", "values": data[t]} for t in order]
    ss.values().batchUpdate(spreadsheetId=SID,
                            body={"valueInputOption": "RAW", "data": value_data}).execute()

    r_ts = len(data["TypeScript"]); r_ru = len(data["RUST"]); r_hu = len(data["humanitarian"])

    # logical Sheets Tables (native "Convert to table" objects): sheetId -> tableId
    tables = {sh["properties"]["sheetId"]: sh["tables"][0]["tableId"]
              for sh in meta["sheets"] if sh.get("tables")}
    rcount = {"RUST": r_ru, "humanitarian": r_hu, "TypeScript": r_ts}

    # ---- ALWAYS: keep DATA-TRACKING formatting in sync with the row/column count ----
    # These MUST follow the data on every push, else new rows fall outside the coloured/bordered
    # region: (1) extend each logical table's range so its borders + banding cover freshly added
    # rows/columns, (2) refresh the red→yellow→green gradient over ALL data rows. Human-tweakable
    # design (column widths, header notes, freeze, manual fills) is NOT touched here — that stays
    # opt-in under APPLY_FORMAT=1 so hand edits survive routine value refreshes.
    track = []
    # clear the script's prior gradient rules first so the refresh doesn't stack duplicates
    # Сносим ТОЛЬКО свои градиенты. Прежний слепой цикл по cf_counts убивал ВСЕ правила
    # трёх главных вкладок, включая ручные шкалы владельца (см. gsheets_common).
    for t in order:
        cf = next((s.get("conditionalFormats", []) for s in meta["sheets"]
                   if s["properties"]["sheetId"] == ids[t]), [])
        track += delete_own_rules(cf, ids[t])
    for col in (3, 5, 9, 11):                        # TS: S%, type%, A%, toolValid%
        track.append(gradient_rule(ids["TypeScript"], col, r_ts, 100))
    for col in (3, 5, 9):                            # RUST: S%, cmp%, A%
        track.append(gradient_rule(ids["RUST"], col, r_ru, 100))
    for col in (2, 3, 4, 5, 6, 7):                   # humanitarian: facts..analysis, avg (0-10)
        track.append(gradient_rule(ids["humanitarian"], col, r_hu, 10))
    # drop stray banded ranges NOT owned by a table (a table owns a band with its own id); a
    # leftover manual band overlapping the table's grown extent makes updateTable fail with
    # "cannot add alternating background colors to a range that already has alternating ...".
    # NOTE: the API returns tableId as a STRING but bandedRangeId as an INT — normalize both to
    # str, else the table's OWN band looks "stray" and deleting it invalidates the table.
    tbl_ids = {str(v) for v in tables.values()}
    for sh in meta["sheets"]:
        for b in sh.get("bandedRanges", []):
            if str(b["bandedRangeId"]) not in tbl_ids:
                track.append({"deleteBanding": {"bandedRangeId": b["bandedRangeId"]}})
    # extend each logical table to the full data extent (rows AND columns); its band grows with it
    for t in order:
        tid = tables.get(ids[t])
        if tid is not None:
            track.append({"updateTable": {"table": {"tableId": str(tid), "range": {
                "sheetId": ids[t], "startRowIndex": 0, "endRowIndex": rcount[t],
                "startColumnIndex": 0, "endColumnIndex": len(data[t][0])}},
                "fields": "range"}})
    ss.batchUpdate(spreadsheetId=SID, body={"requests": track}).execute()

    if not os.environ.get("APPLY_FORMAT"):
        print(f"refresh (values + gradient + table ranges tracked; design untouched): "
              f"RUST={r_ru-1} humanitarian={r_hu-1} TypeScript={r_ts-1}")
        print(f"https://docs.google.com/spreadsheets/d/{SID}/edit")
        return

    # ---- phase 3: full design (opt-in) — freeze / bold header / widths / header notes ----
    fmt = []
    for t in order:
        sid, ncols, nrows = ids[t], len(data[t][0]), len(data[t])
        # freeze header row + first column
        fmt.append({"updateSheetProperties": {"properties": {
            "sheetId": sid, "gridProperties": {"frozenRowCount": 1, "frozenColumnCount": 1}},
            "fields": "gridProperties.frozenRowCount,gridProperties.frozenColumnCount"}})
        # bold header + light fill + wrap
        fmt.append({"repeatCell": {
            "range": {"sheetId": sid, "startRowIndex": 0, "endRowIndex": 1},
            "cell": {"userEnteredFormat": {"textFormat": {"bold": True},
                     "backgroundColor": {"red": 0.85, "green": 0.89, "blue": 0.95},
                     "wrapStrategy": "WRAP", "verticalAlignment": "MIDDLE"}},
            "fields": "userEnteredFormat(textFormat,backgroundColor,wrapStrategy,verticalAlignment)"}})
        # model-name column a bit wider, rest auto
        fmt.append({"updateDimensionProperties": {
            "range": {"sheetId": sid, "dimension": "COLUMNS", "startIndex": 0, "endIndex": 1},
            "properties": {"pixelSize": 200}, "fields": "pixelSize"}})
        fmt.append({"autoResizeDimensions": {"dimensions": {
            "sheetId": sid, "dimension": "COLUMNS", "startIndex": 1, "endIndex": ncols}}})

    # native header notes on ALL three tabs (hover a header → what the column means)
    note_docs = {"RUST": RUST_DOCS, "humanitarian": HUM_DOCS, "TypeScript": list(inject_ts.HEADER_DOCS)}
    for t in order:
        docs = note_docs[t]
        fmt.append({"updateCells": {
            "range": {"sheetId": ids[t], "startRowIndex": 0, "endRowIndex": 1,
                      "startColumnIndex": 0, "endColumnIndex": len(docs)},
            "rows": [{"values": [{"note": d} for d in docs]}], "fields": "note"}})

    ss.batchUpdate(spreadsheetId=SID, body={"requests": fmt}).execute()

    print(f"pushed + full design: RUST={r_ru-1} humanitarian={r_hu-1} TypeScript={r_ts-1}")
    print(f"https://docs.google.com/spreadsheets/d/{SID}/edit")


if __name__ == "__main__":
    main()
