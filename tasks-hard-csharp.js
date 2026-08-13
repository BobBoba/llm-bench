// ТЯЖЁЛЫЙ набор задач на C# — порт Rust-набора (tasks-hard-rust.js) на идентичной семантике:
// тот же TtlCache с тем же дефектом, та же RollingMedian, тот же ограниченный канал.
// Это ОСОЗНАННО: пара Rust ↔ C# на одинаковых задачах изолирует эффект языка — расхождение
// баллов между парами читается как «модель знает язык хуже», а не «задача другая».
//
// ! Каждая задача обязана проходить свои скрытые тесты эталоном ДО кампании
//   (`node run-hard.mjs --selftest`).
//
// Оракул: временный проект net10.0 из трёх файлов (proj.csproj + Lib.cs от модели +
// Program.cs со скрытыми проверками), `dotnet run` печатает `BENCH_RESULT passed=N total=M`.
// Никаких NuGet-зависимостей — restore офлайновый. Замерено: холодный прогон ~11 с.

const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
`;

// Общая шапка скрытых проверок: список именованных проверок, каждая в try/catch,
// параллельные — под собственным сроком (иначе взаимная блокировка повесила бы весь прогон).
const HARNESS_PRELUDE = `static bool WithDeadline(int ms, Action f)
{
    var t = Task.Run(f);
    try { return t.Wait(ms); } catch { return false; }
}

var checks = new List<(string, Func<bool>)>();
`;

const HARNESS_EPILOGUE = `
int passed = 0;
foreach (var (name, f) in checks)
{
    bool ok = false;
    try { ok = f(); } catch { ok = false; }
    if (ok) passed++;
    else Console.Error.WriteLine($"FAIL {name}");
}
Console.WriteLine($"BENCH_RESULT passed={passed} total={checks.Count}");
`;

// ---------------------------------------------------------------------------
// 1. ПРАВКА ЧУЖОГО КОДА: кэш с вытеснением и сроком жизни.
// Дефект тот же, что в Rust-наборе: Put существующего ключа не обновляет позицию
// в порядке использования, из-за чего вытесняется не тот элемент.
// ---------------------------------------------------------------------------
const EDIT_STARTER = `/// <summary>
/// Кэш с вытеснением наименее недавно использованного и сроком жизни записи.
/// Время подаётся снаружи (в тиках), чтобы поведение было детерминированным.
/// </summary>
public sealed class TtlCache
{
    private readonly int _cap;
    private readonly ulong _ttl;
    private readonly Dictionary<string, (long Val, ulong Stamp)> _map = new();
    private readonly List<string> _order = new(); // от самого давнего к самому свежему

    public TtlCache(int cap, ulong ttl)
    {
        _cap = cap;
        _ttl = ttl;
    }

    public int Count => _map.Count;

    private void Touch(string key)
    {
        int pos = _order.IndexOf(key);
        if (pos >= 0)
        {
            _order.RemoveAt(pos);
            _order.Add(key);
        }
    }

    private void Expire(ulong now)
    {
        var dead = new List<string>();
        foreach (var (k, v) in _map)
            if (now >= v.Stamp && now - v.Stamp >= _ttl)
                dead.Add(k);
        foreach (var k in dead)
        {
            _map.Remove(k);
            _order.Remove(k);
        }
    }

    public long? Get(string key, ulong now)
    {
        Expire(now);
        if (_map.TryGetValue(key, out var v))
        {
            Touch(key);
            return v.Val;
        }
        return null;
    }

    public void Put(string key, long val, ulong now)
    {
        Expire(now);
        if (_map.ContainsKey(key))
        {
            _map[key] = (val, now);
            return;
        }
        if (_map.Count >= _cap && _order.Count > 0)
        {
            var victim = _order[0];
            _order.RemoveAt(0);
            _map.Remove(victim);
        }
        _map[key] = (val, now);
        _order.Add(key);
    }
}
`;

const EDIT_SPEC = `В файле Lib.cs лежит РАБОЧИЙ класс TtlCache — кэш с вытеснением наименее недавно
использованного элемента и сроком жизни записи. Время подаётся параметром now (тики).

Требуется ДВА изменения:

1. НАЙТИ И ИСПРАВИТЬ ДЕФЕКТ. В классе есть одна ошибка, из-за которой при переполнении иногда
   вытесняется не тот элемент. Место ошибки не указано — найдите сами. Существующее публичное
   поведение (конструктор/Count/Get/Put и семантика ttl) менять нельзя, кроме исправления самой
   ошибки.

2. ДОБАВИТЬ МЕТОД:
       public long GetOrInsertWith(string key, ulong now, Func<long> f)
   Возвращает живое значение по ключу, если оно есть; иначе вычисляет f(), кладёт по этому ключу
   и возвращает. Метод обязан подчиняться тем же правилам, что Get и Put: истёкшие записи
   удаляются, обращение обновляет позицию в порядке использования, при переполнении вытесняется
   наименее недавно использованный. f() вызывается РОВНО ОДИН раз и только когда значения нет.

Публичный API ломать нельзя: сигнатуры конструктора, Count, Get, Put обязаны остаться прежними.
Класс объявляйте на верхнем уровне файла, БЕЗ namespace (тестовая обвязка обращается к нему
по короткому имени TtlCache). Верните ПОЛНОЕ содержимое Lib.cs.`;

const EDIT_VISIBLE = `var c = new TtlCache(2, 10);
c.Put("a", 1, 0);
Console.WriteLine(c.Get("a", 1) == 1);   // true
Console.WriteLine(c.Get("zz", 1) == null); // true
var c2 = new TtlCache(2, 5);
c2.Put("a", 1, 0);
Console.WriteLine(c2.Get("a", 5) == null); // true — запись живёт строго меньше ttl тиков
`;

const EDIT_HIDDEN = HARNESS_PRELUDE + `
// --- регрессии на существующее поведение ---
checks.Add(("r_len_and_capacity", () => {
    var c = new TtlCache(2, 100);
    c.Put("a", 1, 0); c.Put("b", 2, 0); c.Put("c", 3, 0);
    return c.Count == 2;
}));
checks.Add(("r_ttl_boundary_is_inclusive", () => {
    var c = new TtlCache(4, 5);
    c.Put("a", 1, 0);
    return c.Get("a", 4) == 1 && c.Get("a", 5) == null;
}));
checks.Add(("r_get_refreshes_recency", () => {
    var c = new TtlCache(2, 100);
    c.Put("a", 1, 0); c.Put("b", 2, 0);
    if (c.Get("a", 1) != 1) return false;   // теперь свежайший — a
    c.Put("c", 3, 1);                        // вытесниться обязан b
    return c.Get("b", 2) == null && c.Get("a", 2) == 1;
}));

// --- собственно дефект: повторный Put обязан обновлять позицию ---
checks.Add(("bug_put_existing_refreshes_recency", () => {
    var c = new TtlCache(2, 100);
    c.Put("a", 1, 0); c.Put("b", 2, 0);
    c.Put("a", 10, 1); // a становится свежайшим
    c.Put("c", 3, 2);  // вытесниться обязан b, а не a
    return c.Get("a", 3) == 10 && c.Get("b", 3) == null && c.Get("c", 3) == 3;
}));
checks.Add(("bug_put_existing_updates_value_and_stamp", () => {
    var c = new TtlCache(2, 5);
    c.Put("a", 1, 0);
    c.Put("a", 2, 4);                        // отметка времени обновляется
    return c.Get("a", 8) == 2 && c.Get("a", 9) == null;
}));

// --- новый метод ---
checks.Add(("n_inserts_when_absent", () => {
    var c = new TtlCache(2, 100);
    long v = c.GetOrInsertWith("a", 0, () => 42);
    return v == 42 && c.Get("a", 0) == 42;
}));
checks.Add(("n_returns_existing_without_calling_f", () => {
    var c = new TtlCache(2, 100);
    c.Put("a", 7, 0);
    int called = 0;
    long v = c.GetOrInsertWith("a", 1, () => { called++; return 99; });
    return v == 7 && called == 0;
}));
checks.Add(("n_recomputes_after_expiry", () => {
    var c = new TtlCache(2, 5);
    c.Put("a", 7, 0);
    long v = c.GetOrInsertWith("a", 5, () => 99); // истекла — считаем заново
    return v == 99 && c.Get("a", 5) == 99;
}));
checks.Add(("n_evicts_least_recent_and_refreshes", () => {
    var c = new TtlCache(2, 100);
    c.Put("a", 1, 0); c.Put("b", 2, 0);
    _ = c.GetOrInsertWith("a", 1, () => 0);  // a свежайший, f не вызывается
    _ = c.GetOrInsertWith("c", 2, () => 3);  // вытесниться обязан b
    return c.Get("b", 3) == null && c.Get("a", 3) == 1 && c.Get("c", 3) == 3 && c.Count == 2;
}));
checks.Add(("n_respects_capacity_one", () => {
    var c = new TtlCache(1, 100);
    _ = c.GetOrInsertWith("a", 0, () => 1);
    _ = c.GetOrInsertWith("b", 0, () => 2);
    return c.Count == 1 && c.Get("a", 0) == null && c.Get("b", 0) == 2;
}));
` + HARNESS_EPILOGUE;

// Эталон: исправлен Put (повторная запись обновляет позицию) + добавлен новый метод.
const EDIT_REFERENCE = EDIT_STARTER
  .replace(
    `        if (_map.ContainsKey(key))
        {
            _map[key] = (val, now);
            return;
        }`,
    `        if (_map.ContainsKey(key))
        {
            _map[key] = (val, now);
            Touch(key);
            return;
        }`)
  .replace(
    `        _map[key] = (val, now);
        _order.Add(key);
    }
}`,
    `        _map[key] = (val, now);
        _order.Add(key);
    }

    public long GetOrInsertWith(string key, ulong now, Func<long> f)
    {
        var existing = Get(key, now);
        if (existing.HasValue) return existing.Value;
        long v = f();
        Put(key, v, now);
        return v;
    }
}`);

// ---------------------------------------------------------------------------
// 2. АЛГОРИТМИЧЕСКАЯ ГЛУБИНА: медиана скользящего окна (порт Rust-задачи).
// ---------------------------------------------------------------------------
const ALGO_SPEC = `Реализуйте в Lib.cs класс для медианы скользящего окна:

    public sealed class RollingMedian
    {
        public RollingMedian(int window);   // window >= 1
        // Добавляет значение. Если в окне уже window элементов, самое старое выбывает.
        public void Push(long x);
        // Медиана текущего окна. null, пока не добавлено ни одного значения.
        // Для чётного числа элементов — СРЕДНЕЕ двух центральных (double).
        public double? Median();
        // Сколько значений сейчас в окне.
        public int Count { get; }
    }

Требования:
- окно ведёт себя как очередь: выбывает всегда самое старое по времени добавления, а не
  наименьшее по значению;
- дубликаты допустимы и должны учитываться каждый по отдельности;
- значения могут быть любыми long, включая отрицательные и повторяющиеся;
- медиана чётного окна — среднее арифметическое двух центральных значений (в double).

Класс объявляйте на верхнем уровне файла, БЕЗ namespace. Верните ПОЛНОЕ содержимое Lib.cs.`;

const ALGO_VISIBLE = `var m = new RollingMedian(3);
Console.WriteLine(m.Median() == null); // true
m.Push(1);
Console.WriteLine(m.Median() == 1.0);  // true
m.Push(3);
Console.WriteLine(m.Median() == 2.0);  // true — среднее 1 и 3
`;

const ALGO_HIDDEN = HARNESS_PRELUDE + `
static bool Approx(double? a, double b) => a.HasValue && Math.Abs(a.Value - b) < 1e-9;

checks.Add(("h_window_slides_by_age_not_value", () => {
    var m = new RollingMedian(3);
    foreach (long v in new long[] { 10, 1, 2 }) m.Push(v);
    if (!Approx(m.Median(), 2.0)) return false;   // {10,1,2}
    m.Push(3);                                     // выбывает 10, а не 1
    if (!Approx(m.Median(), 2.0)) return false;   // {1,2,3}
    m.Push(100);
    return Approx(m.Median(), 3.0);               // {2,3,100}
}));
checks.Add(("h_even_window_averages_two_middles", () => {
    var m = new RollingMedian(4);
    foreach (long v in new long[] { 1, 2, 3, 4 }) m.Push(v);
    if (!Approx(m.Median(), 2.5)) return false;
    m.Push(5);
    return Approx(m.Median(), 3.5);               // {2,3,4,5}
}));
checks.Add(("h_duplicates_counted_separately", () => {
    var m = new RollingMedian(5);
    foreach (long v in new long[] { 7, 7, 7, 1, 9 }) m.Push(v);
    if (!Approx(m.Median(), 7.0)) return false;
    m.Push(7);                                     // выбывает первая семёрка
    if (!Approx(m.Median(), 7.0)) return false;   // {7,7,1,9,7}
    for (int i = 0; i < 5; i++) m.Push(0);
    return Approx(m.Median(), 0.0);
}));
checks.Add(("h_negative_and_extremes", () => {
    var m = new RollingMedian(3);
    m.Push(long.MinValue); m.Push(0); m.Push(long.MaxValue);
    if (!Approx(m.Median(), 0.0)) return false;
    m.Push(-5);
    return Approx(m.Median(), 0.0);               // {0, long.MaxValue, -5}
}));
checks.Add(("h_window_one", () => {
    var m = new RollingMedian(1);
    m.Push(5);
    if (!Approx(m.Median(), 5.0)) return false;
    m.Push(-3);
    return Approx(m.Median(), -3.0) && m.Count == 1;
}));
checks.Add(("h_partial_window_before_full", () => {
    var m = new RollingMedian(5);
    m.Push(4);
    if (!Approx(m.Median(), 4.0)) return false;
    m.Push(2);
    if (!Approx(m.Median(), 3.0)) return false;   // среднее 2 и 4
    m.Push(6);
    return Approx(m.Median(), 4.0) && m.Count == 3;
}));
checks.Add(("h_long_adversarial_sequence", () => {
    // пилообразная последовательность с повторами: ловит реализации,
    // которые «забывают» удалять выбывший элемент из вспомогательной структуры
    var m = new RollingMedian(7);
    var naive = new Queue<long>();
    for (long i = 0; i < 200; i++)
    {
        long v = i % 3 == 0 ? i % 11 : -(i % 7);
        m.Push(v);
        naive.Enqueue(v);
        if (naive.Count > 7) naive.Dequeue();
        var s = naive.ToList();
        s.Sort();
        int n = s.Count;
        double expect = n % 2 == 1 ? s[n / 2]
                        : (s[n / 2 - 1] + (double)s[n / 2]) / 2.0;
        if (!Approx(m.Median(), expect)) return false;
    }
    return true;
}));
` + HARNESS_EPILOGUE;

const ALGO_REFERENCE = `public sealed class RollingMedian
{
    private readonly int _window;
    private readonly Queue<long> _order = new();
    private readonly List<long> _sorted = new();

    public RollingMedian(int window)
    {
        _window = Math.Max(1, window);
    }

    public void Push(long x)
    {
        if (_order.Count == _window)
        {
            long old = _order.Dequeue();
            int pos = _sorted.BinarySearch(old);
            if (pos >= 0) _sorted.RemoveAt(pos);
        }
        _order.Enqueue(x);
        int ins = _sorted.BinarySearch(x);
        if (ins < 0) ins = ~ins;
        _sorted.Insert(ins, x);
    }

    public double? Median()
    {
        int n = _sorted.Count;
        if (n == 0) return null;
        return n % 2 == 1
            ? _sorted[n / 2]
            : (_sorted[n / 2 - 1] + (double)_sorted[n / 2]) / 2.0;
    }

    public int Count => _order.Count;
}
`;

// ---------------------------------------------------------------------------
// 3. СОГЛАСОВАННОСТЬ ПОД ПАРАЛЛЕЛИЗМОМ: ограниченный канал (порт Rust-задачи).
// Запрещён System.Threading.Channels — синхронизацию писать самому на Monitor.
// ---------------------------------------------------------------------------
const CONC_SPEC = `Реализуйте в Lib.cs ограниченный канал с обратным давлением, только на базовых примитивах
синхронизации (lock/Monitor). Запрещены System.Threading.Channels, BlockingCollection и другие
готовые очереди с блокировкой — синхронизацию писать самому:

    public sealed class Chan
    {
        public Chan(int cap);      // cap >= 1 — ёмкость буфера
        // Кладёт значение. Если буфер полон — БЛОКИРУЕТСЯ, пока не освободится место.
        // Возвращает false, если канал закрыт (значение не положено).
        public bool Send(long v);
        // Забирает значение в порядке FIFO. Если буфер пуст — БЛОКИРУЕТСЯ до появления
        // значения либо до закрытия канала. После закрытия отдаёт остаток буфера, затем null.
        public long? Recv();
        // Закрывает канал и будит всех ожидающих.
        public void Close();
        // Текущее число значений в буфере.
        public int Count { get; }
    }

Требования:
- ни одно отправленное значение не теряется и не дублируется;
- порядок FIFO;
- ёмкость соблюдается строго: в буфере не может оказаться больше cap значений;
- после Close() ожидающие в Send и Recv обязаны проснуться, а не зависнуть;
- активное ожидание в цикле (busy-wait/spin) недопустимо — используйте Monitor.Wait/PulseAll.

Класс объявляйте на верхнем уровне файла, БЕЗ namespace. Верните ПОЛНОЕ содержимое Lib.cs.`;

const CONC_VISIBLE = `var c = new Chan(2);
c.Send(1); c.Send(2);
Console.WriteLine(c.Recv() == 1); // true
Console.WriteLine(c.Recv() == 2); // true
var c2 = new Chan(1);
var t = Task.Run(() => { Thread.Sleep(50); c2.Close(); });
Console.WriteLine(c2.Recv() == null); // true — close будит ожидающего
t.Wait();
`;

const CONC_HIDDEN = HARNESS_PRELUDE + `
checks.Add(("h_fifo_order", () => WithDeadline(5000, () => {
    var c = new Chan(4);
    for (long i = 0; i < 4; i++) if (!c.Send(i)) throw new Exception("send");
    for (long i = 0; i < 4; i++) if (c.Recv() != i) throw new Exception("fifo");
})));
checks.Add(("h_capacity_is_enforced", () => WithDeadline(5000, () => {
    var c = new Chan(2);
    c.Send(1); c.Send(2);
    if (c.Count != 2) throw new Exception("count");
    var t = Task.Run(() => { c.Send(3); }); // обязан заблокироваться
    Thread.Sleep(100);
    if (c.Count != 2) throw new Exception("ёмкость нарушена");
    if (c.Recv() != 1) throw new Exception("recv1");
    t.Wait(3000);
    if (c.Recv() != 2) throw new Exception("recv2");
    if (c.Recv() != 3) throw new Exception("recv3");
})));
checks.Add(("h_no_loss_under_contention", () => WithDeadline(20000, () => {
    var c = new Chan(8);
    const long P = 4, N = 250;
    var producers = new List<Task>();
    for (long p = 0; p < P; p++)
    {
        long pp = p;
        producers.Add(Task.Run(() => {
            for (long i = 0; i < N; i++)
                if (!c.Send(pp * N + i)) throw new Exception("closed");
        }));
    }
    var consumer = Task.Run(() => {
        var seen = new List<long>();
        for (long k = 0; k < P * N; k++)
        {
            var v = c.Recv();
            if (v == null) break;
            seen.Add(v.Value);
        }
        return seen;
    });
    Task.WaitAll(producers.ToArray());
    var got = consumer.Result;
    if (got.Count != P * N) throw new Exception("потеряны значения");
    var uniq = got.Distinct().Count();
    if (uniq != P * N) throw new Exception("есть дубликаты");
})));
checks.Add(("h_close_drains_then_none", () => WithDeadline(5000, () => {
    var c = new Chan(4);
    c.Send(1); c.Send(2);
    c.Close();
    if (c.Recv() != 1) throw new Exception("после close остаток буфера обязан отдаваться");
    if (c.Recv() != 2) throw new Exception("drain2");
    if (c.Recv() != null) throw new Exception("none1");
    if (c.Recv() != null) throw new Exception("none2");
})));
checks.Add(("h_send_after_close_errors", () => WithDeadline(5000, () => {
    var c = new Chan(2);
    c.Close();
    if (c.Send(7)) throw new Exception("send после close обязан вернуть false");
})));
checks.Add(("h_close_wakes_blocked_sender", () => WithDeadline(5000, () => {
    var c = new Chan(1);
    c.Send(1);
    var t = Task.Run(() => c.Send(2)); // блокируется: буфер полон
    Thread.Sleep(100);
    c.Close();
    if (!t.Wait(3000)) throw new Exception("заблокированный Send не проснулся после Close");
    if (t.Result) throw new Exception("Send после Close обязан вернуть false");
})));
` + HARNESS_EPILOGUE;

const CONC_REFERENCE = `public sealed class Chan
{
    private readonly int _cap;
    private readonly Queue<long> _buf = new();
    private readonly object _lock = new();
    private bool _closed;

    public Chan(int cap)
    {
        _cap = Math.Max(1, cap);
    }

    public bool Send(long v)
    {
        lock (_lock)
        {
            while (!_closed && _buf.Count >= _cap)
                Monitor.Wait(_lock);
            if (_closed) return false;
            _buf.Enqueue(v);
            Monitor.PulseAll(_lock);
            return true;
        }
    }

    public long? Recv()
    {
        lock (_lock)
        {
            while (_buf.Count == 0 && !_closed)
                Monitor.Wait(_lock);
            if (_buf.Count == 0) return null;
            long v = _buf.Dequeue();
            Monitor.PulseAll(_lock);
            return v;
        }
    }

    public void Close()
    {
        lock (_lock)
        {
            _closed = true;
            Monitor.PulseAll(_lock);
        }
    }

    public int Count
    {
        get { lock (_lock) return _buf.Count; }
    }
}
`;

const TASKS = [
  { key: 'edit', kind: 'edit', lang: 'csharp', csproj: CSPROJ,
    spec: EDIT_SPEC, starter: EDIT_STARTER, visible: EDIT_VISIBLE,
    hidden: EDIT_HIDDEN, reference: EDIT_REFERENCE },
  { key: 'algo', kind: 'algo', lang: 'csharp', csproj: CSPROJ,
    spec: ALGO_SPEC, starter: '', visible: ALGO_VISIBLE,
    hidden: ALGO_HIDDEN, reference: ALGO_REFERENCE },
  { key: 'conc', kind: 'conc', lang: 'csharp', csproj: CSPROJ,
    spec: CONC_SPEC, starter: '', visible: CONC_VISIBLE,
    hidden: CONC_HIDDEN, reference: CONC_REFERENCE },
];

module.exports = { TASKS };
