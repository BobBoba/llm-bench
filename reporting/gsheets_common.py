"""Shared Google Sheets auth for the LLM-benchmark pusher.

The service-account JSON key is NOT stored on disk — it lives in the Secret Service
(KeePassXC) as the full JSON string. We fetch it via `secret-tool` at runtime and build
credentials from the parsed dict, so no plaintext key ever touches the filesystem.

Lookup attributes: service=google-sheets purpose=sa-key project=mcp-claude-484309
"""
import json
import os
import subprocess
from google.oauth2.service_account import Credentials

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]
OWNER_EMAIL = os.environ.get("BENCH_OWNER_EMAIL", "")   # шара таблицы обратно владельцу (задаётся окружением)


def load_key_dict():
    """Return the service-account key as a dict, straight from Secret Service."""
    out = subprocess.run(
        ["secret-tool", "lookup", "service", "google-sheets", "purpose", "sa-key"],
        capture_output=True, text=True, check=True,
    ).stdout
    if not out.strip():
        raise SystemExit("secret-tool вернул пусто — ключ не найден в secret-service")
    return json.loads(out)


def credentials():
    return Credentials.from_service_account_info(load_key_dict(), scopes=SCOPES)


# ---------------------------------------------------------------------------
# Условное форматирование: обновлять СВОИ правила, не трогая чужие.
#
# ! ИСТОРИЯ ДЕФЕКТА. Скрипты добавления моделей делали так:
#       for _ in range(len(sh.get("conditionalFormats", []))):
#           reqs.append({"deleteConditionalFormatRule": {"sheetId": sid, "index": 0}})
#       for col, vmax in GRAD[tab].items():
#           reqs.append(gradient_rule(...))
#   то есть сносили ВСЕ правила вкладки слепым циклом и воссоздавали только свои.
#   Любое правило, добавленное владельцем вручную, при этом уничтожалось — молча, без следа
#   в выводе. Дважды стёрло ручные цветовые шкалы на колонках `$/задача`, `$/задача (ag)` и
#   «время до решения» вкладки RUST; восстанавливать пришлось из ревизии Drive.
#   Тот же код был скопирован в семь скриптов, поэтому вынесен сюда общим помощником.
#
# ПРИЗНАК «СВОЕГО» ПРАВИЛА — палитра. Наши градиенты используют красно-жёлто-зелёную схему
# (0.97,0.41,0.42 → 1,0.92,0.52 → 0.39,0.75,0.48); правила, созданные через интерфейс Google,
# идут со стандартной палитрой (зелёный 0.34,0.73,0.54 → белый → красный 0.90,0.49,0.45).
# Сравнение по цвету минимальной точки надёжно их различает и не зависит от диапазона строк.
# ---------------------------------------------------------------------------

def _same_color(a, b, eps=0.02):
    return all(abs(a.get(k, 0) - b.get(k, 0)) <= eps for k in ("red", "green", "blue"))


# Палитры, которыми красят САМИ скрипты. Прямой градиент идёт от красного (чем больше — тем лучше),
# обратный — от зелёного (чем меньше — тем лучше, для колонок времени и цены).
OWN_RED = {"red": 0.97, "green": 0.41, "blue": 0.42}
OWN_GRN = {"red": 0.39, "green": 0.75, "blue": 0.48}

# Старый зелёный, которым красили до перевода на OWN_GRN: фактически стандартный
# Google-зелёный #57BB8A = (0.341, 0.733, 0.541). Он отличается от OWN_GRN на 0.06 при
# eps=0.02, поэтому без явного перечисления притворялся чужим: правила на его основе не
# обновлялись и не удалялись, и дубли в колонках времени и цены копились каждый запуск
# (наблюдалось на `центы/решённая`, `¢/час`, `Bash ¢` [[07.11.2026]]). Теперь это своя
# палитра: скрипт переносит такие правила на OWN_GRN и сносит лишние копии.
OWN_GRN_LEGACY = {"red": 0.341, "green": 0.733, "blue": 0.541}
OWN_MINPOINTS = [OWN_RED, OWN_GRN, OWN_GRN_LEGACY]

# ! Ручные правила, созданные через интерфейс Google, идут с диффом к #57BB8A→#E67C73.
#   Теперь этот зелёный считается своим (см. выше), а красный от нашего OWN_RED отличается
#   на 0.002 — то есть ручные градиенты Google неотличимы от скриптовых по определению.
#   Разделять их нечем, поэтому правило одно: градиентами на вкладке управляет скрипт.


def delete_own_rules(existing, sheet_id, own_minpoint_colors=None):
    """Запросы на удаление ТОЛЬКО своих градиентов вкладки. Чужие правила остаются.

    Замена слепому циклу `for _ in range(len(conditionalFormats)): delete(index=0)`, который
    сносил всё подряд, включая ручные правила владельца. Индексы идут по убыванию — иначе
    после первого удаления остальные съедут.
    """
    own = own_minpoint_colors or OWN_MINPOINTS
    idx = []
    for i, rule in enumerate(existing or []):
        g = rule.get("gradientRule")
        if not g:
            continue                     # булевы правила и прочее — не наши, не трогаем
        color = g.get("minpoint", {}).get("color", {})
        if any(_same_color(color, c) for c in own):
            idx.append(i)
    return [{"deleteConditionalFormatRule": {"sheetId": sheet_id, "index": i}}
            for i in sorted(idx, reverse=True)]


def sync_gradient_rules(existing, sheet_id, wanted, build_rule, own_minpoint_colors):
    """Запросы, приводящие СВОИ градиенты к нужному виду. Чужие правила не затрагиваются.

    existing            — список conditionalFormats вкладки, как его отдаёт spreadsheets.get
    wanted              — {индекс колонки: аргумент для build_rule}
    build_rule(col,arg) — возвращает готовое тело правила (dict с ranges/gradientRule)
    own_minpoint_colors — список цветов минимальной точки, по которым правило считается нашим

    Свои правила обновляются НА МЕСТЕ (`updateConditionalFormatRule`), недостающие добавляются,
    свои же на колонках, которых больше нет в `wanted`, удаляются — в порядке убывания индекса,
    иначе индексы поедут. Возвращает список запросов для batchUpdate.
    Правила на нескольких диапазонах: правило считается своим, если ВСЕ его диапазоны лежат
    в одной колонке `wanted`; путаница колонок оставляет правило нетронутым (чужое).
    """
    mine = {}                      # колонка -> [индексы правил, по возрастанию]
    foreign_span = set()           # индексы своих правил, но расходятся по колонкам
    for i, rule in enumerate(existing or []):
        g = rule.get("gradientRule")
        if not g:
            continue
        color = g.get("minpoint", {}).get("color", {})
        if not any(_same_color(color, c) for c in own_minpoint_colors):
            continue               # чужое правило — не трогаем ни при каких условиях
        cols = {(r.get("startColumnIndex"), r.get("endColumnIndex"))
                for r in (rule.get("ranges") or [{}])}
        if len(cols) > 1:
            foreign_span.add(i)
            continue
        col = next(iter(cols))[0]
        if col is not None:
            mine.setdefault(col, []).append(i)

    reqs = []
    for col, arg in wanted.items():
        rule = build_rule(col, arg)
        if col in mine:
            reqs.append({"updateConditionalFormatRule":
                         {"sheetId": sheet_id, "index": mine[col][0], "rule": rule}})
        else:
            reqs.append({"addConditionalFormatRule": {"index": len(existing or []), "rule": rule}})

    # Удаляем лишние СВОИ правила: дубли на колонках из `wanted` (оставляем первое, которое
    # только что обновили) и все правила колонок, которых в `wanted` больше нет. Раньше дубль
    # на живой колонке не попадал ни в одну из веток и копился при каждом запуске.
    # Правила с разными палитрами (OWN_RED и OWN_GRN) считаются своими оба, поэтому дубль
    # возможен и между ними — каждое лишнее правило колонки удаляется, а не только второе.
    drop = set(foreign_span)
    for col, idxs in mine.items():
        drop.update(idxs if col not in wanted else idxs[1:])
    for idx in sorted(drop, reverse=True):
        reqs.append({"deleteConditionalFormatRule": {"sheetId": sheet_id, "index": idx}})
    return reqs
