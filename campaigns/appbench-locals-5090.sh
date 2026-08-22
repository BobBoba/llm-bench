#!/usr/bin/env bash
# Агентный app-bench трёх локальных финалистов на арендованной RTX 5090.
#
# ЗАЧЕМ. Вторая агентная батарея, где оценка ОБЪЕКТИВНА: модель строит небольшое приложение на
# стандартной библиотеке, а результат судит скрытый набор pytest, который модель не видела.
# Задачи полностью синтетические, поэтому арендованная карта здесь допустима — в отличие от
# repo-task, который идёт по закрытому репозиторию и гоняется только на своём железе.
#
# ТРИ ПОВТОРА НА ТОЧКУ. Разница в один-два процента между близкими моделями — шум; на быстрой
# карте повтор стоит минуты, поэтому статистику надо набирать, а не экономить на ней.
#
# Порядок «модель снаружи, задачи внутри» выбран ради стоимости смены модели: перезапуск сервера
# занимает больше, чем сам прогон, поэтому переключаемся трижды, а не двадцать семь раз.
set -uo pipefail
cd "$(dirname "$0")/../agentic"

GPU_HOST=root@n1.msk.cloreai.ru
GPU_PORT=2432
TUNNEL_PORT=18099
KEY_FILE=/tmp/.5090key
LOGS="$PWD/../results/appbench-logs"; mkdir -p "$LOGS"

export BENCH_ROOT="$(cd .. && pwd)"
export LLAMA_SERVER_BASE="http://127.0.0.1:${TUNNEL_PORT}/v1"
export LLAMA_SERVER_KEY_FILE="$KEY_FILE"
export MAX_STEPS=30 WALL_CAP_MIN=25 LLM_DEADLINE_MS=1800000

# Набор задач переопределяется окружением: TASKS="patcher" campaigns/appbench-locals-5090.sh
read -r -a TASKS <<< "${TASKS:-calc kvstore todo-api}"
read -r -a RUNS <<< "${RUNS:-1 2 3}"
# ключ лаунчера | ярлык в результатах
MODELS=(
  "qwen38|Qwen3.8-27B-Q3-5090"
  "muse|Muse-Glimmer-30B-Q4-5090"
  "ornith|Ornith-1.5-35B-A3B-Q4-5090"
)

health() { python3 -c "
import sys,urllib.request
k=open('$KEY_FILE').read().strip()
r=urllib.request.Request('http://127.0.0.1:${TUNNEL_PORT}/health',headers={'Authorization':'Bearer '+k})
try: sys.exit(0 if urllib.request.urlopen(r,timeout=4).status==200 else 1)
except Exception: sys.exit(1)"; }

serve() {
  local key="$1"
  echo "--- поднимаю $key на 5090 ---"
  # pkill -x, не -f: шаблон -f совпадает с собственной командной строкой и убивает обёртку.
  ssh -o BatchMode=yes -p "$GPU_PORT" "$GPU_HOST" \
    'pkill -x llama-server; sleep 10; setsid nohup /root/bin/appbench-server '"$key"' > /tmp/appbench-launch.log 2>&1 < /dev/null &' </dev/null
  for i in $(seq 1 180); do
    sleep 5
    health && { echo "готов через $((i*5)) с"
                ssh -o BatchMode=yes -p "$GPU_PORT" "$GPU_HOST" 'tail -4 /tmp/appbench-launch.log' </dev/null
                return 0; }
  done
  echo "НЕ ПОДНЯЛСЯ:"; ssh -o BatchMode=yes -p "$GPU_PORT" "$GPU_HOST" 'tail -20 /tmp/appbench-launch.log' </dev/null
  return 1
}

for entry in "${MODELS[@]}"; do
  key="${entry%%|*}"; label="${entry##*|}"
  echo "############ $(date '+%H:%M:%S')  $label ############"
  serve "$key" || { echo "SKIP $label"; continue; }
  for task in "${TASKS[@]}"; do
    for r in "${RUNS[@]}"; do
      # Уже посчитанное не переделываем: кампания длинная, обрыв возможен, повторный запуск
      # должен доделывать недостающее, а не начинать сначала.
      out="results/${task}__$(printf '%s' "$label" | tr -c '[:alnum:]._-' '_')__r${r}.json"
      if [ -f "$out" ]; then echo "  пропуск (уже есть): $task r$r"; continue; fi
      printf '  %s  %-9s r%s  ' "$(date '+%H:%M:%S')" "$task" "$r"
      BENCH_RUN="$r" timeout 1700 node agentic-app-bench.mjs "$task" "$label" local \
        > "$LOGS/${task}__${label}__r${r}.out" 2> "$LOGS/${task}__${label}__r${r}.err"
      tail -1 "$LOGS/${task}__${label}__r${r}.err" | sed 's/^DONE //'
    done
  done
done

echo "============ APPBENCH ГОТОВО $(date '+%H:%M:%S') ============"
