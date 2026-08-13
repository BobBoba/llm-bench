// ТЯЖЁЛЫЙ набор задач на Bash — укороченный (3 задачи, без edit-long): вопрос длинного
// контекста уже закрыт кампанией hard0804, а шелл-скрипты на 63k токонов нереалистичны.
// Типы те же: правка чужого кода / алгоритмическая глубина / параллелизм.
//
// ! Каждая задача обязана проходить свои скрытые тесты эталоном ДО кампании.
//
// Оракул: временный каталог, lib.sh (ответ модели) + hidden.sh (скрытые проверки),
// `bash hidden.sh` печатает `BENCH_RESULT passed=N total=M`. Каждая проверка — в субшелле
// со своим временным каталогом, чтобы провал одной не портил окружение остальных.

// ---------------------------------------------------------------------------
// 1. ПРАВКА ЧУЖОГО КОДА: ротация резервных копий.
// Дефект: цикл по $(ls -t ...) — расщепление по словам ломает имена с пробелами
// (классическая ошибка реальных скриптов). Место не названо.
// ---------------------------------------------------------------------------
const EDIT_STARTER = `#!/usr/bin/env bash
# Ротация резервных копий: оставляет keep самых свежих файлов *.bak в каталоге,
# более старые удаляет. Свежесть — по времени изменения (mtime).

rotate_backups() {
    local dir=$1
    local keep=$2
    local count=0
    for f in $(ls -t "$dir"/*.bak 2>/dev/null); do
        count=$((count + 1))
        if [ "$count" -gt "$keep" ]; then
            rm -f -- "$f"
        fi
    done
    return 0
}
`;

const EDIT_SPEC = `В файле lib.sh лежит РАБОЧАЯ функция rotate_backups — ротация резервных копий: оставляет
keep самых свежих файлов *.bak в каталоге (по mtime), более старые удаляет.

Требуется ДВА изменения:

1. НАЙТИ И ИСПРАВИТЬ ДЕФЕКТ. В функции есть одна ошибка, из-за которой на некоторых
   допустимых входных данных удаляются не те файлы либо не удаляется ничего. Место ошибки
   не указано — найдите сами. Существующее поведение на корректных входах менять нельзя.

2. ДОБАВИТЬ РЕЖИМ ПРОВЕРКИ: третий необязательный аргумент --dry-run.
       rotate_backups <dir> <keep> --dry-run
   В этом режиме функция НИЧЕГО не удаляет, а для каждого файла-кандидата на удаление
   печатает в stdout строку вида:
       DRY <полный путь к файлу>
   (по одной на файл, в том же порядке, в каком файлы удалялись бы). Без --dry-run
   поведение прежнее и ничего лишнего в stdout не печатается.

Требования:
- имена файлов могут содержать пробелы и другие безопасные для ФС символы — функция обязана
  обрабатывать их корректно;
- файлы, не оканчивающиеся на .bak, не затрагиваются никогда;
- keep больше либо равно числу файлов — не удаляется ничего;
- функция обязана работать под bash с set -u.

Верните ПОЛНОЕ содержимое lib.sh.`;

const EDIT_VISIBLE = `#!/usr/bin/env bash
source ./lib.sh
d=$(mktemp -d)
touch -d '3 hours ago' "$d/old.bak"
touch -d '1 hour ago' "$d/new.bak"
rotate_backups "$d" 1
[ ! -e "$d/old.bak" ] && [ -e "$d/new.bak" ] && echo OK
rm -rf "$d"
`;

const EDIT_HIDDEN = `#!/usr/bin/env bash
# Скрытые проверки rotate_backups. Каждая — в субшелле со своим каталогом.
set -u
# mktemp внутри проверок не должен сорить в общий /tmp: каталог оракула удаляется целиком,
# поэтому направляем все временные файлы в него (найдено по остаткам hr_conc_* [[04.08.2026]]).
export TMPDIR="$PWD/.tmp"
mkdir -p "$TMPDIR"
passed=0
total=0

check() {  # $1 = имя, $2 = функция-проверка (возвращает 0/1)
    total=$((total + 1))
    if ( "$2" ) >/dev/null 2>&1; then
        passed=$((passed + 1))
    else
        echo "FAIL $1" >&2
    fi
}

source ./lib.sh || { echo "BENCH_RESULT passed=0 total=8"; exit 0; }

t_keeps_newest() {
    local d; d=$(mktemp -d)
    touch -d '5 hours ago' "$d/a.bak"
    touch -d '3 hours ago' "$d/b.bak"
    touch -d '1 hour ago'  "$d/c.bak"
    rotate_backups "$d" 2
    [ ! -e "$d/a.bak" ] && [ -e "$d/b.bak" ] && [ -e "$d/c.bak" ]
}

t_spaces_in_names() {
    # ловит дефект: имя с пробелом не должно ни ломать цикл, ни удаляться будучи свежайшим
    local d; d=$(mktemp -d)
    touch -d '5 hours ago' "$d/old one.bak"
    touch -d '3 hours ago' "$d/mid file.bak"
    touch -d '1 hour ago'  "$d/new backup.bak"
    rotate_backups "$d" 1
    [ -e "$d/new backup.bak" ] && [ ! -e "$d/old one.bak" ] && [ ! -e "$d/mid file.bak" ]
}

t_keep_ge_count_deletes_nothing() {
    local d; d=$(mktemp -d)
    touch "$d/a.bak" "$d/b.bak"
    rotate_backups "$d" 5
    [ -e "$d/a.bak" ] && [ -e "$d/b.bak" ]
}

t_non_bak_untouched() {
    local d; d=$(mktemp -d)
    touch -d '5 hours ago' "$d/data.txt" "$d/a.bak"
    touch -d '1 hour ago' "$d/b.bak"
    rotate_backups "$d" 1
    [ -e "$d/data.txt" ] && [ ! -e "$d/a.bak" ] && [ -e "$d/b.bak" ]
}

t_dry_run_deletes_nothing() {
    local d; d=$(mktemp -d)
    touch -d '5 hours ago' "$d/a.bak"
    touch -d '1 hour ago'  "$d/b.bak"
    rotate_backups "$d" 1 --dry-run >/dev/null
    [ -e "$d/a.bak" ] && [ -e "$d/b.bak" ]
}

t_dry_run_lists_victims() {
    local d out; d=$(mktemp -d)
    touch -d '5 hours ago' "$d/a.bak"
    touch -d '3 hours ago' "$d/b.bak"
    touch -d '1 hour ago'  "$d/c.bak"
    out=$(rotate_backups "$d" 1 --dry-run)
    # жертвы: b (свежее) затем a (старше) — порядок как при удалении, от более свежего к старому
    # приемлем и обратный порядок листинга, важно: ровно две строки DRY, обе про a и b, ни одной про c
    [ "$(printf '%s\\n' "$out" | grep -c '^DRY ')" = 2 ] \\
        && printf '%s\\n' "$out" | grep -qF "DRY $d/a.bak" \\
        && printf '%s\\n' "$out" | grep -qF "DRY $d/b.bak" \\
        && ! printf '%s\\n' "$out" | grep -qF "$d/c.bak"
}

t_dry_run_spaces() {
    local d out; d=$(mktemp -d)
    touch -d '5 hours ago' "$d/old one.bak"
    touch -d '1 hour ago'  "$d/new backup.bak"
    out=$(rotate_backups "$d" 1 --dry-run)
    printf '%s\\n' "$out" | grep -qF "DRY $d/old one.bak" \\
        && ! printf '%s\\n' "$out" | grep -qF "new backup" \\
        && [ -e "$d/old one.bak" ]
}

t_no_stdout_without_dry() {
    local d out; d=$(mktemp -d)
    touch -d '5 hours ago' "$d/a.bak"
    touch -d '1 hour ago'  "$d/b.bak"
    out=$(rotate_backups "$d" 1)
    [ -z "$out" ] && [ ! -e "$d/a.bak" ]
}

check keeps_newest t_keeps_newest
check spaces_in_names t_spaces_in_names
check keep_ge_count t_keep_ge_count_deletes_nothing
check non_bak_untouched t_non_bak_untouched
check dry_run_deletes_nothing t_dry_run_deletes_nothing
check dry_run_lists_victims t_dry_run_lists_victims
check dry_run_spaces t_dry_run_spaces
check no_stdout_without_dry t_no_stdout_without_dry

echo "BENCH_RESULT passed=$passed total=$total"
`;

const EDIT_REFERENCE = `#!/usr/bin/env bash
# Ротация резервных копий: оставляет keep самых свежих файлов *.bak в каталоге,
# более старые удаляет. Свежесть — по времени изменения (mtime).

rotate_backups() {
    local dir=$1
    local keep=$2
    local dry=\${3:-}
    local count=0 line f
    # NUL-разделённый список, отсортированный по mtime (свежие первыми): имена с пробелами
    # и переводами строк не расщепляются.
    while IFS= read -r -d '' line; do
        f=\${line#* }
        count=$((count + 1))
        if [ "$count" -gt "$keep" ]; then
            if [ "$dry" = "--dry-run" ]; then
                printf 'DRY %s\\n' "$f"
            else
                rm -f -- "$f"
            fi
        fi
    done < <(find "$dir" -maxdepth 1 -name '*.bak' -printf '%T@ %p\\0' 2>/dev/null | sort -zrn)
    return 0
}
`;

// ---------------------------------------------------------------------------
// 2. АЛГОРИТМИЧЕСКАЯ ГЛУБИНА: сравнение версий semver.
// Полные правила приоритета §11 semver 2.0 (числовые и алфавитные идентификаторы
// prerelease) — именно там ломаются поспешные реализации на лексикографии.
// ---------------------------------------------------------------------------
const ALGO_SPEC = `Реализуйте в lib.sh функцию сравнения версий semver 2.0:

    semver_cmp <a> <b>

Функция печатает в stdout ровно одно из: -1 (a < b), 0 (a = b), 1 (a > b) и возвращает код 0.

Правила (semver 2.0, раздел «Precedence»):
- ядро MAJOR.MINOR.PATCH сравнивается почленно КАК ЧИСЛА (1.9.0 < 1.10.0);
- версия с prerelease МЕНЬШЕ той же версии без него (1.0.0-alpha < 1.0.0);
- prerelease сравнивается по идентификаторам через точку, слева направо:
  * числовой идентификатор сравнивается с числовым КАК ЧИСЛО (2 < 10);
  * алфавитно-цифровой с алфавитно-цифровым — лексикографически по ASCII;
  * числовой ВСЕГДА меньше алфавитно-цифрового (1 < alpha);
  * если общий префикс совпал, короче — меньше (alpha < alpha.1);
- метаданные сборки (+build...) при сравнении ИГНОРИРУЮТСЯ полностью.

Требования:
- только bash и стандартные утилиты; функция обязана работать под set -u;
- входные версии корректны (валидацию писать не нужно), могут содержать prerelease и/или
  метаданные сборки.

Верните ПОЛНОЕ содержимое lib.sh.`;

const ALGO_VISIBLE = `#!/usr/bin/env bash
source ./lib.sh
[ "$(semver_cmp 1.0.0 2.0.0)" = -1 ] && echo OK1
[ "$(semver_cmp 1.0.0-alpha 1.0.0)" = -1 ] && echo OK2
[ "$(semver_cmp 2.1.3 2.1.3)" = 0 ] && echo OK3
`;

const ALGO_HIDDEN = `#!/usr/bin/env bash
set -u
passed=0
total=0

expect() {  # $1 = a, $2 = b, $3 = ожидание
    total=$((total + 1))
    local got
    got=$(semver_cmp "$1" "$2" 2>/dev/null)
    if [ "$got" = "$3" ]; then
        passed=$((passed + 1))
    else
        echo "FAIL semver_cmp $1 $2 -> $got (ожидалось $3)" >&2
    fi
}

source ./lib.sh || { echo "BENCH_RESULT passed=0 total=14"; exit 0; }

expect 1.0.0 2.0.0 -1
expect 2.0.0 2.1.0 -1
expect 2.1.0 2.1.1 -1
expect 1.9.0 1.10.0 -1              # числовое сравнение ядра, не лексикографика
expect 1.10.0 1.9.0 1
expect 1.0.0-alpha 1.0.0 -1         # prerelease меньше релиза
expect 1.0.0 1.0.0-alpha 1
expect 1.0.0-alpha 1.0.0-alpha.1 -1 # короче — меньше при равном префиксе
expect 1.0.0-alpha.1 1.0.0-alpha.beta -1  # число меньше алфавитного
expect 1.0.0-alpha.beta 1.0.0-beta -1
expect 1.0.0-beta.2 1.0.0-beta.11 -1      # числовые идентификаторы как числа
expect 1.0.0-rc.1 1.0.0 -1
expect 1.2.3+build.7 1.2.3 0        # метаданные сборки игнорируются
expect 1.0.0-alpha+001 1.0.0-alpha+999 0

echo "BENCH_RESULT passed=$passed total=$total"
`;

const ALGO_REFERENCE = `#!/usr/bin/env bash
# Сравнение semver 2.0. Печатает -1 / 0 / 1.

semver_cmp() {
    local a=\${1%%+*} b=\${2%%+*}     # метаданные сборки отбрасываются
    local acore=\${a%%-*} bcore=\${b%%-*}
    local apre='' bpre=''
    [ "$a" != "$acore" ] && apre=\${a#*-}
    [ "$b" != "$bcore" ] && bpre=\${b#*-}

    # ядро: почленно как числа
    local IFS=.
    local -a A B
    read -r -a A <<< "$acore"
    read -r -a B <<< "$bcore"
    local i
    for i in 0 1 2; do
        if [ "\${A[i]}" -lt "\${B[i]}" ]; then echo -1; return 0; fi
        if [ "\${A[i]}" -gt "\${B[i]}" ]; then echo 1; return 0; fi
    done

    # prerelease: наличие против отсутствия
    if [ -n "$apre" ] && [ -z "$bpre" ]; then echo -1; return 0; fi
    if [ -z "$apre" ] && [ -n "$bpre" ]; then echo 1; return 0; fi
    if [ -z "$apre" ] && [ -z "$bpre" ]; then echo 0; return 0; fi

    # prerelease: по идентификаторам
    local -a PA PB
    read -r -a PA <<< "$apre"
    read -r -a PB <<< "$bpre"
    local n=\${#PA[@]}
    [ \${#PB[@]} -lt "$n" ] && n=\${#PB[@]}
    local x y
    for ((i = 0; i < n; i++)); do
        x=\${PA[i]} y=\${PB[i]}
        if [[ "$x" =~ ^[0-9]+$ ]] && [[ "$y" =~ ^[0-9]+$ ]]; then
            if ((10#$x < 10#$y)); then echo -1; return 0; fi
            if ((10#$x > 10#$y)); then echo 1; return 0; fi
        elif [[ "$x" =~ ^[0-9]+$ ]]; then
            echo -1; return 0        # число всегда меньше алфавитного
        elif [[ "$y" =~ ^[0-9]+$ ]]; then
            echo 1; return 0
        else
            if [[ "$x" < "$y" ]]; then echo -1; return 0; fi
            if [[ "$x" > "$y" ]]; then echo 1; return 0; fi
        fi
    done
    # общий префикс совпал: короче — меньше
    if [ \${#PA[@]} -lt \${#PB[@]} ]; then echo -1; return 0; fi
    if [ \${#PA[@]} -gt \${#PB[@]} ]; then echo 1; return 0; fi
    echo 0
    return 0
}
`;

// ---------------------------------------------------------------------------
// 3. ПАРАЛЛЕЛИЗМ: ограниченный параллельный исполнитель команд.
// Проверяется и корректность результатов, и ФАКТИЧЕСКОЕ соблюдение предела
// одновременности (через счётчик под flock), и реальная параллельность (по времени).
// ---------------------------------------------------------------------------
const CONC_SPEC = `Реализуйте в lib.sh ограниченный параллельный исполнитель команд:

    run_parallel <max> <outdir>

Функция читает команды из stdin (по одной на строку), исполняет каждую через bash -c,
одновременно работает НЕ БОЛЕЕ max команд. stdout каждой команды сохраняется в файл
<outdir>/out.<N>, где N — номер строки (с 1). Функция ждёт завершения ВСЕХ команд.

Возвращаемый код: 0, если все команды завершились успешно; 1, если хотя бы одна упала
(при этом остальные всё равно исполняются до конца, ничего не прерывается).

Требования:
- предел одновременности соблюдается строго в любой момент времени;
- команды реально исполняются параллельно (последовательное исполнение — провал);
- активное ожидание с коротким sleep в цикле допустимо, busy-loop без sleep — нет;
- только bash и стандартные утилиты;
- функция обязана работать под set -u.

Верните ПОЛНОЕ содержимое lib.sh.`;

const CONC_VISIBLE = `#!/usr/bin/env bash
source ./lib.sh
d=$(mktemp -d)
printf '%s\\n' 'echo one' 'echo two' | run_parallel 2 "$d"
[ "$(cat "$d/out.1")" = one ] && [ "$(cat "$d/out.2")" = two ] && echo OK
rm -rf "$d"
`;

const CONC_HIDDEN = `#!/usr/bin/env bash
set -u
# mktemp внутри проверок не должен сорить в общий /tmp: каталог оракула удаляется целиком,
# поэтому направляем все временные файлы в него (найдено по остаткам hr_conc_* [[04.08.2026]]).
export TMPDIR="$PWD/.tmp"
mkdir -p "$TMPDIR"
passed=0
total=0

check() {
    total=$((total + 1))
    if ( "$2" ) >/dev/null 2>&1; then
        passed=$((passed + 1))
    else
        echo "FAIL $1" >&2
    fi
}

source ./lib.sh || { echo "BENCH_RESULT passed=0 total=6"; exit 0; }

t_outputs_by_index() {
    local d; d=$(mktemp -d)
    printf '%s\\n' 'echo alpha' 'echo beta' 'echo gamma' | run_parallel 2 "$d"
    [ "$(cat "$d/out.1")" = alpha ] && [ "$(cat "$d/out.2")" = beta ] && [ "$(cat "$d/out.3")" = gamma ]
}

t_actually_parallel() {
    # 6 команд по 0.5 с при пределе 3: последовательно 3 с, параллельно ~1 с.
    # Порог 2.2 с отделяет одно от другого с запасом на нагрузку машины.
    local d t0 t1; d=$(mktemp -d)
    t0=$(date +%s%N)
    { for i in 1 2 3 4 5 6; do echo "sleep 0.5; echo $i"; done; } | run_parallel 3 "$d"
    t1=$(date +%s%N)
    [ $(( (t1 - t0) / 1000000 )) -lt 2200 ] && [ "$(cat "$d/out.6")" = 6 ]
}

t_limit_enforced() {
    # каждая команда поднимает счётчик под flock и записывает пик; пик обязан быть <= 2
    local d cnt peak; d=$(mktemp -d)
    cnt="$d/.cnt"; echo 0 > "$cnt"; echo 0 > "$d/.peak"
    local cmd='exec 9>>'"$d"'/.lock; flock 9; c=$(($(cat '"$cnt"') + 1)); echo $c > '"$cnt"'; p=$(cat '"$d"'/.peak); [ $c -gt $p ] && echo $c > '"$d"'/.peak; flock -u 9; sleep 0.4; exec 9>>'"$d"'/.lock; flock 9; c=$(($(cat '"$cnt"') - 1)); echo $c > '"$cnt"'; flock -u 9'
    { for i in 1 2 3 4 5; do echo "$cmd"; done; } | run_parallel 2 "$d"
    peak=$(cat "$d/.peak")
    [ "$peak" -le 2 ] && [ "$peak" -ge 2 ]
}

t_failure_reported_but_all_run() {
    local d rc; d=$(mktemp -d)
    printf '%s\\n' 'echo ok1' 'exit 3' 'echo ok3' | run_parallel 2 "$d"
    rc=$?
    [ "$rc" -ne 0 ] && [ "$(cat "$d/out.1")" = ok1 ] && [ "$(cat "$d/out.3")" = ok3 ]
}

t_success_rc_zero() {
    local d; d=$(mktemp -d)
    printf '%s\\n' 'true' 'echo x' | run_parallel 2 "$d"
    [ $? -eq 0 ]
}

t_single_slot_is_serial_but_correct() {
    local d; d=$(mktemp -d)
    printf '%s\\n' 'echo a' 'echo b' 'echo c' | run_parallel 1 "$d"
    [ "$(cat "$d/out.1")" = a ] && [ "$(cat "$d/out.2")" = b ] && [ "$(cat "$d/out.3")" = c ]
}

check outputs_by_index t_outputs_by_index
check actually_parallel t_actually_parallel
check limit_enforced t_limit_enforced
check failure_reported t_failure_reported_but_all_run
check success_rc_zero t_success_rc_zero
check single_slot t_single_slot_is_serial_but_correct

echo "BENCH_RESULT passed=$passed total=$total"
`;

const CONC_REFERENCE = `#!/usr/bin/env bash
# Ограниченный параллельный исполнитель: не более max команд одновременно,
# stdout каждой — в <outdir>/out.<N>.

run_parallel() {
    local max=$1
    local outdir=$2
    local idx=0 fail=0 line pid
    local -a pids=()
    while IFS= read -r line; do
        idx=$((idx + 1))
        # ждём свободный слот: считаем живые фоновые задачи
        while [ "$(jobs -rp | wc -l)" -ge "$max" ]; do
            sleep 0.05
        done
        bash -c "$line" > "$outdir/out.$idx" &
        pids+=($!)
    done
    for pid in "\${pids[@]:-}"; do
        [ -n "$pid" ] || continue
        wait "$pid" || fail=1
    done
    return "$fail"
}
`;

const TASKS = [
  { key: 'edit', kind: 'edit', lang: 'bash',
    spec: EDIT_SPEC, starter: EDIT_STARTER, visible: EDIT_VISIBLE,
    hidden: EDIT_HIDDEN, reference: EDIT_REFERENCE },
  { key: 'algo', kind: 'algo', lang: 'bash',
    spec: ALGO_SPEC, starter: '', visible: ALGO_VISIBLE,
    hidden: ALGO_HIDDEN, reference: ALGO_REFERENCE },
  { key: 'conc', kind: 'conc', lang: 'bash',
    spec: CONC_SPEC, starter: '', visible: CONC_VISIBLE,
    hidden: CONC_HIDDEN, reference: CONC_REFERENCE },
];

module.exports = { TASKS };
