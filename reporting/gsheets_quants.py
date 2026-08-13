"""Вкладка «Кванты Qwen3-Coder-Next @256k» в общей таблице бенчмарка.

В отличие от прежних выгрузок (gsheets_gpu_stand.py и т.п.), где строки захардкожены,
эта читает фактические результаты из results/results-quants-*.json. Скрипт идемпотентен
и рассчитан на многократный перезапуск: по мере того как кампания добавляет точки,
достаточно запустить его снова — вкладка перестроится с уже собранными данными,
а недостающие ячейки останутся с прочерком.

Запуск:  .venv-gsheets/bin/python gsheets_quants.py
"""
import json
import os
from collections import defaultdict

from googleapiclient.discovery import build
from gsheets_common import credentials

HERE = os.path.dirname(os.path.abspath(__file__))
SID = open(os.path.join(HERE, "gsheets-sheet-id.txt")).read().strip()
RES = os.path.join(HERE, "..", "results")
MARK = os.path.join(RES, "quants-campaign")
TAB = "Кванты Qwen3CoderNext 256k 02.08"

DASH = "—"

# Порядок точек = порядок возрастания разрядности.
#
# Qwen3-Coder-Next: плоского Q1 в репозитории нет — однобитные кванты существуют только
# в i-виде (IQ1), а он всегда требует imatrix, поэтому на первой ступени пары нет.
# AgentWorld: плоских K-квантов не публикуют вовсе (только Q8_0 и BF16), поэтому вся
# его лесенка одно-семейная и укороченная — три точки.
QCN = [
    ("qcn-ud-iq1m",   "UD-IQ1_M",    "UD",      21.7),
    ("qcn-ud-q2kxl",  "UD-Q2_K_XL",  "UD",      26.8),
    ("qcn-q2k",       "Q2_K",        "плоский", 29.2),
    ("qcn-ud-q3kxl",  "UD-Q3_K_XL",  "UD",      36.3),
    ("qcn-q3km",      "Q3_K_M",      "плоский", 38.3),
    ("qcn-ud-q4km",   "UD-Q4_K_M",   "UD",      49.3),
    ("qcn-q4km",      "Q4_K_M",      "плоский", 48.5),
]
AW = [
    ("aw-ud-q2kxl",   "UD-Q2_K_XL",  "UD",      12.3),
    ("aw-ud-q3kxl",   "UD-Q3_K_XL",  "UD",      16.8),
    ("aw-ud-q4km",    "UD-Q4_K_M",   "UD",      22.1),
]
GROUPS = [("Qwen3-Coder-Next 80B-A3B", QCN), ("Qwen-AgentWorld-35B-A3B", AW)]
POINTS = QCN + AW


def load(name):
    """Возвращает содержимое results/<name>. Пустой список, если файла нет или он битый —
    выгрузка должна работать и на частично собранных данных."""
    try:
        with open(os.path.join(RES, name), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def read_mark(label, ext):
    try:
        with open(os.path.join(MARK, f"{label}.{ext}"), encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return None


def pct(numer, denom):
    return DASH if not denom else f"{100.0 * numer / denom:.1f}%"


def codegen_stats(rows, label, ok_field):
    """Доля пройденных скрытых тестов по режимам single/agentic + доля собираемости.

    `pct` в записи — доля тестов, прошедших в ОДНОМ прогоне; усредняем по прогонам режима.
    `ok_field` различается между батареями: Rust пишет `compiles`, TypeScript — `typechecks`
    (расхождение имён — известный артефакт харнесса, не опечатка).

    Вместе с числом возвращается РАЗМЕР ВЫБОРКИ. Это принципиально: метрика — доля
    пройденных тестов по трём задачам, и одна задача, решённая или проваленная целиком,
    сдвигает среднее на десятки пунктов. Без указания n читатель примет шум за сигнал
    и начнёт ранжировать соседние кванты там, где разница внутри разброса.
    """
    by_mode = defaultdict(list)
    build_ok, build_n = 0, 0
    for r in rows:
        if r.get("model") != label or not r.get("ok"):
            continue
        by_mode[r.get("mode")].append(r.get("pct") or 0)
        build_n += 1
        if r.get(ok_field):
            build_ok += 1
    def avg(m):
        v = by_mode.get(m) or []
        return DASH if not v else f"{100.0 * sum(v) / len(v):.0f}% (n={len(v)})"
    return avg("single"), avg("agentic"), (pct(build_ok, build_n) if build_n else DASH)


def speed_stats(rows, label):
    sh = next((r for r in rows if r.get("label") == label and r.get("depth") == "shallow"), None)
    dp = next((r for r in rows if r.get("label") == label and r.get("depth") == "deep"), None)
    g = lambda r, k: DASH if not r or r.get(k) is None else r[k]
    prefill = DASH
    if dp and dp.get("prefillSec"):
        prefill = f"{dp['prefillSec'] / 60:.1f} мин"
    return g(sh, "ppTokPerSec"), g(sh, "tgTokPerSec"), g(dp, "ppTokPerSec"), g(dp, "tgTokPerSec"), prefill


def niah_stats(rows, label):
    """Доля найденных иголок по ступеням длины — главный ответ на вопрос
    «переживает ли квант длинный контекст». Ступени берём из фактических данных,
    чтобы отчёт не врал, если лесенка отработала не полностью."""
    by_rung = defaultdict(lambda: [0, 0])
    for r in rows:
        if r.get("model") != label or not r.get("ok"):
            continue
        k = r.get("promptTok") or r.get("targetTok") or 0
        rung = min([8, 83, 166, 250], key=lambda x: abs(x - k / 1000))
        by_rung[rung][1] += 1
        if r.get("found"):
            by_rung[rung][0] += 1
    out = {}
    for rung in (8, 83, 166, 250):
        ok, n = by_rung.get(rung, [0, 0])
        out[rung] = pct(ok, n)
    return out


def tooluse_stats(label):
    """Формат вызова инструментов и итоговая правильность — две РАЗНЫЕ вещи.
    У этой модели формат исторически безупречен, а финальная арифметика хромает,
    поэтому показываем обе метрики раздельно."""
    valid_num = valid_den = succ = tot = 0
    for suite in ("tooluse", "tooluse-calc", "tooluse-hard", "tooluse-long"):
        for r in load(f"results-quants-{suite}.json"):
            if r.get("model") != label:
                continue
            tot += 1
            if r.get("success"):
                succ += 1
            valid_num += r.get("validCalls") or 0
            valid_den += r.get("totalCalls") or 0
    return pct(valid_num, valid_den), pct(succ, tot)


def knowledge_scores(label):
    """Возвращает (facts, composite).

    Ось `facts` оценивается по заранее написанному ключу ответов и потому объективна —
    именно по ней корректно сравнивать кванты. Composite усредняет её с субъективными
    осями (`ideas`, `fermi`, `forecast`, `analysis`), у которых по ОДНОМУ прогону на ось;
    его разброс отражает в основном вариативность судьи, а не свойства кванта.
    """
    # judge-knowledge.mjs пишет ПЛОСКИЙ объект {label: {facts, ideas, fermi, forecast,
    # analysis, notes}} и поля `avg` НЕ сохраняет — среднее считаем сами по пяти осям.
    blob = load("scores-quants-knowledge.json")
    b = blob.get(label) if isinstance(blob, dict) else None
    if not b:
        return DASH, DASH
    axes = [b.get(k) for k in ("facts", "ideas", "fermi", "forecast", "analysis")]
    vals = [v for v in axes if isinstance(v, (int, float))]
    avg = f"{sum(vals) / len(vals):.2f}" if vals else DASH
    return f"{b.get('facts', DASH)}", avg


def build_rows():
    speed = load("results-quants-speed.json")
    rust = load("results-quants-rust.json")
    ts = load("results-quants-ts.json")
    niah = load("results-quants-longctx.json")
    multi = load("results-quants-multineedle.json")

    rows = [
        ["Кванты локальных MoE на контексте 256k — Qwen3-Coder-Next 80B и Qwen-AgentWorld 35B"],
        ["02.08.2026 · GPU-стенд (headless Arch, RTX 3090 24 ГБ, Ryzen 7 5800X3D, 64 ГБ DDR4-3600)"],
        ["Движок: llama.cpp из Unsloth Studio, сборка b10194 (форк unslothai). НЕ стоковая 6d5a910 —"],
        ["поэтому обе точки Q4 перемерены заново: цифры вкладки «Qwen3CoderNext offload 20.07»"],
        ["сняты другим движком и внутри этой таблицы несопоставимы."],
        ["Постоянные: ctx 262144, KV q8_0/q8_0, flash-attn on, threads 6, ubatch 2048, слот 1."],
        ["Единственная меняющаяся переменная — квант весов."],
        [],
    ]

    def section(title, header, make_row):
        rows.append([f"=== {title} ==="])
        for gname, pts in GROUPS:
            rows.append([f"— {gname} —"])
            rows.append(header)
            for p in pts:
                rows.append(make_row(*p))
        rows.append([])

    def mem_row(label, name, fam, size):
        n = read_mark(label, "ncmoe")
        vram = read_mark(label, "vram") or DASH
        on_gpu = DASH if n is None else ("весь на GPU" if int(n) == 0 else str(48 - int(n)))
        return [name, fam, f"{size}", n or DASH, vram, on_gpu]

    section("РАЗМЕЩЕНИЕ В ПАМЯТИ (ncmoe = сколько слоёв экспертов вытеснено на CPU из 48)",
            ["Квант", "Семейство", "Размер, ГБ", "ncmoe @256k", "VRAM, МиБ", "Экспертов на GPU"],
            mem_row)
    rows.append(["Чем ниже квант, тем меньше весов и тем меньше приходится выгружать на CPU. "
                 "Именно offload, а не сама разрядность, определяет скорость: рычаг двойной."])
    rows.append([])

    section("СКОРОСТЬ (снята с поля timings самого llama-server: в Studio-сборке llama-bench отсутствует)",
            ["Квант", "pp мелкий, t/s", "tg мелкий, t/s", "pp @250k, t/s", "tg @250k, t/s", "prefill 250k"],
            lambda label, name, _f, _s: [name, *speed_stats(speed, label)])

    def code_row(label, name, _f, _s):
        rs, ra, rc = codegen_stats(rust, label, "compiles")
        ts_s, ts_a, ts_c = codegen_stats(ts, label, "typechecks")
        return [name, rs, ra, rc, ts_s, ts_a, ts_c]

    section("КАЧЕСТВО КОДА (скрытые тесты; single = одношот, agentic = с инструментами)",
            ["Квант", "Rust single", "Rust agentic", "Rust собирается",
             "TS single", "TS agentic", "TS проходит tsc"],
            code_row)

    def know_row(label, name, _f, _s):
        vr, sr = tooluse_stats(label)
        facts, avg = knowledge_scores(label)
        return [name, facts, avg, vr, sr]

    section("ЗНАНИЯ И ИНСТРУМЕНТЫ (судья Opus 4.8)",
            ["Квант", "facts /10 (объективная ось)", "composite /10 (справочно)",
             "Формат tool-call, valid", "Tool-use, итог верен"],
            know_row)
    rows.append(["Сравнивать кванты корректно по facts: эта ось оценивается по заранее "
                 "написанному ключу. Composite включает субъективные оси с одним прогоном "
                 "на ось, и его разброс отражает вариативность судьи."])
    rows.append(["Систематическая ошибка, общая ДЛЯ ВСЕХ точек и обеих моделей: в Fermi-задаче "
                 "занижено энергопотребление B200 (~450 Вт вместо ~1 кВт) и опущен PUE. "
                 "Воспроизводится и на 1.7 бита, и на 4 битах — это свойство моделей, не кванта."])
    rows.append([])

    def niah_row(label, name, _f, _s):
        n = niah_stats(niah, label)
        mn = [r for r in multi if r.get("model") == label and r.get("ok")]
        mn_v = DASH if not mn else f"{100.0 * sum(r.get('recall') or 0 for r in mn) / len(mn):.0f}%"
        return [name, n[8], n[83], n[166], n[250], mn_v]

    section("ДЛИННЫЙ КОНТЕКСТ: доля найденных иголок (NIAH, глубины 10/50/90%)",
            ["Квант", "~8k", "~83k", "~166k", "~250k", "Multineedle recall @250k"],
            niah_row)

    rows.append(["=== СВЕРКА UD ПРОТИВ ПЛОСКОГО НА ОДНОЙ РАЗРЯДНОСТИ ==="])
    rows.append(["Пары кладутся рядом, чтобы отделить вклад разрядности от вклада методики Unsloth:"])
    rows.append(["UD строит собственную imatrix и раздаёт разную разрядность разным тензорам,"])
    rows.append(["плоский K-квант применяет фиксированный рецепт ко всей модели одинаково."])
    rows.append(["Пары есть только у Qwen3-Coder-Next (Q2 и Q3). На Q1 плоского варианта не существует "
                 "(однобитные кванты бывают только i-типа и всегда требуют imatrix), а у AgentWorld "
                 "плоских K-квантов нет во всём репозитории — только Q8_0 и BF16."])
    rows.append([])
    for a, b, lvl in [("qcn-ud-q2kxl", "qcn-q2k", "Q2"), ("qcn-ud-q3kxl", "qcn-q3km", "Q3"),
                      ("qcn-ud-q4km", "qcn-q4km", "Q4")]:
        da = next((r for r in speed if r.get("label") == a and r.get("depth") == "deep"), {})
        db = next((r for r in speed if r.get("label") == b and r.get("depth") == "deep"), {})
        rows.append([f"{lvl}: UD pp={da.get('ppTokPerSec', DASH)} tg={da.get('tgTokPerSec', DASH)}  "
                     f"|  плоский pp={db.get('ppTokPerSec', DASH)} tg={db.get('tgTokPerSec', DASH)}"])
    rows.append(["ЗАКОНОМЕРНОСТЬ: UD выигрывает предзаполнение, плоский — генерацию. Это два разных "
                 "узких места. Prefill считает токены пакетом и упирается в вычисления, поэтому решает, "
                 "сколько слоёв удалось оставить на GPU — компактный UD оставляет больше. Генерация "
                 "считает по одному токену, и на CPU-резидентных экспертах узкое место — распаковка "
                 "весов: i-кванты внутри UD-смеси требуют обращения к кодовой книге, плоские K-кванты "
                 "обходятся сдвигами и умножениями."])
    rows.append(["СЛЕДСТВИЕ ДЛЯ ВЫБОРА: при MoE-offload квант зависит от профиля нагрузки. Частое "
                 "перечитывание большого контекста (агентная работа) — UD. Длинные ответы при стабильном "
                 "контексте — плоский K-квант той же разрядности. Универсального «UD всегда лучше» нет."])
    rows.append([])
    rows.append(["=== ГЛАВНЫЕ ВЫВОДЫ ==="])
    rows.append(["1. Извлечение из длинного контекста НЕ страдает от квантования. NIAH 12/12 и "
                 "multineedle 100% на ВСЕХ точках от 1.7 бита до 4 бит, у обеих моделей. Поиск иголки — "
                 "задача маршрутизации внимания: она опирается на относительный порядок оценок, а не на "
                 "их точные значения, и потому устойчива к огрублению весов."])
    rows.append(["2. Деградация кода ПОРОГОВАЯ, а не плавная. Обе точки Q4 дают ~90% на Rust single, "
                 "всё ниже проваливается в полосу 22-67%, где кванты неразличимы даже при n=12. "
                 "Неверно «чем ниже квант, тем хуже код» — верно «Q4 это порог»: выше него Rust надёжен, "
                 "ниже — нет, независимо от того, Q3 это или однобитный вариант. Экономить память "
                 "осмысленно либо до Q4 включительно, либо сразу до самого агрессивного кванта, если код "
                 "не нужен; промежуточные ступени не покупают ничего, кроме места."])
    rows.append(["2a. TypeScript порога НЕ показывает (56-97%, без обрыва): его система типов прощает "
                 "неточность, а заимствования и времена жизни Rust — нет. Rust оказался заметно более "
                 "чувствительным датчиком деградации кванта, чем TypeScript."])
    rows.append(["2b. Агентный режим вытягивает Coder-Next (65-99% против 22-90% одношотом) — итерации "
                 "с запуском тестов компенсируют потерю знаний. У AgentWorld НАОБОРОТ: agentic (17/50/67) "
                 "ниже single (33/61/74) — рассуждающая модель на инструментах теряет, а не приобретает."])
    rows.append(["3. Формат вызова инструментов не ломается нигде: 100% valid на всех точках. "
                 "Структура вывода оказывается устойчивее содержания."])
    rows.append(["4. Понижение кванта работает как ДВОЙНОЙ рычаг скорости: меньше весов → меньше "
                 "вытеснено на CPU → быстрее. У AgentWorld на Q2 и Q3 offload исчезает совсем (ncmoe=0)."])
    rows.append(["5. Минимальный влезающий ncmoe — это край обрыва, а не рабочая точка. Колено шириной "
                 "в один слой; все точки садятся на 23.5-24.0 ГиБ из 24.1. Каждая конфигурация здесь "
                 "проверена реальным prefill на ~239k, а не только фактом загрузки."])
    rows.append([])
    rows.append(["ИСТОРИЧЕСКАЯ СПРАВКА (другой движок, НЕ для прямого сравнения):"])
    rows.append(["Q4_K_M на стоковой сборке 6d5a910, 20.07.2026: ncmoe=34, tg 27.8 t/s, pp 272 t/s @256k."])
    rows.append(["Та же точка на Studio b10194 сегодня: ncmoe=31, tg 29.7 t/s, pp 858 t/s. Prefill вырос "
                 "втрое при том же железе и той же модели — это вклад сборки движка, а не кванта."])
    return rows


def main():
    rows = build_rows()
    sheets = build("sheets", "v4", credentials=credentials())
    ss = sheets.spreadsheets()
    meta = ss.get(spreadsheetId=SID).execute()
    for sh in meta["sheets"]:
        if sh["properties"]["title"] == TAB:
            ss.batchUpdate(spreadsheetId=SID, body={"requests": [
                {"deleteSheet": {"sheetId": sh["properties"]["sheetId"]}}]}).execute()
            break
    ss.batchUpdate(spreadsheetId=SID, body={"requests": [
        {"addSheet": {"properties": {"title": TAB}}}]}).execute()
    ss.values().update(spreadsheetId=SID, range=f"'{TAB}'!A1",
                       valueInputOption="RAW", body={"values": rows}).execute()
    print(f"OK: вкладка '{TAB}' записана ({len(rows)} строк)")


if __name__ == "__main__":
    main()
