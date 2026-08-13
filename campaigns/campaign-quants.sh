#!/usr/bin/env bash
# Кампания «кванты Qwen3-Coder-Next на 256k» — [[02.08.2026]].
#
# Семь точек: лесенка Unsloth Dynamic (UD) и плоские K-кванты попарно на каждой
# разрядности. Плоского Q1 в репозитории не существует (IQ1 всегда imatrix), поэтому
# на первой ступени точка одна.
#
# Замеряется на сборке llama.cpp из Unsloth Studio (b10194), НЕ на стоковой стендовой
# (6d5a910). Из-за этого перемеряются и обе точки Q4, которые уже есть на диске:
# цифры от 20.07 сняты другим движком и внутри новой таблицы несопоставимы.
#
# Постоянные всей кампании (меняется ТОЛЬКО квант весов):
#   контекст сервера 262144, KV q8_0/q8_0, flash-attn on, threads 6, ubatch 2048, слот 1.
#
# Скрипт РЕЗЮМИРУЕМЫЙ: каждая фаза отмечается файлом-маркером, повторный запуск
# продолжает с места обрыва. Безопасен к перезапуску после падения сессии.
#
#   ./campaign-quants.sh            все точки
#   ./campaign-quants.sh qcn-q2k    только указанные точки
set -u
cd "$(dirname "$0")"

STAND=root@192.168.89.53
HOSTPORT=http://192.168.89.53:8080
export LMSTUDIO_BASE="$HOSTPORT/v1"
MDIR=/opt/models/gguf
CTX=262144
# run-longctx строит лесенку как «8k, затем 25/50/75% окна». Чтобы верхняя ступень
# пришлась на ~250k (а не на 196k, как было бы при CTX=262144), окно для лесенки
# завышаем: 75% от 333000 ≈ 250k, и остаётся запас под сам ответ внутри 262144.
NIAH_CTX=333000
MARK=results/quants-campaign
mkdir -p "$MARK" results

# label : подкаталог в /opt/models/gguf : файл GGUF
#
# Основная лесенка — Qwen3-Coder-Next 80B-A3B, парами UD/плоский на каждой разрядности.
# Дополнительная — Qwen-AgentWorld-35B-A3B, укороченная и только UD: в том репозитории
# плоских K-квантов не публикуют вовсе (есть лишь Q8_0 и BF16), так что пар там не бывает.
POINTS=(
  "qcn-ud-iq1m:qwen3-coder-next:Qwen3-Coder-Next-UD-IQ1_M.gguf"
  "qcn-ud-q2kxl:qwen3-coder-next:Qwen3-Coder-Next-UD-Q2_K_XL.gguf"
  "qcn-q2k:qwen3-coder-next:Qwen3-Coder-Next-Q2_K.gguf"
  "qcn-ud-q3kxl:qwen3-coder-next:Qwen3-Coder-Next-UD-Q3_K_XL.gguf"
  "qcn-q3km:qwen3-coder-next:Qwen3-Coder-Next-Q3_K_M.gguf"
  "qcn-ud-q4km:qwen3-coder-next:Qwen3-Coder-Next-UD-Q4_K_M.gguf"
  "qcn-q4km:qwen3-coder-next:Qwen3-Coder-Next-Q4_K_M.gguf"
  "aw-ud-q2kxl:qwen-agentworld:Qwen-AgentWorld-35B-A3B-UD-Q2_K_XL.gguf"
  "aw-ud-q3kxl:qwen-agentworld:Qwen-AgentWorld-35B-A3B-UD-Q3_K_XL.gguf"
  "aw-ud-q4km:qwen-agentworld:Qwen-AgentWorld-35B-A3B-UD-Q4_K_M.gguf"
)

WANT=("$@")
selected() { [ ${#WANT[@]} -eq 0 ] && return 0; for w in "${WANT[@]}"; do [ "$w" = "$1" ] && return 0; done; return 1; }

say() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$MARK/campaign.log"; }
ssh_stand() { ssh -o BatchMode=yes -o ServerAliveInterval=30 "$STAND" "$@"; }

# Фаза выполняется один раз: маркер = имя файла. Возвращает 1, если уже сделано.
phase_done() { [ -f "$MARK/$1.done" ]; }
phase_mark() { touch "$MARK/$1.done"; }

for entry in "${POINTS[@]}"; do
  IFS=: read -r LABEL SUBDIR FILE <<< "$entry"
  GGUF="$MDIR/$SUBDIR/$FILE"
  selected "$LABEL" || continue

  say "=========== ТОЧКА $LABEL ($FILE) ==========="

  if ! ssh_stand "test -f '$GGUF'"; then
    say "  ПРОПУСК: файла нет на стенде — $GGUF"; continue
  fi

  # ---------- 1. калибровка ncmoe ----------
  NCMOE_FILE="$MARK/$LABEL.ncmoe"
  if [ ! -s "$NCMOE_FILE" ]; then
    say "  калибровка ncmoe под ctx=$CTX (двоичный поиск, ~6 загрузок)…"
    OUT=$(ssh_stand "/opt/gpu-stand/qbench-calibrate '$GGUF' $CTX" 2>&1 | tee -a "$MARK/$LABEL.calibrate.log")
    N=$(echo "$OUT" | grep -oE 'BEST_NCMOE=[0-9-]+' | cut -d= -f2)
    if [ -z "$N" ] || [ "$N" = "-1" ]; then
      say "  ПРОВАЛ: квант не влезает в 24 ГБ ни при каком ncmoe — точка выбывает"
      echo "FAILED_TO_FIT" > "$MARK/$LABEL.FAILED"; continue
    fi
    echo "$N" > "$NCMOE_FILE"
  fi
  NCMOE=$(cat "$NCMOE_FILE")
  say "  ncmoe=$NCMOE"

  # ---------- 2+3. поднять сервер и проверить его реальным prefill на 250k ----------
  #
  # Двоичный поиск находит МИНИМАЛЬНЫЙ влезающий ncmoe, а минимум нередко приходится
  # на самый край VRAM (у UD-IQ1_M это 23930 МиБ из 24119 — 99.2%). Прошлая кампания
  # уже обжигалась на таком крае: конфигурация грузилась, но разваливалась под нагрузкой.
  # Поэтому фаза скорости — она же проверка на прочность: её глубокий prefill на 250k
  # это самая тяжёлая нагрузка на VRAM во всей кампании. Не пережила — поднимаем ncmoe
  # на единицу и повторяем. В отчёт попадает тот ncmoe, который реально отработал.
  SERVER_UP=0
  for attempt in 1 2 3 4; do
    say "  старт llama-server (Studio b10194), ncmoe=$NCMOE, попытка $attempt…"
    START_OUT=$(ssh_stand "/opt/gpu-stand/qbench start '$GGUF' $NCMOE $CTX '$LABEL'" 2>&1)
    say "  $START_OUT"
    case "$START_OUT" in
      *state=ready*) : ;;
      *) say "  сервер не поднялся при ncmoe=$NCMOE — +1"; NCMOE=$((NCMOE + 1)); echo "$NCMOE" > "$NCMOE_FILE"; continue ;;
    esac
    echo "$START_OUT" | grep -oE '[0-9]+ MiB' | head -1 > "$MARK/$LABEL.vram"

    if phase_done "$LABEL.speed"; then SERVER_UP=1; break; fi

    say "  скорость: мелкая точка + глубокая 250k (prefill идёт минутами, он же стресс-тест)…"
    if OUT=results-quants-speed.json node runners/probe-speed.mjs "$HOSTPORT" "$LABEL" 250000 \
         >> "$MARK/$LABEL.speed.log" 2>&1; then
      phase_mark "$LABEL.speed"; SERVER_UP=1; break
    fi
    say "  глубокий prefill не пережил ncmoe=$NCMOE — +1 и повтор"
    NCMOE=$((NCMOE + 1)); echo "$NCMOE" > "$NCMOE_FILE"
  done
  if [ "$SERVER_UP" != 1 ]; then
    say "  ПРОВАЛ: точка не стабилизировалась за 4 попытки — пропуск"
    echo "unstable after 4 ncmoe bumps" > "$MARK/$LABEL.FAILED"; continue
  fi
  say "  рабочий ncmoe=$NCMOE, VRAM $(cat "$MARK/$LABEL.vram" 2>/dev/null)"

  # ---------- 4. батарея качества ----------
  if ! phase_done "$LABEL.rust"; then
    say "  Rust…"
    OUT=results-quants-rust.json node runners/run-rust.mjs "$LABEL" >> "$MARK/$LABEL.rust.log" 2>&1 && phase_mark "$LABEL.rust"
  fi
  if ! phase_done "$LABEL.ts"; then
    say "  TypeScript…"
    OUT=results-quants-ts.json node runners/run-ts.mjs "$LABEL" >> "$MARK/$LABEL.ts.log" 2>&1 && phase_mark "$LABEL.ts"
  fi
  if ! phase_done "$LABEL.knowledge"; then
    say "  знания (сбор ответов; судейство — отдельной фазой в конце)…"
    OUT=results-quants-knowledge.json node runners/run-knowledge.mjs "$LABEL" >> "$MARK/$LABEL.knowledge.log" 2>&1 && phase_mark "$LABEL.knowledge"
  fi
  for tu in tooluse tooluse-calc tooluse-hard tooluse-long; do
    if ! phase_done "$LABEL.$tu"; then
      say "  $tu…"
      OUT=results-quants-$tu.json node "run-$tu.mjs" "$LABEL" >> "$MARK/$LABEL.$tu.log" 2>&1 && phase_mark "$LABEL.$tu"
    fi
  done

  # ---------- 5. длинный контекст ----------
  if ! phase_done "$LABEL.longctx"; then
    say "  NIAH до ~250k (3 глубины × 4 ступени) — самая долгая фаза…"
    CTX=$NIAH_CTX OUT=results-quants-longctx.json node runners/run-longctx.mjs "$LABEL" \
      >> "$MARK/$LABEL.longctx.log" 2>&1 && phase_mark "$LABEL.longctx"
  fi
  if ! phase_done "$LABEL.multineedle"; then
    say "  multineedle…"
    CTX=$NIAH_CTX OUT=results-quants-multineedle.json node runners/run-multineedle.mjs "$LABEL" \
      >> "$MARK/$LABEL.multineedle.log" 2>&1 && phase_mark "$LABEL.multineedle"
  fi

  ssh_stand "/opt/gpu-stand/qbench stop" >/dev/null 2>&1
  say "  точка $LABEL завершена"
done

say "=========== ВСЕ ТОЧКИ ПРОЙДЕНЫ ==========="
say "Осталось: судейство знаний (judge-knowledge.mjs) и выгрузка в Google Sheets."
touch "$MARK/ALL_DONE"
