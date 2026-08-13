"""Перезаписывает СУЩЕСТВУЮЩИЕ строки моделей в RUST / humanitarian / TypeScript новыми замерами.

Зачем отдельный скрипт: `gsheets_add_models.py` по устройству только ДОБАВЛЯЕТ строки и пропускает
модель, если она уже присутствует. Это правильное поведение по умолчанию — оно защищает историю от
случайной перезаписи. Но есть законный случай, когда старую строку надо заменить: модель прогнали
заново, потому что у неё изменились условия (упала цена, сменился провайдер или квантизация), и
старые числа больше не описывают то, что покупает пользователь сегодня.

Логика агрегации НЕ дублируется — берётся из `gsheets_add_models.py` (те же `rust_agg`/`know_agg`/
`ts_agg`/`anchors`), поэтому перезаписанная строка считается ровно так же, как соседние.

Колонка «время до решения» здесь НЕ трогается: её целиком пересобирает `gsheets_add_ttc_column.py`,
который читает все файлы результатов и сам разрулит, какой прогон свежее. Порядок запуска:
    .venv-gsheets/bin/python gsheets_update_model_row.py
    .venv-gsheets/bin/python gsheets_add_ttc_column.py

Настроить MODELS / FILES / MODEL_META ниже, затем запустить. Есть режим `--dry-run`.
"""
import os
import sys
import json
import glob
import importlib.util
from googleapiclient.discovery import build
from gsheets_common import credentials

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "results")
SID = open(os.path.join(HERE, "gsheets-sheet-id.txt")).read().strip()

# ---- какие строки обновляем ----
MODELS = ["openai/gpt-5.6-luna"]
FILES = "luna0802"                          # префикс: results-<FILES>-{rust,ts,knowledge}.json + -humscores.json
GROUP = "new0730 → 0802"                    # метка группы: видно, что строка переизмерена
PROV = "OpenRouter (ZDR)"
MODEL_META = {
    # ! Цена ФАКТИЧЕСКОГО ZDR-эндпоинта, а не заголовок каталога.
    #   У модели 6 эндпоинтов с разбросом в 20 раз: OpenAI $0.05/$0.30 … Azure $1.10/$6.60.
    #   Поле `pricing` на уровне модели показывает САМЫЙ ДЕШЁВЫЙ ($0.10/$0.60), но ZDR-маршрутизация
    #   уводит на Azure. Проверено обратным счётом по нашим же замерам [[02.08.2026]]: при входе
    #   $1.00/1M выходная цена сходится ровно в $6.00/1M (счёт $0.073307 при 6977 вх. / 11055 вых.
    #   токенов) — это Azure-эндпоинт, вдесятеро дороже заголовка каталога.
    "openai/gpt-5.6-luna": {"ctx": 1050000, "in": 1.0, "out": 6.0, "tools": True, "reasoning": True},
}

# Переиспользуем агрегацию соседнего скрипта, чтобы строка считалась той же формулой, что остальные.
_spec = importlib.util.spec_from_file_location("gam", os.path.join(HERE, "gsheets_add_models.py"))
gam = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gam)


def load(name):
    p = os.path.join(RES, name)
    return json.load(open(p)) if os.path.exists(p) else []


def main():
    dry = "--dry-run" in sys.argv
    rust_rows = load(f"results-{FILES}-rust.json")
    ts_rows = load(f"results-{FILES}-ts.json")
    know_rows = load(f"results-{FILES}-knowledge.json")
    hum_scores = load(f"results-{FILES}-humscores.json") or {}
    print(f"записей: rust={len(rust_rows)} ts={len(ts_rows)} knowledge={len(know_rows)} "
          f"оценок судьи={len(hum_scores)}")

    ss = build("sheets", "v4", credentials=credentials()).spreadsheets()

    def values(tab, rng):
        return ss.values().get(spreadsheetId=SID, range=f"'{tab}'!{rng}",
                               valueRenderOption="UNFORMATTED_VALUE").execute().get("values", [])

    v_ru = values("RUST", "A1:T200")
    v_hu = values("humanitarian", "A1:R200")
    v_ts = values("TypeScript", "A1:Q200")
    opus_ru, ds_ru = gam.anchors(v_ru, 6)
    opus_hu, ds_hu = gam.anchors(v_hu, 8)
    na = gam.na

    updates = []
    for mid in MODELS:
        nm = gam.short(mid)
        mm = MODEL_META.get(mid, {})
        blend = round((mm.get("in", 0) + mm.get("out", 0)) / 2, 3)
        ctx = gam.ctx_label(mm.get("ctx"))
        price = f'{mm.get("in",0):g}/{mm.get("out",0):g}'
        tools_yn = "yes" if mm.get("tools") else "no"

        def find_row(cur):
            """Номер строки (1-based) по имени в первом столбце; None если не нашли."""
            for i, r in enumerate(cur[1:], start=2):
                if r and str(r[0]).strip() == nm:
                    return i
            return None

        ra = gam.rust_agg(rust_rows, mid)
        row = find_row(v_ru)
        if ra and not ra.get("loadfail") and row:
            rsn_yn = "yes" if ra["medRsn"] > 50 else "no"
            vsds = round(ra["cost"] / ds_ru, 2) if (ds_ru and ra["cost"]) else "n/a"
            vsopus = round(opus_ru / ra["cost"], 2) if (opus_ru and ra["cost"]) else "n/a"
            updates.append(("RUST", row, [nm, GROUP, blend, ra["S"], ra["full"], ra["cmp"], ra["cost"],
                                          ra["medLat"], ra["medRsn"],
                                          na(ra.get("A")), ra.get("grn", "n/a"), na(ra.get("acost")),
                                          vsds, vsopus, ctx, tools_yn, PROV, rsn_yn,
                                          na(ra["tokps"]), na(ra["ttft"])]))

        sc = hum_scores.get(mid)
        row = find_row(v_hu)
        if sc and row:
            ka = gam.know_agg(know_rows, mid)
            avg = sc.get("avg") or round(sum(sc[k] for k in
                       ("facts", "ideas", "fermi", "forecast", "analysis")) / 5, 2)
            kcost = ka.get("cost", 0)
            ktok = ka.get("tokps")
            kburst = ktok is not None and ktok > 1500
            vsopus_h = round(opus_hu / kcost, 2) if (opus_hu and kcost) else "n/a"
            vsds_h = round(kcost / ds_hu, 2) if (ds_hu and kcost) else "n/a"
            krsn = "yes" if (ka.get("rsn") or 0) > 50 else "no"
            updates.append(("humanitarian", row,
                            [nm, GROUP, sc["facts"], sc["ideas"], sc["fermi"], sc["forecast"],
                             sc["analysis"], avg, kcost, sc.get("empties", 0), vsopus_h, vsds_h,
                             ctx, "yes", PROV, krsn,
                             ("n/a" if (ktok is None or kburst) else ktok), na(ka.get("ttft"))]))

        ta = gam.ts_agg(ts_rows, mid)
        row = find_row(v_ts)
        if ta and row:
            has_rsn = any((r.get("reasonTok") or 0) > 0 for r in ts_rows if r["model"] == mid)
            updates.append(("TypeScript", row,
                            [nm, GROUP, price, na(ta["S"]), ta["full"], na(ta["typp"]), ta["cost"],
                             na(ta["medLat"]), na(ta["medRsn"]), na(ta["A"]), ta["green"],
                             na(ta["toolValid"]), ta["recovered"], ctx,
                             ("yes" if has_rsn else "no"), na(ta["tokps"]), na(ta["ttft"])]))

    if not updates:
        print("нечего обновлять: строки не найдены или нет данных")
        return
    for tab, row, vals in updates:
        print(f"  {tab} строка {row}: {vals[:9]}")
    if dry:
        print("\n--dry-run: в таблицу ничего не записано")
        return

    for tab, row, vals in updates:
        ss.values().update(spreadsheetId=SID, range=f"'{tab}'!A{row}",
                           valueInputOption="RAW", body={"values": [vals]}).execute()
    print(f"\nобновлено строк: {len(updates)}")
    print(f"https://docs.google.com/spreadsheets/d/{SID}/edit")


if __name__ == "__main__":
    main()
