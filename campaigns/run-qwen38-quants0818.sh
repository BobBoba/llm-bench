#!/usr/bin/env bash
# Кампания qwen38-quants0818 [[18.08.2026]] — ЛЕСТНИЦА КВАНТОВ Qwen3.8-27B на RTX 3090 24 ГиБ.
# Поручение владельца: «замерить Q4 и ниже, насколько драматично деградирует, и найти лучшую
# пару квант↔контекст; Q2 или даже Q1 могут оказаться хороши; максимальный KV-кэш тоже найти».
#
# КЛЮЧЕВАЯ МЫСЛЬ: у Studio параметр окна ОДИН и задаёт СРАЗУ ДВА потолка — максимальную длину
# запроса И ёмкость KV-пула (кэш промптов живёт в нём же). Поэтому «максимальное окно» и
# «максимальный переиспользуемый KV» — одно и то же число, и лестница отвечает на оба вопроса.
#
# ! ИСПРАВЛЕНО [[19.08.2026]]: скобка выше НЕВЕРНА — кэш промптов живёт не в KV-пуле, а в
# ОПЕРАТИВНОЙ памяти (`--cache-ram`, умолчание 8192 МиБ, плюс `--cache-idle-slots`). Проверка:
# промпты A -> B -> A, повторный A взят из кэша даже при `-c 32768`, куда два промпта не влезают
# (campaigns/measure-prompt-cache0819.sh). Значит «максимальное окно» и «максимальный
# переиспользуемый KV» — РАЗНЫЕ величины, и поднимать пул сверх родного окна бессмысленно и
# вредно: на `-c 524288` остаток KV уходит в ОЗУ и роняет скорость втрое
# (campaigns/measure-kvpool-cliff0819.sh).
#
# МЕТОДИКА: каждый квант меряется на СВОЁМ максимуме (а не на общем окне) — это и есть
# практический вопрос «какая пара лучше». Короткие 18 задач hard-набора идентичны при любом
# окне, поэтому качество между квантами сравнимо; edit-long (промпт 63–81k) доступен только
# там, где окно позволяет — в этом и польза младших квантов.
# Конфигурация-константа: сэмплинг производителя (t=1.0/p=0.95/k=20) + reasoning_effort=medium
# (дефолтный xhigh не сходится — находка [[14.08.2026]]), KV q4_0.
#
# ! GUI НЕ ВКЛЮЧАТЬ В КОНЦЕ — прямое указание владельца на эту ночь (обычно playbook требует
#   вернуть рабочий стол; здесь стенд остаётся headless).
set -u
cd "$(dirname "$0")/.."
export LLAMA_SERVER_BASE=http://gaming-pc.lan:8888/v1
export LLAMA_SERVER_KEY_FILE=/tmp/.unsloth-gp
[ -s /tmp/.unsloth-gp ] || secret-tool lookup service unsloth-studio host gaming-pc purpose api-key > /tmp/.unsloth-gp
TOKEN=$(cat /tmp/.unsloth-gp)
REPO="unsloth/Qwen3.8-27B-GGUF"
LOG=results/qwen38-quants0818.log
LADDER=results/qwen38-quants0818-ladder.txt
: > "$LOG"; : > "$LADDER"
VS="LLM_TEMPERATURE=1.0 LLM_TOP_P=0.95 LLM_TOP_K=20"

# --- лестница: спускаемся по окнам, пока модель не разместится ПОЛНОСТЬЮ ---
# ! Порог 45 т/с, а не 25: первая проба ночи показала Q4_K_XL @131072 на 31.7 т/с при
#   `selected: None` — это ЧАСТИЧНЫЙ offload (резидентная Qwen3.8 даёт 62–77 т/с). Мягкий порог
#   пропускал деградировавшую конфигурацию, а прогон на ней стоил бы вдвое дороже по времени
#   и мерил бы не квант, а раскладку слоёв. Промежуточные значения (25–45) — именно offload:
#   у плотной модели он не «чуть медленнее», а кратно.
HEALTHY_TPS=45
find_max_ctx() {   # $1 = квант, далее список окон-кандидатов по убыванию; печатает найденное окно
  local q="$1"; shift
  for ctx in "$@"; do
    local out speed
    out=$(bash tools/ladder-probe.sh "$REPO:$q" "$ctx" 2>/dev/null)
    speed=$(echo "$out" | grep -oE "tok/s=[0-9.]+" | cut -d= -f2)
    echo "$out" >> "$LADDER"
    if [ -n "$speed" ] && [ "${speed%.*}" -ge "$HEALTHY_TPS" ] 2>/dev/null; then
      echo "$ctx"; return 0
    fi
  done
  echo 0
}

bench_quant() {    # $1 = квант, $2 = окно
  local q="$1" ctx="$2" tag
  tag=$(echo "$q" | tr 'A-Z' 'a-z' | tr -d '_')
  echo "=== $q @ $ctx: hard ===" >> "$LOG"
  env $VS MAX_TOKENS=40000 LLM_DEADLINE_MS=2400000 \
    OUT="results-hard-qwen38q-$tag.json" node runners/run-hard.mjs "$REPO:$q" >> "$LOG" 2>&1
  # иглы на четверти/половине/трёх четвертях окна — проверка, что окно не только «есть»
  local r1=$((ctx / 4)) r2=$((ctx / 2)) r3=$((ctx * 3 / 4))
  echo "=== $q @ $ctx: multineedle $r1/$r2/$r3 ===" >> "$LOG"
  env $VS LLM_DEADLINE_MS=2400000 CTX="$ctx" RUNGS="$r1,$r2,$r3" \
    OUT="results-EXP-qwen38q-$tag-multineedle.json" node runners/run-multineedle.mjs "$REPO:$q" >> "$LOG" 2>&1
}

run_point() {      # $1 = квант, далее кандидаты окон
  local q="$1"; shift
  echo "=== ЛЕСТНИЦА $q ===" >> "$LOG"
  local best
  best=$(find_max_ctx "$q" "$@")
  echo "$q: максимальное окно = $best" | tee -a "$LOG" >> "$LADDER"
  if [ "$best" != "0" ]; then bench_quant "$q" "$best"; else
    echo "$q: ни одно окно не разместилось целиком — точка пропущена" >> "$LOG"; fi
}

# Кандидаты рассчитаны по измеренной цене ячейки Qwen3.8 (~45 КБ/ток: KV q4_0 41 + MTP 4):
# бюджет = 24.1 ГиБ − веса − 0.9 (mmproj) − ~1.3 (compute). Родной потолок окна — 262144.
run_point UD-Q4_K_XL  98304 81920 65536             # веса 16.7 ГиБ (131072 замерено: offload, 31.7 т/с)
run_point UD-Q3_K_XL  229376 196608 163840 131072   # веса 12.5 ГиБ
run_point UD-Q2_K_XL  262144 229376 196608          # веса 9.9 ГиБ
run_point UD-IQ2_M    262144 229376                 # веса 9.6 ГиБ (докачивается)
run_point UD-IQ2_XXS  262144                        # веса 8.4 ГиБ — дно линейки

echo "=== qwen38-quants0818: завершено ===" >> "$LOG"
# GUI намеренно остаётся выключенным (указание владельца).
