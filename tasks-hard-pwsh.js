// ТЯЖЁЛЫЙ набор задач на PowerShell (pwsh 7.4+) — укороченный, 3 задачи, без edit-long
// (симметрично bash-набору). Типы те же: правка чужого кода / алгоритм / параллелизм.
//
// ! Каждая задача обязана проходить свои скрытые тесты эталоном ДО кампании.
//
// Оракул: временный каталог, Lib.ps1 (ответ модели) + hidden.ps1, запуск
// `pwsh -NoProfile -File hidden.ps1`, печатает `BENCH_RESULT passed=N total=M`.
// Дот-сорсинг Lib.ps1 — в try/catch: синтаксическая ошибка ответа = load_fail, не крах обвязки.

const HARNESS_PRELUDE = `$ErrorActionPreference = 'Stop'
$checks = [System.Collections.Generic.List[object]]::new()
function Add-Check([string]$Name, [scriptblock]$Body) { $checks.Add(@{ Name = $Name; Body = $Body }) }

try { . "$PSScriptRoot/Lib.ps1" }
catch {
    Write-Error "load_fail: $_"
    exit 1
}
`;

const HARNESS_EPILOGUE = `
$passed = 0
foreach ($c in $checks) {
    $ok = $false
    try { $ok = [bool](& $c.Body) } catch { $ok = $false }
    if ($ok) { $passed++ } else { [Console]::Error.WriteLine("FAIL $($c.Name)") }
}
Write-Output "BENCH_RESULT passed=$passed total=$($checks.Count)"
`;

// ---------------------------------------------------------------------------
// 1. ПРАВКА ЧУЖОГО КОДА: сводка по журналу.
// Дефект: -split без предела — сообщение обрезается до первого слова, счётчики при этом
// остаются верными, поэтому дефект виден только на содержимом Errors.
// ---------------------------------------------------------------------------
const EDIT_STARTER = `# Сводка по строкам журнала вида: <ISO-время> <УРОВЕНЬ> <сообщение>
# Возвращает объект с Counts (хеш-таблица уровень -> число) и Errors (сообщения уровня ERROR
# в порядке появления).
function Get-LogStats {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Lines
    )
    $counts = @{}
    $errors = [System.Collections.Generic.List[string]]::new()
    foreach ($line in $Lines) {
        $parts = $line -split ' '
        if ($parts.Count -lt 3) { continue }
        $level = $parts[1].ToUpperInvariant()
        $message = $parts[2]
        if (-not $counts.ContainsKey($level)) { $counts[$level] = 0 }
        $counts[$level]++
        if ($level -eq 'ERROR') { $errors.Add($message) }
    }
    [pscustomobject]@{
        Counts = $counts
        Errors = $errors.ToArray()
    }
}
`;

const EDIT_SPEC = `В файле Lib.ps1 лежит РАБОЧАЯ функция Get-LogStats — сводка по строкам журнала формата
«<ISO-время> <УРОВЕНЬ> <сообщение>» (поля разделены одиночными пробелами, сообщение может
содержать пробелы). Возвращает объект с Counts (хеш-таблица уровень -> число) и Errors
(сообщения уровня ERROR в порядке появления).

Требуется ДВА изменения:

1. НАЙТИ И ИСПРАВИТЬ ДЕФЕКТ. В функции есть одна ошибка, из-за которой на некоторых
   допустимых строках журнала часть данных в результате оказывается искажённой. Место ошибки
   не указано — найдите сами. Счётчики Counts при этом дефекте остаются верными — смотрите
   внимательнее на остальное.

2. ДОБАВИТЬ ПАРАМЕТР -MinLevel:
       Get-LogStats -Lines $lines -MinLevel WARN
   Порядок серьёзности: DEBUG < INFO < WARN < ERROR. При заданном -MinLevel строки с уровнем
   ниже порога полностью игнорируются (не попадают ни в Counts, ни в Errors). Без параметра
   поведение прежнее — учитывается всё. Уровень в -MinLevel может быть в любом регистре.

Требования:
- строки, где меньше трёх полей, пропускаются (как сейчас);
- уровень в строке журнала может быть в любом регистре, в Counts он приводится к верхнему;
- публичное поведение (имя функции, форма результата) менять нельзя.

Верните ПОЛНОЕ содержимое Lib.ps1.`;

const EDIT_VISIBLE = `. ./Lib.ps1
$r = Get-LogStats -Lines @('2026-08-04T10:00:00Z INFO started', '2026-08-04T10:00:01Z ERROR disk full')
$r.Counts['INFO'] -eq 1    # True
$r.Counts['ERROR'] -eq 1   # True
`;

const EDIT_HIDDEN = HARNESS_PRELUDE + `
Add-Check 'r_counts_mixed_case_levels' {
    $r = Get-LogStats -Lines @(
        '2026-08-04T10:00:00Z info one',
        '2026-08-04T10:00:01Z INFO two',
        '2026-08-04T10:00:02Z Error boom'
    )
    $r.Counts['INFO'] -eq 2 -and $r.Counts['ERROR'] -eq 1
}
Add-Check 'r_invalid_lines_skipped' {
    $r = Get-LogStats -Lines @('garbage', '2026-08-04T10:00:00Z WARN low disk', 'x y')
    $r.Counts.Keys.Count -eq 1 -and $r.Counts['WARN'] -eq 1
}
Add-Check 'r_empty_input' {
    $r = Get-LogStats -Lines @()
    $r.Counts.Keys.Count -eq 0 -and @($r.Errors).Count -eq 0
}
Add-Check 'bug_full_message_preserved' {
    # ловит дефект: сообщение с пробелами обязано сохраняться целиком
    $r = Get-LogStats -Lines @('2026-08-04T10:00:00Z ERROR disk is completely full')
    @($r.Errors)[0] -eq 'disk is completely full'
}
Add-Check 'bug_errors_order_and_content' {
    $r = Get-LogStats -Lines @(
        '2026-08-04T10:00:00Z ERROR first failure here',
        '2026-08-04T10:00:01Z INFO fine',
        '2026-08-04T10:00:02Z error second one'
    )
    @($r.Errors).Count -eq 2 -and @($r.Errors)[0] -eq 'first failure here' -and @($r.Errors)[1] -eq 'second one'
}
Add-Check 'n_minlevel_filters_counts_and_errors' {
    $lines = @(
        '2026-08-04T10:00:00Z DEBUG noise',
        '2026-08-04T10:00:01Z INFO hello there',
        '2026-08-04T10:00:02Z WARN caution now',
        '2026-08-04T10:00:03Z ERROR kaboom happened'
    )
    $r = Get-LogStats -Lines $lines -MinLevel WARN
    $r.Counts.Keys.Count -eq 2 -and $r.Counts['WARN'] -eq 1 -and $r.Counts['ERROR'] -eq 1 -and @($r.Errors).Count -eq 1
}
Add-Check 'n_minlevel_case_insensitive' {
    $r = Get-LogStats -Lines @('2026-08-04T10:00:00Z INFO msg text') -MinLevel 'warn'
    $r.Counts.Keys.Count -eq 0
}
Add-Check 'n_minlevel_error_only' {
    $lines = @(
        '2026-08-04T10:00:00Z WARN w1 w2',
        '2026-08-04T10:00:01Z ERROR e1 e2'
    )
    $r = Get-LogStats -Lines $lines -MinLevel ERROR
    $r.Counts.Keys.Count -eq 1 -and @($r.Errors)[0] -eq 'e1 e2'
}
Add-Check 'n_without_minlevel_all_counted' {
    $r = Get-LogStats -Lines @('2026-08-04T10:00:00Z DEBUG deep trace info')
    $r.Counts['DEBUG'] -eq 1
}
` + HARNESS_EPILOGUE;

const EDIT_REFERENCE = `# Сводка по строкам журнала вида: <ISO-время> <УРОВЕНЬ> <сообщение>
function Get-LogStats {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Lines,
        [string]$MinLevel
    )
    $severity = @{ DEBUG = 0; INFO = 1; WARN = 2; ERROR = 3 }
    $threshold = -1
    if ($MinLevel) { $threshold = $severity[$MinLevel.ToUpperInvariant()] }
    $counts = @{}
    $errors = [System.Collections.Generic.List[string]]::new()
    foreach ($line in $Lines) {
        # предел 3: третье поле — ВСЁ сообщение целиком, включая пробелы
        $parts = $line -split ' ', 3
        if ($parts.Count -lt 3) { continue }
        $level = $parts[1].ToUpperInvariant()
        $message = $parts[2]
        if ($threshold -ge 0) {
            $sev = $severity[$level]
            if ($null -eq $sev -or $sev -lt $threshold) { continue }
        }
        if (-not $counts.ContainsKey($level)) { $counts[$level] = 0 }
        $counts[$level]++
        if ($level -eq 'ERROR') { $errors.Add($message) }
    }
    [pscustomobject]@{
        Counts = $counts
        Errors = $errors.ToArray()
    }
}
`;

// ---------------------------------------------------------------------------
// 2. АЛГОРИТМИЧЕСКАЯ ГЛУБИНА: диапазоны целых — разворачивание и каноническое сжатие.
// Ломкие места: смежность при сжатии, дубликаты, пустой вход, обратный диапазон.
// ---------------------------------------------------------------------------
const ALGO_SPEC = `Реализуйте в Lib.ps1 две функции для работы со спецификациями диапазонов
неотрицательных целых (формат «1-5,8,10-12»):

    Expand-RangeSpec -Spec <string>   # -> int[]
    Compress-IntList -Values <int[]>  # -> string

Expand-RangeSpec:
- разбирает элементы через запятую; элемент — либо одно число, либо диапазон a-b (включительно);
- пробелы вокруг элементов и дефиса допустимы («1 - 3, 7»);
- результат — отсортированный по возрастанию массив БЕЗ дубликатов (перекрытия и повторы
  во входе допустимы);
- пустая строка или строка из пробелов -> пустой массив;
- диапазон с a > b — ошибка: бросить исключение (throw).

Compress-IntList:
- принимает массив неотрицательных целых в любом порядке, возможно с дубликатами;
- возвращает каноническую спецификацию: подряд идущие числа сворачиваются в «a-b»,
  одиночные остаются числом, элементы разделены запятой БЕЗ пробелов, по возрастанию;
- ровно два подряд (например 4,5) тоже сворачиваются в «4-5»;
- пустой массив -> пустая строка.

Верните ПОЛНОЕ содержимое Lib.ps1.`;

const ALGO_VISIBLE = `. ./Lib.ps1
(Expand-RangeSpec -Spec '1-3,7') -join ',' # 1,2,3,7
Compress-IntList -Values @(3,1,2,8)        # 1-3,8
`;

const ALGO_HIDDEN = HARNESS_PRELUDE + `
Add-Check 'e_basic' {
    (Expand-RangeSpec -Spec '1-3,7') -join ',' -eq '1,2,3,7'
}
Add-Check 'e_overlap_and_dups' {
    (Expand-RangeSpec -Spec '3,1-4,2,4-6') -join ',' -eq '1,2,3,4,5,6'
}
Add-Check 'e_whitespace_tolerated' {
    (Expand-RangeSpec -Spec ' 1 - 3 , 7 ') -join ',' -eq '1,2,3,7'
}
Add-Check 'e_single_number' {
    $r = @(Expand-RangeSpec -Spec '42')
    $r.Count -eq 1 -and $r[0] -eq 42
}
Add-Check 'e_degenerate_range' {
    (Expand-RangeSpec -Spec '5-5') -join ',' -eq '5'
}
Add-Check 'e_empty_spec' {
    @(Expand-RangeSpec -Spec '  ').Count -eq 0
}
Add-Check 'e_reversed_range_throws' {
    try { Expand-RangeSpec -Spec '5-1' | Out-Null; $false } catch { $true }
}
Add-Check 'c_merges_adjacent' {
    (Compress-IntList -Values @(1,2,3,5,7,8,9)) -eq '1-3,5,7-9'
}
Add-Check 'c_two_in_a_row_merge' {
    (Compress-IntList -Values @(4,5,10)) -eq '4-5,10'
}
Add-Check 'c_unsorted_with_dups' {
    (Compress-IntList -Values @(9,1,3,2,9,2)) -eq '1-3,9'
}
Add-Check 'c_empty' {
    (Compress-IntList -Values @()) -eq ''
}
Add-Check 'roundtrip_canonical' {
    $spec = '0-2,4,6-8,11'
    (Compress-IntList -Values (Expand-RangeSpec -Spec $spec)) -eq $spec
}
` + HARNESS_EPILOGUE;

const ALGO_REFERENCE = `function Expand-RangeSpec {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Spec)
    $seen = [System.Collections.Generic.SortedSet[int]]::new()
    foreach ($raw in $Spec -split ',') {
        $item = $raw.Trim()
        if ($item -eq '') { continue }
        if ($item -match '^(\\d+)\\s*-\\s*(\\d+)$') {
            $a = [int]$Matches[1]; $b = [int]$Matches[2]
            if ($a -gt $b) { throw "обратный диапазон: $item" }
            for ($v = $a; $v -le $b; $v++) { [void]$seen.Add($v) }
        }
        elseif ($item -match '^\\d+$') {
            [void]$seen.Add([int]$item)
        }
        else { throw "неразборчивый элемент: $item" }
    }
    # запятая при развёртке массива в return не нужна: SortedSet уже упорядочен
    return @($seen)
}

function Compress-IntList {
    param([Parameter(Mandatory)][AllowEmptyCollection()][int[]]$Values)
    $sorted = @($Values | Sort-Object -Unique)
    if ($sorted.Count -eq 0) { return '' }
    $parts = [System.Collections.Generic.List[string]]::new()
    $start = $sorted[0]; $prev = $sorted[0]
    for ($i = 1; $i -le $sorted.Count; $i++) {
        $v = if ($i -lt $sorted.Count) { $sorted[$i] } else { $null }
        if ($null -ne $v -and $v -eq $prev + 1) { $prev = $v; continue }
        if ($start -eq $prev) { $parts.Add("$start") } else { $parts.Add("$start-$prev") }
        if ($null -ne $v) { $start = $v; $prev = $v }
    }
    return ($parts -join ',')
}
`;

// ---------------------------------------------------------------------------
// 3. ПАРАЛЛЕЛИЗМ: ограниченный исполнитель блоков с общим сроком.
// Проверяется порядок результатов, фактическая параллельность и работа дросселя —
// оба через время, чтобы не навязывать реализацию (ThreadJob / runspaces / -Parallel).
// ---------------------------------------------------------------------------
const CONC_SPEC = `Реализуйте в Lib.ps1 ограниченный параллельный исполнитель блоков:

    Invoke-Throttled -ScriptBlocks <scriptblock[]> -ThrottleLimit <int> [-TimeoutSec <double>]

Семантика:
- блоки исполняются ПАРАЛЛЕЛЬНО, но одновременно работает не более ThrottleLimit;
- возвращается массив результатов ТОЙ ЖЕ длины и В ТОМ ЖЕ ПОРЯДКЕ, что входные блоки;
  каждый элемент — объект со свойствами:
      Index   — номер блока (с 0),
      Ok      — $true/$false,
      Value   — результат блока при Ok=$true (иначе $null),
      Error   — текст ошибки при Ok=$false (иначе $null);
- блок, бросивший исключение, даёт Ok=$false и текст исключения в Error, остальные блоки
  при этом исполняются как ни в чём не бывало;
- -TimeoutSec (по умолчанию 30) — ОБЩИЙ срок на всю партию: блоки, не завершившиеся к сроку,
  принудительно останавливаются и получают Ok=$false, Error='timeout';
- функция обязана вернуться вскоре после истечения срока, а не ждать зависшие блоки.

Требования: pwsh 7.4, любые встроенные средства (ThreadJob, runspaces, ForEach-Object
-Parallel). Busy-wait без задержки недопустим.

Верните ПОЛНОЕ содержимое Lib.ps1.`;

const CONC_VISIBLE = `. ./Lib.ps1
$r = Invoke-Throttled -ScriptBlocks @({ 1 + 1 }, { 'two' }) -ThrottleLimit 2
$r[0].Value -eq 2      # True
$r[1].Value -eq 'two'  # True
`;

const CONC_HIDDEN = HARNESS_PRELUDE + `
Add-Check 'h_order_preserved' {
    $blocks = @(
        { Start-Sleep -Milliseconds 300; 'slow' },
        { 'fast' },
        { Start-Sleep -Milliseconds 100; 'mid' }
    )
    $r = Invoke-Throttled -ScriptBlocks $blocks -ThrottleLimit 3
    @($r).Count -eq 3 -and $r[0].Value -eq 'slow' -and $r[1].Value -eq 'fast' -and $r[2].Value -eq 'mid' -and $r[2].Index -eq 2
}
Add-Check 'h_actually_parallel' {
    # 6 блоков по 0.5 с при пределе 3: последовательно 3 с, параллельно ~1 с
    $blocks = @(1..6 | ForEach-Object { { Start-Sleep -Milliseconds 500; 'x' } })
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-Throttled -ScriptBlocks $blocks -ThrottleLimit 3
    $sw.Stop()
    $sw.Elapsed.TotalMilliseconds -lt 2400 -and @($r | Where-Object Ok).Count -eq 6
}
Add-Check 'h_throttle_enforced' {
    # при пределе 1 те же 4 блока обязаны идти последовательно: не быстрее ~2 с
    $blocks = @(1..4 | ForEach-Object { { Start-Sleep -Milliseconds 500; 'x' } })
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $null = Invoke-Throttled -ScriptBlocks $blocks -ThrottleLimit 1
    $sw.Stop()
    $sw.Elapsed.TotalMilliseconds -ge 1800
}
Add-Check 'h_error_captured_others_fine' {
    $blocks = @(
        { 'ok1' },
        { throw 'kaboom' },
        { 'ok3' }
    )
    $r = Invoke-Throttled -ScriptBlocks $blocks -ThrottleLimit 3
    $r[0].Ok -and -not $r[1].Ok -and $r[1].Error -match 'kaboom' -and $r[2].Ok -and $r[2].Value -eq 'ok3'
}
Add-Check 'h_timeout_marks_and_returns' {
    $blocks = @(
        { 'quick' },
        { Start-Sleep -Seconds 30; 'never' }
    )
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-Throttled -ScriptBlocks $blocks -ThrottleLimit 2 -TimeoutSec 2
    $sw.Stop()
    $sw.Elapsed.TotalSeconds -lt 8 -and $r[0].Ok -and $r[0].Value -eq 'quick' -and -not $r[1].Ok -and $r[1].Error -eq 'timeout'
}
Add-Check 'h_value_types_roundtrip' {
    $r = Invoke-Throttled -ScriptBlocks @({ 21 * 2 }) -ThrottleLimit 1
    $r[0].Value -eq 42 -and $r[0].Index -eq 0
}
` + HARNESS_EPILOGUE;

const CONC_REFERENCE = `function Invoke-Throttled {
    param(
        [Parameter(Mandatory)][scriptblock[]]$ScriptBlocks,
        [Parameter(Mandatory)][int]$ThrottleLimit,
        [double]$TimeoutSec = 30
    )
    $jobs = [System.Collections.Generic.List[object]]::new()
    for ($i = 0; $i -lt $ScriptBlocks.Count; $i++) {
        # Start-ThreadJob сам держит дроссель: лишние задания ждут в очереди
        $jobs.Add((Start-ThreadJob -ScriptBlock $ScriptBlocks[$i] -ThrottleLimit $ThrottleLimit))
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
    $results = New-Object object[] $ScriptBlocks.Count
    for ($i = 0; $i -lt $jobs.Count; $i++) {
        $remaining = ($deadline - [DateTime]::UtcNow).TotalSeconds
        if ($remaining -lt 0) { $remaining = 0 }
        $null = Wait-Job -Job $jobs[$i] -Timeout ([int][Math]::Ceiling($remaining))
        if ($jobs[$i].State -eq 'Completed') {
            $val = Receive-Job -Job $jobs[$i]
            $results[$i] = [pscustomobject]@{ Index = $i; Ok = $true; Value = $val; Error = $null }
        }
        elseif ($jobs[$i].State -eq 'Failed') {
            # У ThreadJob Reason.Message пуст — текст исключения отдаёт только Receive-Job
            # с -ErrorAction Stop через catch.
            $err = 'error'
            try { Receive-Job -Job $jobs[$i] -ErrorAction Stop | Out-Null } catch { $err = $_.Exception.Message }
            $results[$i] = [pscustomobject]@{ Index = $i; Ok = $false; Value = $null; Error = $err }
        }
        else {
            Stop-Job -Job $jobs[$i] -ErrorAction SilentlyContinue
            $results[$i] = [pscustomobject]@{ Index = $i; Ok = $false; Value = $null; Error = 'timeout' }
        }
        Remove-Job -Job $jobs[$i] -Force -ErrorAction SilentlyContinue
    }
    return ,$results
}
`;

const TASKS = [
  { key: 'edit', kind: 'edit', lang: 'pwsh',
    spec: EDIT_SPEC, starter: EDIT_STARTER, visible: EDIT_VISIBLE,
    hidden: EDIT_HIDDEN, reference: EDIT_REFERENCE },
  { key: 'algo', kind: 'algo', lang: 'pwsh',
    spec: ALGO_SPEC, starter: '', visible: ALGO_VISIBLE,
    hidden: ALGO_HIDDEN, reference: ALGO_REFERENCE },
  { key: 'conc', kind: 'conc', lang: 'pwsh',
    spec: CONC_SPEC, starter: '', visible: CONC_VISIBLE,
    hidden: CONC_HIDDEN, reference: CONC_REFERENCE },
];

module.exports = { TASKS };
