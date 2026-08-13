# Time-to-Solution Benchmark — omp vs pi harness

Design spec. Дата: [[20.07.2026]]. Статус: approved, готов к плану реализации.

## Цель

Измерить **wall-clock время до доставки рабочего решения** (не tok/s) для набора моделей, прогоняя их через два агентских харнесса — `omp` (форк `@oh-my-pi/pi-coding-agent`) и `pi` (upstream `@earendil-works/pi-coding-agent`). Дополнительно измерить **стоимость доставки решения** для OpenRouter-моделей (реальный `usage.cost`), и **разницу в качестве/производительности между самими харнессами** omp и pi.

Ключевая мотивация: `wall-clock != tok/s`. Reasoning-модель может быть быстрой по токенам, но тратить их на размышления и приходить к решению позже «немого» кодера. Метрика «время до рабочего решения» уравнивает это.

## Матрица

- **Модели (8):**
  - OpenRouter (6, реальная стоимость): `deepseek/deepseek-v3.2` (ds 3.2), `deepseek/deepseek-v4-pro` (ds v4 pro), `anthropic/claude-sonnet-4.5`, `anthropic/claude-sonnet-5`, `anthropic/claude-opus-4.8`, `anthropic/claude-haiku-4.5`.
    - Точные slug'и подтверждаются дешёвым `-p "hi"`-пробником до массового прогона.
  - llama-server (2, локально, $0): `ornith-1.0-35b`, `qwen3-coder-next`.
- **Харнессы (2):** `omp`, `pi`.
- **Ступени задач (5):** см. ниже.
- **Итого:** 8 × 2 × 5 = **80 агентских прогонов**, 1 попытка (1 сессия) на ячейку.
- **Бюджет:** грубо OpenRouter ~$8–20 (single attempt; фактическая сумма из `usage.cost`, сверяется с дашбордом OpenRouter после прогона — известна гоча занижения встроенных cost-аккаунтингов).

## Лестница задач

Шаблоны лежат в `tts/tasks/<id>/`, копируются в изолированный скретч-каталог перед каждым прогоном.

| # | id | Язык | Задача | Оракул («решено») |
|---|---|---|---|---|
| 1 | `r1-edit` | Rust | Тривиальная правка: изменить строковый литерал/константу в одном файле, тесты держать зелёными | `cargo test` green **и** grep нового значения в источнике |
| 2 | `r2-bugfix` | Rust | Bugfix: стартовый крейт с реальным багом и красным тестом (off-by-one в `median`); почини, **не трогая тест** | `cargo test` green **и** `git diff tests/` пуст |
| 3 | `r3-feature` | Rust | Фича: добавить `fn is_palindrome(&str)->bool` (unicode-aware, ignore case/spaces) + модульные тесты | скрытый (подкладываемый оракулом) тест-файл + `cargo test` green |
| 4 | `t4-cli` | TS/bun | CLI с нуля: `lc` — счётчик строк/слов/байт файла-аргумента, флаги `--lines`/`--words` | `tsc --strict --noEmit` clean **и** smoke: `bun run` на sample-файле, сверка stdout |
| 5 | `t5-webapi` | TS/bun | Web-app с нуля: in-memory Todo JSON API на `Bun.serve` — `POST /todos`, `GET /todos`, `DELETE /todos/:id` | `tsc --strict --noEmit` clean **и** smoke: поднять сервер, curl по эндпоинтам, проверить ответы/коды |

Оракулы детерминированы, автоматизированы, идемпотентны. Тест-файлы задач 2/3 защищены от правки (проверка `git diff`).

## Протокол замера

Одна агентская сессия на ячейку даёт обе временны́е и обе стоимостные метрики.

1. **`t0`** — момент отправки запроса. Промпт задачи включает инструкцию самопроверки: «не завершай, пока сборка/тесты не зелёные — проверь сам, запустив их».
2. **`t1`** — первое «готово» агента → внешний оракул → фиксируем `TTS_single`, `pass_single`, `cost_single`.
3. **Guided-to-completion (дошагивание):** если внешний оракул красный — возобновляю **ту же** сессию сообщением с выводом оракула («сборка упала: `<лог>`; продолжай и доведи до зелёного»), до **cap = 3 раунда дошагивания** и/или тайм-бюджета (Rust 15 мин, app 20 мин на всю ячейку).
   - Момент первого внешнего green → `TTS_guided`, `pass_guided`, `cost_guided`, `steering_rounds`.
   - Исчерпание раундов / тайм-аут → `pass_guided=false`, `TTS_guided=null`.
4. Guided-режим требует сохранённой сессии (омит `--no-session`, задать `--session-dir` на прогон); single-only измерение фиксируется на шаге 2 внутри той же сессии.

### Метрики на запись (одна ячейка)

`harness, model, task, lang, TTS_single_s, TTS_guided_s, pass_single, pass_guided, steering_rounds, cost_single_usd, cost_guided_usd, tokens_in, tokens_out, tokens_reason, tool_calls, turns, files_changed, finish_reason, error, timeout_hit`.

Стоимость: из `usage.cost` агента (`--mode json`), т.е. фактическая цена OpenRouter (учитывает провайдер-роутинг/кэш), а не расчёт по прайсу. Локальные модели → `0`.

## Маршрутизация и сериализация на одном RTX 3090

Один 3090 не вмещает ornith (~20 ГБ) и qwen (~45 ГБ с offload) одновременно → локальная часть сериализуется, минимум 2 перезагрузки:

- **Фаза A:** 60 OpenRouter-ячеек (6 моделей × 2 харнесса × 5 задач) — без локальной зависимости.
- **Фаза B:** поднять `ornith-1.0-35b` на llama-server (:8080, direct) → 10 ячеек.
- **Фаза C:** сменить загруженную модель на `qwen3-coder-next` (champion-конфиг: `--n-cpu-moe 26 --flash-attn on --cache-type-k/v q8_0 --ctx-size 32768 --threads 6`) → 10 ячеек.

llama-server поднимается на gaming-pc (Windows) через scheduled task (паттерн прошлой сессии, `serve.ps1`).

## Паритет харнессов (честность сравнения omp vs pi)

Единственная переменная между парными ячейками — сам харнесс. Фиксируется одинаково для обоих:
- `--thinking high` (общий потолок; у pi максимум `xhigh`, у omp есть выше — берём общий `high`).
- Авто-одобрение tool-calls: omp `tools.approvalMode: yolo`; pi — эквивалент в `-p`-режиме (проверить, что edits не блокируются интерактивным подтверждением).
- Одинаковый набор инструментов, одинаковый скретч-шаблон, очистка `CLAUDE_*`-env при спавне.
- Провайдеры/модели объявлены в обоих конфигах: omp `~/.omp/agent/models.yml` (YAML), pi `~/.pi/agent/models.json` (JSON). `qwen3-coder-next` добавляется в оба; OpenRouter+llama-server провайдеры должны присутствовать в обоих.

## Архитектура кода

```
/code/work/llm-bench/tts/
  tasks/                     # шаблоны задач (r1-edit, r2-bugfix, r3-feature, t4-cli, t5-webapi)
  oracles/                   # проверка «решено» на каждую задачу (build/typecheck/test/smoke)
  harness.mjs                # обёртка вызова агента (omp|pi): спавн, --mode json, нормализация usage/cost
  run-tts.mjs                # драйвер матрицы: скретч, замер t0/t1, оракул, дошагивание, запись
  results-tts.json           # сырые результаты (одна запись = одна ячейка)
gsheets_tts.py               # выгрузка сводных таблиц в новую вкладку(и), reuse gsheets_common.py
```

Паттерн повторяет существующий репозиторий: драйвер на Node (`run-*.mjs`) → JSON → выгрузка на Python (`gsheets_*.py`).

## Выводы

- **Vault:** `claudedocs/time-to-solution-omp-vs-pi-bench.md` — TL;DR, матрица TTS, omp-vs-pi дельты (время/токены/стоимость/шаги/pass-rate), локальные vs OpenRouter, гочи; строка в дневной заметке `[[20.07.2026]]`.
- **Google Sheets** (новая вкладка(и) в книге «LLM Benchmark», SHEET_ID `1mhSrYrJU0mIte3nBQ7RHiRTiFXNfZ72QrfRa_WiPhRM` — SA не может создать новый файл из-за нулевой Drive-квоты):
  - (a) сырая матрица 80 строк;
  - (b) сводка omp-vs-pi по каждой паре (модель × задача): дельты времени/стоимости/шагов/pass;
  - (c) рейтинг «время-до-решения» и рейтинг «цена-за-доставку» (`$/solution single`, `$/solution guided`, `$ за успешное решение`) — по OpenRouter-моделям.

## Риски / открытые пункты

- pi `-p` авто-одобрение edits — проверить до массового прогона (может упереться в подтверждение).
- Формат `usage`/`cost` в `--mode json` может отличаться у omp и pi — `harness.mjs` нормализует; заложить fallback-парсер.
- gaming-pc: наличие обоих gguf на `D:\models` (ornith Q4_K_M + qwen) и запуск llama-server.
- Встроенный cost-аккаунтинг агентов бывает занижен → пост-сверка суммы `cost_guided` OpenRouter-ячеек с дашбордом OpenRouter за окно бенчмарка.
- Слабые локальные модели на ступени 5 могут не собрать app — валидный `fail`, не ошибка харнесса.
- Точные OpenRouter-slug'и (особенно `deepseek-v3.2`) подтверждаются пробником до прогона.
