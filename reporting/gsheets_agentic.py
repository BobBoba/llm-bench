"""Push the agentic app-building benchmark (local vs cloud) into its own tab.
Reads results/<task>__<model>.json from agentic/. Idempotent (recreates the tab)."""
import os, json, glob
from googleapiclient.discovery import build
from gsheets_common import credentials

HERE = os.path.dirname(os.path.abspath(__file__))
SID = open(os.path.join(HERE, "gsheets-sheet-id.txt")).read().strip()
TAB = "Agentic app-bench 23.07"

ROWS = [
    ["Агентная сборка приложений — локаль vs облако (23.07.2026)"],
    ["Модель строит stdlib-Python приложение в много шагов (write/read/run/done, podman-изоляция), скрытый pytest оценивает. Метрики: исход% / шаги / wall-clock / $"],
    [],
    ["Задача", "модель", "тип", "исход%", "шаги", "wall_s", "cost$", "finished"],
]
rows = [json.load(open(f)) for f in sorted(glob.glob(os.path.join(HERE, "agentic", "results", "*__*.json")))]
for r in sorted(rows, key=lambda x: (x["task"], x["model"])):
    typ = "локаль" if r["client"] == "local" else "облако"
    ROWS.append([r["task"], r["model"], typ, str(r["outcome_pct"]) + "%",
                 str(r["steps"]), str(r["wall_s"]), str(r["cost_usd"]), r["finished"]])
tot = sum(r.get("cost_usd", 0) for r in rows if r["client"] == "openrouter")
ROWS += [
    [],
    ["ИТОГ стоимость облака (6 сборок)", "$%.2f" % tot],
    [],
    ["ВЫВОДЫ", "", ""],
    ["• Все 3 модели строят рабочие приложения. Облако DS-обе=100%; локальный qwen=90% (спотыкается на edge-cases)", "", ""],
    ["• DS-v4-pro — быстрее и экономнее всех на РЕАЛЬНОЙ сборке (5-11 шагов, 65-205с) — контраст с runaway на абстрактных rust-пазлах", "", ""],
    ["• DS-v3.2 надёжен (100%) но многословнее (18-31 шаг, до 485с)", "", ""],
    ["• qwen-провалы: kvstore WAL не newline-safe (многострочное значение усеклось); todo-api неверный инкремент id", "", ""],
    ["• Стоимость облака ничтожна ($0.29 за 6 приложений). Локаль: бесплатно, приватно, 90% — достаточно для рутины", "", ""],
]


def main():
    ss = build("sheets", "v4", credentials=credentials()).spreadsheets()
    meta = ss.get(spreadsheetId=SID).execute()
    for sh in meta["sheets"]:
        if sh["properties"]["title"] == TAB:
            ss.batchUpdate(spreadsheetId=SID, body={"requests": [{"deleteSheet": {"sheetId": sh["properties"]["sheetId"]}}]}).execute()
            break
    ss.batchUpdate(spreadsheetId=SID, body={"requests": [{"addSheet": {"properties": {"title": TAB}}}]}).execute()
    ss.values().update(spreadsheetId=SID, range=f"'{TAB}'!A1", valueInputOption="RAW", body={"values": ROWS}).execute()
    print(f"OK: вкладка '{TAB}' записана ({len(ROWS)} строк)")


if __name__ == "__main__":
    main()
