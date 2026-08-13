// ТЯЖЁЛЫЙ набор задач на Julia — те же три типа, что в Rust и TypeScript.
//
// ОРАКУЛ. Скрытые тесты — список замыканий, счёт под нашим контролем (см. run-hard.mjs).
// Причины отказа от `@testset`: в Julia 1.12 у `Test.get_test_counts` другие поля, а исключение
// внутри проверки срывало бы весь прогон вместо того, чтобы считаться провалом одной проверки.
// ! Весь счёт обязан идти ВНУТРИ функции: на верхнем уровне скрипта `for` создаёт новую локальную
//   переменную вместо изменения внешней (мягкая область видимости вне REPL), и счётчик молча
//   остаётся нулём — корректный код выглядел бы полным провалом.
//
// ПОТОКИ. Задача на параллелизм требует запуска `julia -t 4`; раннер передаёт это сам.

// ---------------------------------------------------------------------------
// 1. ПРАВКА ЧУЖОГО КОДА: система величин с множественной диспетчеризацией.
// Дефект: при сложении величин разных единиц перевод делается в единицы ПРАВОГО операнда, а
// возвращается тип ЛЕВОГО — из-за чего результат численно неверен. Место не названо.
// ---------------------------------------------------------------------------
const EDIT_STARTER = `module Units

export Quantity, Meters, Feet, Celsius, Fahrenheit, value, unitname, convert_to, combine

abstract type Unit end
struct Meters <: Unit end
struct Feet <: Unit end
struct Celsius <: Unit end
struct Fahrenheit <: Unit end

struct Quantity{U <: Unit}
    v::Float64
end

value(q::Quantity) = q.v
unitname(::Quantity{Meters}) = "m"
unitname(::Quantity{Feet}) = "ft"
unitname(::Quantity{Celsius}) = "C"
unitname(::Quantity{Fahrenheit}) = "F"

# Перевод между единицами одного рода.
convert_to(::Type{Meters}, q::Quantity{Meters}) = q
convert_to(::Type{Meters}, q::Quantity{Feet}) = Quantity{Meters}(q.v * 0.3048)
convert_to(::Type{Feet}, q::Quantity{Feet}) = q
convert_to(::Type{Feet}, q::Quantity{Meters}) = Quantity{Feet}(q.v / 0.3048)
convert_to(::Type{Celsius}, q::Quantity{Celsius}) = q
convert_to(::Type{Celsius}, q::Quantity{Fahrenheit}) = Quantity{Celsius}((q.v - 32) * 5 / 9)
convert_to(::Type{Fahrenheit}, q::Quantity{Fahrenheit}) = q
convert_to(::Type{Fahrenheit}, q::Quantity{Celsius}) = Quantity{Fahrenheit}(q.v * 9 / 5 + 32)

"Складывает две величины, возвращая результат в единицах ПЕРВОГО аргумента."
function combine(a::Quantity{U}, b::Quantity{V}) where {U <: Unit, V <: Unit}
    bb = convert_to(V, b)
    return Quantity{U}(a.v + bb.v)
end

end
`;

const EDIT_SPEC = `В файле lib.jl лежит РАБОЧИЙ модуль Units — величины с единицами измерения на множественной
диспетчеризации.

Требуется ДВА изменения:

1. НАЙТИ И ИСПРАВИТЬ ДЕФЕКТ. В модуле есть одна ошибка, из-за которой сложение величин РАЗНЫХ
   единиц даёт численно неверный результат. Сложение величин одинаковых единиц работает верно.
   Место не указано — найдите сами. Документированное поведение combine менять нельзя: результат
   обязан возвращаться в единицах ПЕРВОГО аргумента.

2. ДОБАВИТЬ ЕДИНИЦУ И ФУНКЦИЮ:
   - новый тип единицы Kelvin <: Unit с unitname == "K" и переводами в обе стороны с Celsius и
     Fahrenheit (0 C == 273.15 K);
   - функцию  total(qs::Vector{Quantity{U}}) where {U <: Unit}  — сумму однородных величин,
     возвращающую Quantity{U}; для пустого вектора Quantity{U}(0.0).

Существующий экспорт ломать нельзя, сигнатуры value, unitname, convert_to, combine обязаны
остаться прежними. Kelvin и total обязаны экспортироваться.
Верните ПОЛНОЕ содержимое lib.jl.`;

const EDIT_VISIBLE = `include("lib.jl")
using .Units
function run_checks()
    checks = Function[
        () -> value(combine(Quantity{Meters}(1.0), Quantity{Meters}(2.0))) ≈ 3.0,
        () -> unitname(Quantity{Feet}(1.0)) == "ft",
    ]
    passed = 0
    for f in checks
        try; f() === true && (passed += 1); catch; end
    end
    return passed, length(checks)
end
p, t = run_checks()
println("BENCH_RESULT passed=$p total=$t")
exit(p == t ? 0 : 1)
`;

const EDIT_HIDDEN = `include("lib.jl")
using .Units

function run_checks()
    checks = Function[
        # --- регрессии ---
        () -> value(combine(Quantity{Meters}(1.0), Quantity{Meters}(2.0))) ≈ 3.0,
        () -> value(convert_to(Meters, Quantity{Feet}(10.0))) ≈ 3.048,
        () -> value(convert_to(Fahrenheit, Quantity{Celsius}(100.0))) ≈ 212.0,
        () -> unitname(Quantity{Celsius}(0.0)) == "C",

        # --- дефект: перевод обязан идти в единицы ПЕРВОГО аргумента ---
        # 1 м + 1 фут = 1 + 0.3048 = 1.3048 м, а не 1 + 3.28... = 4.28
        () -> value(combine(Quantity{Meters}(1.0), Quantity{Feet}(1.0))) ≈ 1.3048,
        # 10 футов + 1 м = 10 + 3.28084 = 13.28084 фута
        () -> abs(value(combine(Quantity{Feet}(10.0), Quantity{Meters}(1.0))) - 13.280839895013123) < 1e-9,
        # 0 C + 32 F = 0 + 0 = 0 C
        () -> abs(value(combine(Quantity{Celsius}(0.0), Quantity{Fahrenheit}(32.0)))) < 1e-9,
        # тип результата — единицы первого аргумента
        () -> combine(Quantity{Meters}(1.0), Quantity{Feet}(1.0)) isa Quantity{Meters},
        () -> combine(Quantity{Feet}(1.0), Quantity{Meters}(1.0)) isa Quantity{Feet},

        # --- новая единица ---
        () -> unitname(Quantity{Kelvin}(0.0)) == "K",
        () -> abs(value(convert_to(Kelvin, Quantity{Celsius}(0.0))) - 273.15) < 1e-9,
        () -> abs(value(convert_to(Celsius, Quantity{Kelvin}(273.15)))) < 1e-9,
        () -> abs(value(convert_to(Kelvin, Quantity{Fahrenheit}(32.0))) - 273.15) < 1e-9,
        () -> abs(value(convert_to(Fahrenheit, Quantity{Kelvin}(273.15))) - 32.0) < 1e-9,
        () -> convert_to(Kelvin, Quantity{Kelvin}(1.0)) isa Quantity{Kelvin},
        # новая единица обязана работать и в combine
        () -> abs(value(combine(Quantity{Celsius}(10.0), Quantity{Kelvin}(283.15))) - 20.0) < 1e-9,

        # --- новая функция ---
        () -> value(total(Quantity{Meters}[Quantity{Meters}(1.0), Quantity{Meters}(2.5)])) ≈ 3.5,
        () -> total(Quantity{Feet}[]) isa Quantity{Feet},
        () -> value(total(Quantity{Feet}[])) == 0.0,
        () -> value(total(Quantity{Kelvin}[Quantity{Kelvin}(1.0)])) ≈ 1.0,
    ]
    passed = 0
    for f in checks
        try
            f() === true && (passed += 1)
        catch
        end
    end
    return passed, length(checks)
end

p, t = run_checks()
println("BENCH_RESULT passed=$p total=$t")
exit(p == t ? 0 : 1)
`;

const EDIT_REFERENCE = `module Units

export Quantity, Meters, Feet, Celsius, Fahrenheit, Kelvin, value, unitname, convert_to, combine, total

abstract type Unit end
struct Meters <: Unit end
struct Feet <: Unit end
struct Celsius <: Unit end
struct Fahrenheit <: Unit end
struct Kelvin <: Unit end

struct Quantity{U <: Unit}
    v::Float64
end

value(q::Quantity) = q.v
unitname(::Quantity{Meters}) = "m"
unitname(::Quantity{Feet}) = "ft"
unitname(::Quantity{Celsius}) = "C"
unitname(::Quantity{Fahrenheit}) = "F"
unitname(::Quantity{Kelvin}) = "K"

convert_to(::Type{Meters}, q::Quantity{Meters}) = q
convert_to(::Type{Meters}, q::Quantity{Feet}) = Quantity{Meters}(q.v * 0.3048)
convert_to(::Type{Feet}, q::Quantity{Feet}) = q
convert_to(::Type{Feet}, q::Quantity{Meters}) = Quantity{Feet}(q.v / 0.3048)
convert_to(::Type{Celsius}, q::Quantity{Celsius}) = q
convert_to(::Type{Celsius}, q::Quantity{Fahrenheit}) = Quantity{Celsius}((q.v - 32) * 5 / 9)
convert_to(::Type{Fahrenheit}, q::Quantity{Fahrenheit}) = q
convert_to(::Type{Fahrenheit}, q::Quantity{Celsius}) = Quantity{Fahrenheit}(q.v * 9 / 5 + 32)

convert_to(::Type{Kelvin}, q::Quantity{Kelvin}) = q
convert_to(::Type{Kelvin}, q::Quantity{Celsius}) = Quantity{Kelvin}(q.v + 273.15)
convert_to(::Type{Celsius}, q::Quantity{Kelvin}) = Quantity{Celsius}(q.v - 273.15)
convert_to(::Type{Kelvin}, q::Quantity{Fahrenheit}) = Quantity{Kelvin}((q.v - 32) * 5 / 9 + 273.15)
convert_to(::Type{Fahrenheit}, q::Quantity{Kelvin}) = Quantity{Fahrenheit}((q.v - 273.15) * 9 / 5 + 32)

"Складывает две величины, возвращая результат в единицах ПЕРВОГО аргумента."
function combine(a::Quantity{U}, b::Quantity{V}) where {U <: Unit, V <: Unit}
    bb = convert_to(U, b)
    return Quantity{U}(a.v + bb.v)
end

"Сумма однородных величин."
function total(qs::Vector{Quantity{U}}) where {U <: Unit}
    s = 0.0
    for q in qs
        s += q.v
    end
    return Quantity{U}(s)
end

end
`;

// ---------------------------------------------------------------------------
// 2. АЛГОРИТМИЧЕСКАЯ ГЛУБИНА: адаптивная квадратура с заданной точностью.
// ---------------------------------------------------------------------------
const ALGO_SPEC = `Реализуйте в lib.jl адаптивное численное интегрирование:

    module Quad
    export adaptive_integrate
    "Интеграл f на [a, b] с абсолютной погрешностью не хуже tol.
     Возвращает кортеж (значение, число вычислений f)."
    function adaptive_integrate(f, a::Float64, b::Float64; tol::Float64=1e-8, maxevals::Int=100000)
    end

Требования:
- метод обязан быть АДАПТИВНЫМ: дробить только те подотрезки, где оценка погрешности велика.
  Равномерная сетка с огромным числом точек не подходит — вторая координата возвращаемого
  кортежа (число вычислений f) проверяется, и на гладкой функции она обязана быть небольшой;
- точность: |результат − истина| <= tol для функций из тестов;
- функция обязана справляться с интегрируемой особенностью производной на краю (например
  sqrt(x) на [0,1]) и с резким пиком внутри отрезка;
- при достижении maxevals работа прекращается и возвращается лучшая текущая оценка (без ошибки);
- a может быть больше b: тогда результат меняет знак, как у обычного интеграла.

Верните ПОЛНОЕ содержимое lib.jl.`;

const ALGO_VISIBLE = `include("lib.jl")
using .Quad
function run_checks()
    checks = Function[
        () -> abs(adaptive_integrate(x -> x, 0.0, 1.0)[1] - 0.5) < 1e-8,
        () -> abs(adaptive_integrate(sin, 0.0, Float64(pi))[1] - 2.0) < 1e-8,
    ]
    passed = 0
    for f in checks
        try; f() === true && (passed += 1); catch; end
    end
    return passed, length(checks)
end
p, t = run_checks()
println("BENCH_RESULT passed=$p total=$t")
exit(p == t ? 0 : 1)
`;

const ALGO_HIDDEN = `include("lib.jl")
using .Quad

# ! Сложные проверки выносятся в ИМЕНОВАННЫЕ функции. Многострочная анонимная функция с блоком
#   begin/end внутри литерала массива не разбирается: в квадратных скобках перевод строки
#   работает как разделитель элементов, и парсер спотыкается на закрывающем end.
function chk_maxevals()
    v, n = adaptive_integrate(x -> sin(1 / (x + 1e-3)), 0.0, 1.0; tol=1e-14, maxevals=2000)
    return isfinite(v) && n <= 2200
end

function run_checks()
    checks = Function[
        # точность на гладких функциях
        () -> abs(adaptive_integrate(x -> x^2, 0.0, 3.0)[1] - 9.0) < 1e-8,
        () -> abs(adaptive_integrate(sin, 0.0, Float64(pi))[1] - 2.0) < 1e-8,
        () -> abs(adaptive_integrate(exp, 0.0, 1.0)[1] - (exp(1) - 1)) < 1e-8,
        () -> abs(adaptive_integrate(x -> 1 / (1 + x^2), 0.0, 1.0)[1] - pi / 4) < 1e-8,

        # адаптивность: на гладкой функции вычислений должно быть НЕМНОГО
        () -> adaptive_integrate(x -> x^2, 0.0, 3.0)[2] < 400,
        () -> adaptive_integrate(sin, 0.0, Float64(pi))[2] < 600,

        # особенность производной на краю
        () -> abs(adaptive_integrate(sqrt, 0.0, 1.0; tol=1e-6)[1] - 2 / 3) < 1e-6,

        # резкий пик внутри отрезка: равномерная грубая сетка его пропустит
        () -> abs(adaptive_integrate(x -> exp(-((x - 0.3)^2) / 2e-4), 0.0, 1.0; tol=1e-7)[1]
                  - 0.0250662827463) < 1e-6,

        # адаптивность на пике: вычислений должно быть заметно больше, чем на гладкой
        () -> adaptive_integrate(x -> exp(-((x - 0.3)^2) / 2e-4), 0.0, 1.0; tol=1e-7)[2] >
              adaptive_integrate(x -> x^2, 0.0, 3.0)[2],

        # знак при перевёрнутых пределах
        () -> abs(adaptive_integrate(x -> x, 1.0, 0.0)[1] + 0.5) < 1e-8,
        # вырожденный отрезок
        () -> abs(adaptive_integrate(x -> x, 2.0, 2.0)[1]) < 1e-12,
        # ограничение вычислений соблюдается и не приводит к ошибке
        chk_maxevals,
    ]
    passed = 0
    for f in checks
        try
            f() === true && (passed += 1)
        catch
        end
    end
    return passed, length(checks)
end

p, t = run_checks()
println("BENCH_RESULT passed=$p total=$t")
exit(p == t ? 0 : 1)
`;

const ALGO_REFERENCE = `module Quad

export adaptive_integrate

function simpson(f, a, b, fa, fm, fb)
    return (b - a) / 6 * (fa + 4 * fm + fb)
end

function adaptive_integrate(f, a::Float64, b::Float64; tol::Float64=1e-8, maxevals::Int=100000)
    if a == b
        return (0.0, 0)
    end
    sign = 1.0
    if a > b
        a, b = b, a
        sign = -1.0
    end
    evals = Ref(0)
    g = x -> (evals[] += 1; f(x))

    # ! Начальное равномерное дробление ОБЯЗАТЕЛЬНО. Без него узкий пик внутри отрезка
    #   не попадает ни в одну из трёх начальных точек, оценка погрешности выходит нулевой,
    #   и адаптация немедленно останавливается с ответом «интеграл почти ноль».
    nseg = 32

    function step(a, b, fa, fm, fb, whole, tol, depth)
        if evals[] >= maxevals || depth > 50
            return whole
        end
        m = (a + b) / 2
        lm = (a + m) / 2
        rm = (m + b) / 2
        flm = g(lm); frm = g(rm)
        left = simpson(f, a, m, fa, flm, fm)
        right = simpson(f, m, b, fm, frm, fb)
        if abs(left + right - whole) <= 15 * tol
            return left + right + (left + right - whole) / 15
        end
        return step(a, m, fa, flm, fm, left, tol / 2, depth + 1) +
               step(m, b, fm, frm, fb, right, tol / 2, depth + 1)
    end

    total = 0.0
    h = (b - a) / nseg
    for k in 0:(nseg - 1)
        sa = a + k * h
        sb = sa + h
        fsa = g(sa); fsb = g(sb); fsm = g((sa + sb) / 2)
        whole = simpson(f, sa, sb, fsa, fsm, fsb)
        total += step(sa, sb, fsa, fsm, fsb, whole, tol / nseg, 0)
    end
    return (sign * total, evals[])
end

end
`;

// ---------------------------------------------------------------------------
// 3. СОГЛАСОВАННОСТЬ: параллельная свёртка НЕкоммутативной операцией.
// Проверяется, что распараллеливание не переставляет порядок: наивное «сложить как получится»
// на матрицах даёт неверный результат.
// ---------------------------------------------------------------------------
const CONC_SPEC = `Реализуйте в lib.jl параллельную свёртку с сохранением порядка:

    module Par
    export parallel_foldl, chunk_ranges
    "Разбивает 1:n на nchunks непрерывных диапазонов (последний может быть короче)."
    function chunk_ranges(n::Int, nchunks::Int)
    "Свёртка слева операцией op по вектору xs с нейтральным элементом init.
     Обязана давать РОВНО тот же результат, что последовательная foldl(op, xs; init),
     включая НЕкоммутативные и неассоциативные по порядку операции."
    function parallel_foldl(op, xs::Vector{T}, init::T; nchunks::Int=Threads.nthreads()) where {T}

Требования:
- работа обязана распределяться по потокам через Threads.@spawn (не последовательный цикл);
- порядок обязан сохраняться: результат совпадает с foldl слева направо. Это значит, что
  частичные свёртки по кускам объединяются В ПОРЯДКЕ КУСКОВ, а не по мере готовности;
- операция может быть НЕкоммутативной (например умножение матриц или склейка строк);
- op обязана вызываться корректно и при пустом векторе (результат init) и при nchunks больше
  длины вектора;
- гонок быть не должно: повторные запуски дают одинаковый результат.

Верните ПОЛНОЕ содержимое lib.jl.`;

const CONC_VISIBLE = `include("lib.jl")
using .Par
function run_checks()
    checks = Function[
        () -> parallel_foldl(+, collect(1:10), 0) == 55,
        () -> parallel_foldl(*, [2, 3, 4], 1) == 24,
    ]
    passed = 0
    for f in checks
        try; f() === true && (passed += 1); catch; end
    end
    return passed, length(checks)
end
p, t = run_checks()
println("BENCH_RESULT passed=$p total=$t")
exit(p == t ? 0 : 1)
`;

const CONC_HIDDEN = `include("lib.jl")
using .Par

# ! Сложные проверки — именованными функциями: многострочная анонимная функция внутри литерала
#   массива в Julia не разбирается (перевод строки в скобках служит разделителем элементов).
function chk_ranges_10_3()
    r = chunk_ranges(10, 3)
    return length(r) <= 3 && sum(length.(r)) == 10 && first(r[1]) == 1 && last(r[end]) == 10
end

function chk_ranges_3_10()
    r = chunk_ranges(3, 10)
    return sum(length.(r)) == 3
end

function chk_repeatable(strs)
    a = [parallel_foldl(*, strs, "") for _ in 1:5]
    return all(x -> x == a[1], a)
end

function run_checks()
    mats = [Float64[1 i; 0 1] for i in 1:64]
    strs = [string(Char('a' + (i % 26))) for i in 1:200]

    checks = Function[
        # согласие с последовательной свёрткой на коммутативной операции
        () -> parallel_foldl(+, collect(1:1000), 0) == foldl(+, collect(1:1000); init=0),
        () -> parallel_foldl(*, collect(1:12), 1) == foldl(*, collect(1:12); init=1),

        # НЕкоммутативная операция: склейка строк
        () -> parallel_foldl(*, strs, "") == foldl(*, strs; init=""),
        () -> parallel_foldl(*, strs, ""; nchunks=7) == join(strs),

        # НЕкоммутативная операция: умножение матриц
        () -> parallel_foldl(*, mats, Float64[1 0; 0 1]) ≈ foldl(*, mats; init=Float64[1 0; 0 1]),
        () -> parallel_foldl(*, mats, Float64[1 0; 0 1]; nchunks=3) ≈
              foldl(*, mats; init=Float64[1 0; 0 1]),

        # краевые случаи
        () -> parallel_foldl(+, Int[], 0) == 0,
        () -> parallel_foldl(*, String[], "abc") == "abc",
        () -> parallel_foldl(+, [5], 0) == 5,
        () -> parallel_foldl(+, collect(1:3), 0; nchunks=100) == 6,

        # разбиение на диапазоны
        chk_ranges_10_3,
        chk_ranges_3_10,

        # повторяемость: гонок нет
        () -> chk_repeatable(strs),

        # потоки реально используются (иначе смысл задачи теряется)
        () -> Threads.nthreads() >= 2,
    ]
    passed = 0
    for f in checks
        try
            f() === true && (passed += 1)
        catch
        end
    end
    return passed, length(checks)
end

p, t = run_checks()
println("BENCH_RESULT passed=$p total=$t")
exit(p == t ? 0 : 1)
`;

const CONC_REFERENCE = `module Par

export parallel_foldl, chunk_ranges

function chunk_ranges(n::Int, nchunks::Int)
    n <= 0 && return UnitRange{Int}[]
    k = max(1, min(nchunks, n))
    per = cld(n, k)
    out = UnitRange{Int}[]
    i = 1
    while i <= n
        j = min(n, i + per - 1)
        push!(out, i:j)
        i = j + 1
    end
    return out
end

function parallel_foldl(op, xs::Vector{T}, init::T; nchunks::Int=Threads.nthreads()) where {T}
    n = length(xs)
    n == 0 && return init
    ranges = chunk_ranges(n, nchunks)
    parts = Vector{Any}(undef, length(ranges))
    tasks = map(enumerate(ranges)) do (i, r)
        Threads.@spawn begin
            acc = xs[first(r)]
            for k in (first(r) + 1):last(r)
                acc = op(acc, xs[k])
            end
            parts[i] = acc
        end
    end
    foreach(wait, tasks)
    acc = init
    for i in 1:length(ranges)          # объединяем строго в порядке кусков
        acc = op(acc, parts[i])
    end
    return acc
end

end
`;

const TASKS = [
  { key: 'edit', kind: 'edit', lang: 'julia', threads: 1,
    spec: EDIT_SPEC, starter: EDIT_STARTER, visible: EDIT_VISIBLE,
    hidden: EDIT_HIDDEN, reference: EDIT_REFERENCE },
  { key: 'algo', kind: 'algo', lang: 'julia', threads: 1,
    spec: ALGO_SPEC, starter: '', visible: ALGO_VISIBLE,
    hidden: ALGO_HIDDEN, reference: ALGO_REFERENCE },
  { key: 'conc', kind: 'conc', lang: 'julia', threads: 4,
    spec: CONC_SPEC, starter: '', visible: CONC_VISIBLE,
    hidden: CONC_HIDDEN, reference: CONC_REFERENCE },
];

module.exports = { TASKS };
