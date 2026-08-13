"""Push GPU-stand (headless Arch, RTX 3090) benchmark results into its own tab.

Same shared sheet (gsheets-sheet-id.txt), auth via gsheets_common (secret-service SA key).
Idempotent: recreates the tab if it already exists. New tab only — existing data untouched.
"""
import os
from googleapiclient.discovery import build
from gsheets_common import credentials

HERE = os.path.dirname(os.path.abspath(__file__))
SID = open(os.path.join(HERE, "gsheets-sheet-id.txt")).read().strip()
TAB = "GPU-stand ornith 22.07"

ROWS = [
    ["GPU-стенд (headless Arch, RTX 3090, ОС держит 0 MiB VRAM) — бенчмарк 22.07.2026"],
    ["ornith-1.0-35B Q4_K_M (qwen3_5_moe, A3B), стоковый llama.cpp CUDA sm_86, KV Q4, flash-attn"],
    [],
    ["Одиночный throughput vs контекст (full-GPU, KV Q4)"],
    ["Контекст", "tg tok/s", "pp tok/s"],
    ["0", "179.3", "3652"],
    ["4k", "173.5", "3461"],
    ["16k", "153.7", "3110"],
    ["32k", "132.0", "2735"],
    ["64k", "102.6", "2224"],
    ["128k", "71.3", "1602"],
    ["256k (влезает в 24GB)", "44.5", "1029"],
    [],
    ["Параллелизм (--parallel N, cont-batching, ctx 4k/слот)"],
    ["Конкуренция", "агрегат tok/s", "на поток"],
    ["1", "158.2", "158.2"],
    ["2", "259.3", "129.6"],
    ["4", "330.9", "82.7"],
    ["8", "331.2", "41.4"],
    [],
    ["MoE-offload (30/40 слоёв экспертов в CPU)"],
    ["Режим", "VRAM", "tg tok/s", "PCIe"],
    ["full-GPU", "20.7 GB", "183", "-"],
    ["offload 30", "7.1 GB", "64.5", "Gen4 под нагрузкой"],
    [],
    ["qwen3-coder-next 80B Q4_K_M: Linux-стенд vs Windows (та же машина, MoE-offload)"],
    ["ncmoe", "Windows tg", "Linux tg", "Windows pp", "Linux pp"],
    ["30", "39.5", "53.2", "334.8", "384.5"],
    ["28", "44.2", "55.7", "354.1", "409.0"],
    ["26 (колено)", "46.6", "58.4", "374.1", "424.2"],
    ["24", "спилл (нестаб.)", "OOM (честный)", "84.6", "-"],
    [],
    ["qwen3-coder-next: контекст (Linux, ncmoe масштабируется)"],
    ["Контекст", "ncmoe", "Linux tg", "Windows tg"],
    ["4k", "26", "57.8", "47.7"],
    ["64k", "30", "44.5", "37.8"],
    ["128k", "30", "37.8", "33.2"],
    ["256k", "34", "27.8", "24.5"],
    [],
    ["throughput при РЕАЛЬНО заполненном контексте x параллелизм (агрегат tok/s)"],
    ["глубина", "P=1", "P=2", "P=4", "P=8"],
    ["32k", "128.8", "104.5", "85.0", "84.3"],
    ["64k", "100.8", "77.3", "72.2", "52.8 (offload)"],
    ["128k", "71.2", "59.3", "45.9 (offload)", "KV>560k"],
    ["256k", "44.5", "-", "-", "-"],
    ["на реальном контексте параллелизм РОНЯЕТ агрегат (упор в полосу памяти) — противоположно пустому контексту", "", "", "", ""],
    [],
    ["vLLM vs llama.cpp (ornith-35B 4-бит, короткий контекст)"],
    ["параллелизм", "llama.cpp Q4_K_M", "vLLM GPTQ (eager)"],
    ["P=1", "158-179", "20.5"],
    ["P=2 агрегат", "259", "39.7"],
    ["P=4 агрегат", "331", "79.4"],
    ["P=8 агрегат", "331 (плато)", "158.4"],
    ["vLLM влез только с --enforce-eager (иначе OOM) -> single ~8x медленнее; линейный батчинг, но обгонит только при 16+ потоках", "", ""],
    [],
    ["ВЫВОД: headless-Linux стенд +25-36% к Windows/LM Studio на том же железе; для ornith/qwen на одиночной 3090 llama.cpp безальтернативен, vLLM неприменим (тесная VRAM)"],
    [],
    ["Qwen-AgentWorld-35B vs ornith-35B — интеллект (харнесс llm-bench, судья Opus 4.8)"],
    ["ось", "AgentWorld", "ornith"],
    ["Knowledge avg /10", "8.54", "8.22"],
    ["  facts (0 галл. у обоих)", "9.7", "9.6"],
    ["  fermi", "9.0", "7.5"],
    ["  ideas / forecast / analysis", "7.5 / 8 / 8.5", "7.5 / 8 / 8.5"],
    ["Rust single (compile+test)", "4/6 (expr100 lru0 wc100)", "3/6 (expr50 lru100 wc0)"],
    ["TypeScript single", "5/6 (expr100 lru100 async67-100)", "n/a"],
    ["Agentic (fixed tool_choice=required)", "67% (expr100 lru0 wc100)", "100%"],
    ["скорость", "~145-152 t/s", "~170 t/s"],
    ["* ранний agentic 0% — артефакт tool_choice=auto (reasoning-модель выдавала код в content без tool-вызова); с required = 67%. Вывод: AgentWorld чуть умнее ornith (knowledge+код)", "", ""],
    [],
    ["Реальные задачи: Qwen3-Coder-Next 80B (offload) vs AgentWorld 35B (full-GPU) — время решения (rust-набор)"],
    ["задача", "Qwen-Coder-Next 80B (56 t/s)", "AgentWorld 35B (148 t/s)"],
    ["expr single", "92% / ~22s", "100% / ~77s"],
    ["lru single", "100% / ~10s", "45% / ~105s"],
    ["wordcount single", "100% / ~7s", "100% / ~38s"],
    ["agentic expr", "96% / 28s", "100% / 91s"],
    ["agentic lru", "100% green / 24s", "0% / 281s"],
    ["agentic wordcount", "100% green / 18s", "100% green / 59s"],
    ["ИТОГО wall-clock", "149s", "871s"],
    ["Вывод: Qwen-Coder-Next в ~5.8x быстрее по реальному времени, хотя tok/s в 2.6x ниже — решает лаконичнее (в 5-8x меньше токенов). Время решения = краткость, а не tok/s. Qwen ещё и точнее (решает LRU)", "", ""],
    [],
    ["TypeScript single-shot: AgentWorld vs Qwen-Coder-Next"],
    ["задача", "AgentWorld", "Qwen-Coder-Next"],
    ["expr", "100% / 100%", "28% / 100%"],
    ["lru", "100% / 100%", "100% / 100%"],
    ["asyncpool", "67% / 100%", "100% / 92%"],
    ["agentic green", "2/3 (с фиксом)", "2/3"],
    [],
    ["AgentWorld — фактология детально (14-проб. батарея, судья Opus)"],
    ["итог", "12/14 correct, 2 partial, 0 wrong (0 галлюцинаций)", ""],
    ["все V верны; все F опровергнуты; U честно declined (2 partial — упущен нюанс). Отсюда facts=9.7", "", ""],
    [],
    ["=== ЛОКАЛЬ vs ОБЛАКО (один судья Opus, одни задачи) ==="],
    ["Knowledge avg /10 (ранжир)", "", ""],
    ["DeepSeek-v4-pro (облако)", "8.64", ""],
    ["AgentWorld-35B (локаль)", "8.5", ""],
    ["MiMo-V2.5-Pro (облако)", "8.4", ""],
    ["ornith-35B (локаль)", "8.22", ""],
    ["qwen-coder-next (локаль)", "~8.2", ""],
    ["DeepSeek-v3.2 (облако)", "8.08", ""],
    ["", "", ""],
    ["Rust: модель", "single / agentic", "wall-clock"],
    ["qwen-coder-next (локаль)", "97% / 99%", "149s"],
    ["MiMo (облако)", "100% / 67%", "420s"],
    ["AgentWorld (локаль)", "81% / 67%", "871s"],
    ["DeepSeek-v4-pro (облако)", "74% / 67%", "1305s"],
    ["DeepSeek-v3.2 (облако)", "63% / 100%", "676s"],
    ["ВЫВОД: разрыв локаль↔облако практически исчез. qwen-coder-next обходит обе DeepSeek по коду и в 3-9x быстрее любого облака (бесплатно); AgentWorld — лучший по знаниям после единственного облачного v4-pro (самого медленного). Локаль впереди по скорости/цене", "", ""],
    [],
    ["=== Threadripper vs 5800X3D для MoE-offload (all-CPU decode tg, измерено) ==="],
    ["Модель (A3B)", "Стенд 5800X3D (2ch+VCache Zen3)", "Threadripper 3970X (4ch Zen2)"],
    ["ornith 35B", "17.5 t/s", "16.7 t/s"],
    ["qwen-coder-next 80B", "14.4 t/s", "10.5 t/s"],
    ["ВЫВОД: 4-канальная память Threadripper НЕ ускоряет MoE-декод (даже -30% на 80B) — упор в латентность/кэш, Zen3+VCache бьёт Zen2. R9700(32GB)+Threadripper НЕ даст offload-выигрыша; ценность R9700 только в 32GB VRAM. Для qwen80B лучше 3090+R9700=56GB (модель целиком на 2 GPU без offload)", "", ""],
]


def main():
    sheets = build("sheets", "v4", credentials=credentials())
    ss = sheets.spreadsheets()
    # Пересоздать вкладку идемпотентно: если есть — удалить, затем создать.
    meta = ss.get(spreadsheetId=SID).execute()
    for sh in meta["sheets"]:
        if sh["properties"]["title"] == TAB:
            ss.batchUpdate(spreadsheetId=SID, body={"requests": [
                {"deleteSheet": {"sheetId": sh["properties"]["sheetId"]}}]}).execute()
            break
    ss.batchUpdate(spreadsheetId=SID, body={"requests": [
        {"addSheet": {"properties": {"title": TAB}}}]}).execute()
    ss.values().update(
        spreadsheetId=SID, range=f"'{TAB}'!A1",
        valueInputOption="RAW", body={"values": ROWS}).execute()
    print(f"OK: вкладка '{TAB}' записана ({len(ROWS)} строк) в {SID}")


if __name__ == "__main__":
    main()
