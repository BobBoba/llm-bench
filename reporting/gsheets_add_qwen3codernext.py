"""Add a tab to the LLM Benchmark sheet with the Qwen3-Coder-Next MoE CPU-offload
research (RTX 3090). Perf sweep + long-context curve + llm-bench quality per axis.
Run: /code/work/llm-bench/.venv-gsheets/bin/python gsheets_add_qwen3codernext.py
"""
import gspread
import gsheets_common

SHEET_ID = "1mhSrYrJU0mIte3nBQ7RHiRTiFXNfZ72QrfRa_WiPhRM"
TAB = "Qwen3CoderNext offload 20.07"

gc = gspread.authorize(gsheets_common.credentials())
sh = gc.open_by_key(SHEET_ID)

# recreate the tab cleanly if it already exists
try:
    old = sh.worksheet(TAB)
    sh.del_worksheet(old)
except gspread.WorksheetNotFound:
    pass
ws = sh.add_worksheet(title=TAB, rows=80, cols=6)

R = []               # rows
hdr = []             # row-indices (1-based) to render bold
def add(*cols):
    R.append(list(cols))
def sec(title):
    hdr.append(len(R) + 1)
    R.append([title])
def blank():
    R.append([""])

add("Qwen3-Coder-Next 80B-A3B  -  MoE CPU-offload на RTX 3090")
hdr.append(1)
add("20.07.2026 · Q4_K_M (45.2 ГБ, 80B total / ~3B active) · llama.cpp b10068 · offload экспертов на CPU")
blank()

sec("ЖЕЛЕЗО")
add("GPU", "RTX 3090 24 ГБ (WDDM, драйвер 610.62)")
add("CPU", "Ryzen 7 5800X3D, 8C/16T, 96 МБ 3D V-Cache, AVX2 (нет AVX-512)")
add("RAM", "64 ГБ DDR4-3600 dual-channel (~50 ГБ/с)")
blank()

sec("КРИВАЯ КОНТЕКСТА (скорость генерации)")
add("Контекст", "ncmoe", "pp512 t/s", "tg t/s")
add("4K", 26, 359.8, 47.7)
add("32K", 26, 373.9, 45.2)
add("64K", 30, 332.9, 37.8)
add("128K", 30, 304.4, 33.2)
add("256K (нативный максимум)", 34, 252.8, 24.5)
add("Итог", "падение всего -49% на 8x контекста, без spill — гибридный attention (linear-слои O(1))")
blank()

sec("ЛЕСЕНКА --n-cpu-moe (fa1, KV q8_0)")
add("ncmoe", "pp2048 t/s", "tg t/s", "примечание")
add(30, 334.8, 39.5, "18 expert-слоёв на GPU")
add(28, 354.1, 44.2, "")
add(26, 374.1, 46.6, "ПИК — колено VRAM")
add(24, 84.6, 21.8, "ОБВАЛ — spill в Shared GPU Memory (при pp2048)")
blank()

sec("ПОТОКИ CPU (ncmoe=26) — сигнатура 3D V-Cache")
add("threads", "pp512 t/s", "tg t/s")
add(4, 266.9, 49.5)
add(6, 378.6, 49.3)
add(8, 385.2, 48.0)
add(12, 388.9, 44.9)
add(16, 390.4, 38.9)
add("Вывод", "генерация любит меньше потоков (bandwidth-bound), prompt-processing — больше")
blank()

sec("КАЧЕСТВО (харнесс llm-bench, свип 44 мин)")
add("Ось", "Результат")
add("Rust codegen", "single 98.7% / agentic 98.7%, компилируется 100% (8/9 задач идеально)")
add("TypeScript", "single 98.7% / agentic 100% (tsc --strict + bun test)")
add("Знания (судья Opus 4.8)", "8.2/10 · facts 9.5, analysis 9, forecast 8.5, fermi 7.5, ideas 6.5")
add("Tool-call формат", "validRate 1.0, 0 malformed за 18 прогонов")
add("Tool-use финал", "calc 100%, basic/hard/long 0% (верный клиент, неверная итоговая сумма)")
add("Long-context needle", "12/12 (100%) на 8K/32K/64K/96K")
add("Multineedle", "recall 1.0 (8/8 иголок)")
add("Скорость (ncmoe=30)", "~36-38 tok/s, ttft ~1.1-1.2 с, reason=0 (non-thinking)")
blank()

sec("КОНТРОЛЬ: ornith 35B-A3B (влезает в 24 ГБ целиком)")
add("Режим", "pp512 t/s", "tg t/s")
add("Полный GPU (ncmoe=0)", 3553, 157.9)
add("Все эксперты на CPU (ncmoe=999)", 356, 41.3)
add("Вывод", "offload вредит модели, которая влезает: -74% генерации, -90% prompt")
blank()

sec("ЧЕМПИОН-КОНФИГ (llama-server)")
add("--n-gpu-layers 99 --n-cpu-moe 26 --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 --ctx-size 32768 --threads 6 --batch-size 2048 --ubatch-size 512 --jinja")
add("ncmoe по контексту: 26 (<=32K) / 30 (128K) / 34 (256K)")
blank()
add("Полный отчёт (vault): claudedocs/qwen3-coder-next-moe-offload-rtx3090.md")

ws.update(values=R, range_name="A1")

# formatting: bold section headers + title, widen col A
ws.format("A1", {"textFormat": {"bold": True, "fontSize": 13}})
for i in hdr[1:]:
    ws.format(f"A{i}", {"textFormat": {"bold": True}, "backgroundColor": {"red": 0.85, "green": 0.9, "blue": 0.98}})
sh.batch_update({"requests": [{
    "updateDimensionProperties": {
        "range": {"sheetId": ws.id, "dimension": "COLUMNS", "startIndex": 0, "endIndex": 1},
        "properties": {"pixelSize": 340}, "fields": "pixelSize"}}]})

print("OK ->", TAB, "|", len(R), "rows | url:", sh.url)
