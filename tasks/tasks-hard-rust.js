// ТЯЖЁЛЫЙ набор задач на Rust — три типа: правка чужого кода, алгоритмическая глубина,
// согласованность под параллелизмом. Задуман как разделитель для моделей, у которых обычный
// набор (expr/lru/wordcount) насыщен: там половина кандидатов держит 100%.
//
// ! Каждая задача сопровождается эталонным решением (`reference`) и обязана проходить свои же
//   скрытые тесты ДО использования в кампании. Ошибка в скрытом тесте провалила бы все модели
//   разом и читалась бы как их слабость, а не как наш дефект.
//
// Формат совместим с tasks-rust.js: { key, kind, spec, cargoToml, visible, hidden, starter }.
//   spec     — текст задания для модели
//   starter  — существующий код (для kind='edit'); пусто для остальных
//   visible  — тесты, которые модель ВИДИТ (в агентном режиме доступны как обратная связь)
//   hidden   — скрытые тесты, по ним считается результат
//   reference— наше решение, только для самопроверки набора

const CARGO = `[package]
name = "hard"
version = "0.1.0"
edition = "2021"

[lib]
path = "src/lib.rs"
`;

// ---------------------------------------------------------------------------
// 1. ПРАВКА ЧУЖОГО КОДА: кэш с вытеснением и сроком жизни.
// Даётся рабочий модуль с ОДНИМ дефектом и требованием добавить возможность, не сломав
// публичный API. Проверяется и новая функция, и регрессии на старое поведение.
// Дефект намеренно неочевиден: `put` существующего ключа не обновляет позицию в порядке
// использования, из-за чего вытесняется не тот элемент. Модель об этом предупреждена, но
// место дефекта не названо — искать надо самой.
// ---------------------------------------------------------------------------
const EDIT_STARTER = `use std::collections::HashMap;

/// Кэш с вытеснением наименее недавно использованного и сроком жизни записи.
/// Время подаётся снаружи (в тиках), чтобы поведение было детерминированным.
pub struct TtlCache {
    cap: usize,
    ttl: u64,
    map: HashMap<String, (i64, u64)>, // ключ -> (значение, тик записи)
    order: Vec<String>,              // от самого давнего к самому свежему
}

impl TtlCache {
    pub fn new(cap: usize, ttl: u64) -> Self {
        TtlCache { cap, ttl, map: HashMap::new(), order: Vec::new() }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    fn touch(&mut self, key: &str) {
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            let k = self.order.remove(pos);
            self.order.push(k);
        }
    }

    fn expire(&mut self, now: u64) {
        let dead: Vec<String> = self
            .map
            .iter()
            .filter(|(_, (_, t))| now.saturating_sub(*t) >= self.ttl)
            .map(|(k, _)| k.clone())
            .collect();
        for k in dead {
            self.map.remove(&k);
            if let Some(pos) = self.order.iter().position(|x| *x == k) {
                self.order.remove(pos);
            }
        }
    }

    pub fn get(&mut self, key: &str, now: u64) -> Option<i64> {
        self.expire(now);
        let v = self.map.get(key).map(|(v, _)| *v);
        if v.is_some() {
            self.touch(key);
        }
        v
    }

    pub fn put(&mut self, key: &str, val: i64, now: u64) {
        self.expire(now);
        if self.map.contains_key(key) {
            self.map.insert(key.to_string(), (val, now));
            return;
        }
        if self.map.len() >= self.cap {
            if !self.order.is_empty() {
                let victim = self.order.remove(0);
                self.map.remove(&victim);
            }
        }
        self.map.insert(key.to_string(), (val, now));
        self.order.push(key.to_string());
    }
}
`;

const EDIT_SPEC = `В файле src/lib.rs лежит РАБОЧИЙ модуль TtlCache — кэш с вытеснением наименее недавно
использованного элемента и сроком жизни записи. Время подаётся параметром now (тики).

Требуется ДВА изменения:

1. НАЙТИ И ИСПРАВИТЬ ДЕФЕКТ. В модуле есть одна ошибка, из-за которой при переполнении иногда
   вытесняется не тот элемент. Место ошибки не указано — найдите сами. Существующее публичное
   поведение (new/len/get/put и семантика ttl) менять нельзя, кроме исправления самой ошибки.

2. ДОБАВИТЬ МЕТОД:
       pub fn get_or_insert_with<F: FnOnce() -> i64>(&mut self, key: &str, now: u64, f: F) -> i64
   Возвращает живое значение по ключу, если оно есть; иначе вычисляет f(), кладёт по этому ключу
   и возвращает. Метод обязан подчиняться тем же правилам, что get и put: истёкшие записи
   удаляются, обращение обновляет позицию в порядке использования, при переполнении вытесняется
   наименее недавно использованный. f() вызывается РОВНО ОДИН раз и только когда значения нет.

Публичный API ломать нельзя: сигнатуры new, len, get, put обязаны остаться прежними.
Верните ПОЛНОЕ содержимое src/lib.rs.`;

const EDIT_VISIBLE = `use hard::TtlCache;

#[test]
fn basic_get_put() {
    let mut c = TtlCache::new(2, 10);
    c.put("a", 1, 0);
    assert_eq!(c.get("a", 1), Some(1));
    assert_eq!(c.get("zz", 1), None);
}

#[test]
fn ttl_expires() {
    let mut c = TtlCache::new(2, 5);
    c.put("a", 1, 0);
    assert_eq!(c.get("a", 5), None);
}
`;

const EDIT_HIDDEN = `use hard::TtlCache;

// --- регрессии на существующее поведение ---
#[test]
fn r_len_and_capacity() {
    let mut c = TtlCache::new(2, 100);
    c.put("a", 1, 0);
    c.put("b", 2, 0);
    c.put("c", 3, 0);
    assert_eq!(c.len(), 2);
}

#[test]
fn r_ttl_boundary_is_inclusive() {
    // запись живёт строго меньше ttl тиков: на границе она уже мертва
    let mut c = TtlCache::new(4, 5);
    c.put("a", 1, 0);
    assert_eq!(c.get("a", 4), Some(1));
    assert_eq!(c.get("a", 5), None);
}

#[test]
fn r_get_refreshes_recency() {
    let mut c = TtlCache::new(2, 100);
    c.put("a", 1, 0);
    c.put("b", 2, 0);
    assert_eq!(c.get("a", 1), Some(1)); // теперь свежайший — a
    c.put("c", 3, 1);                   // вытесниться обязан b
    assert_eq!(c.get("b", 2), None);
    assert_eq!(c.get("a", 2), Some(1));
}

// --- собственно дефект: повторный put обязан обновлять позицию ---
#[test]
fn bug_put_existing_refreshes_recency() {
    let mut c = TtlCache::new(2, 100);
    c.put("a", 1, 0);
    c.put("b", 2, 0);
    c.put("a", 10, 1); // a становится свежайшим
    c.put("c", 3, 2);  // вытесниться обязан b, а не a
    assert_eq!(c.get("a", 3), Some(10));
    assert_eq!(c.get("b", 3), None);
    assert_eq!(c.get("c", 3), Some(3));
}

#[test]
fn bug_put_existing_updates_value_and_stamp() {
    let mut c = TtlCache::new(2, 5);
    c.put("a", 1, 0);
    c.put("a", 2, 4);              // отметка времени обновляется
    assert_eq!(c.get("a", 8), Some(2)); // 8 - 4 = 4 < 5, ещё жива
    assert_eq!(c.get("a", 9), None);    // 9 - 4 = 5, истекла
}

// --- новый метод ---
#[test]
fn n_inserts_when_absent() {
    let mut c = TtlCache::new(2, 100);
    let v = c.get_or_insert_with("a", 0, || 42);
    assert_eq!(v, 42);
    assert_eq!(c.get("a", 0), Some(42));
}

#[test]
fn n_returns_existing_without_calling_f() {
    let mut c = TtlCache::new(2, 100);
    c.put("a", 7, 0);
    let mut called = 0;
    let v = c.get_or_insert_with("a", 1, || { called += 1; 99 });
    assert_eq!(v, 7);
    assert_eq!(called, 0);
}

#[test]
fn n_recomputes_after_expiry() {
    let mut c = TtlCache::new(2, 5);
    c.put("a", 7, 0);
    let v = c.get_or_insert_with("a", 5, || 99); // истекла — считаем заново
    assert_eq!(v, 99);
    assert_eq!(c.get("a", 5), Some(99));
}

#[test]
fn n_evicts_least_recent_and_refreshes() {
    let mut c = TtlCache::new(2, 100);
    c.put("a", 1, 0);
    c.put("b", 2, 0);
    let _ = c.get_or_insert_with("a", 1, || 0); // a свежайший, f не вызывается
    let _ = c.get_or_insert_with("c", 2, || 3); // вытесниться обязан b
    assert_eq!(c.get("b", 3), None);
    assert_eq!(c.get("a", 3), Some(1));
    assert_eq!(c.get("c", 3), Some(3));
    assert_eq!(c.len(), 2);
}

#[test]
fn n_respects_capacity_one() {
    let mut c = TtlCache::new(1, 100);
    let _ = c.get_or_insert_with("a", 0, || 1);
    let _ = c.get_or_insert_with("b", 0, || 2);
    assert_eq!(c.len(), 1);
    assert_eq!(c.get("a", 0), None);
    assert_eq!(c.get("b", 0), Some(2));
}
`;

// Эталон: исправлен `put` (повторная запись обновляет позицию) + добавлен новый метод.
const EDIT_REFERENCE = EDIT_STARTER
  .replace(
    `        if self.map.contains_key(key) {
            self.map.insert(key.to_string(), (val, now));
            return;
        }`,
    `        if self.map.contains_key(key) {
            self.map.insert(key.to_string(), (val, now));
            self.touch(key);
            return;
        }`)
  + `
impl TtlCache {
    pub fn get_or_insert_with<F: FnOnce() -> i64>(&mut self, key: &str, now: u64, f: F) -> i64 {
        if let Some(v) = self.get(key, now) {
            return v;
        }
        let v = f();
        self.put(key, v, now);
        v
    }
}
`;

// ---------------------------------------------------------------------------
// 2. АЛГОРИТМИЧЕСКАЯ ГЛУБИНА: медиана скользящего окна.
// Наивное решение (сортировка окна на каждом шаге) проходит по корректности, но задача
// сформулирована так, что требуется устойчивость к дубликатам и чётным окнам — именно там
// ломаются поспешные реализации.
// ---------------------------------------------------------------------------
const ALGO_SPEC = `Реализуйте в src/lib.rs структуру для медианы скользящего окна:

    pub struct RollingMedian { /* ваши поля */ }

    impl RollingMedian {
        /// window >= 1
        pub fn new(window: usize) -> Self;
        /// Добавляет значение. Если в окне уже window элементов, самое старое выбывает.
        pub fn push(&mut self, x: i64);
        /// Медиана текущего окна. None, пока не добавлено ни одного значения.
        /// Для чётного числа элементов — СРЕДНЕЕ двух центральных.
        pub fn median(&self) -> Option<f64>;
        /// Сколько значений сейчас в окне.
        pub fn len(&self) -> usize;
    }

Требования:
- окно ведёт себя как очередь: выбывает всегда самое старое по времени добавления, а не
  наименьшее по значению;
- дубликаты допустимы и должны учитываться каждый по отдельности;
- значения могут быть любыми i64, включая отрицательные и повторяющиеся;
- медиана чётного окна — среднее арифметическое двух центральных значений (в f64).

Верните ПОЛНОЕ содержимое src/lib.rs.`;

const ALGO_VISIBLE = `use hard::RollingMedian;

#[test]
fn simple() {
    let mut m = RollingMedian::new(3);
    assert_eq!(m.median(), None);
    m.push(1);
    assert_eq!(m.median(), Some(1.0));
    m.push(3);
    assert_eq!(m.median(), Some(2.0)); // среднее 1 и 3
}
`;

const ALGO_HIDDEN = `use hard::RollingMedian;

fn approx(a: Option<f64>, b: f64) -> bool {
    matches!(a, Some(x) if (x - b).abs() < 1e-9)
}

#[test]
fn h_window_slides_by_age_not_value() {
    let mut m = RollingMedian::new(3);
    for v in [10, 1, 2] { m.push(v); }
    assert!(approx(m.median(), 2.0));      // {10,1,2}
    m.push(3);                              // выбывает 10, а не 1
    assert!(approx(m.median(), 2.0));      // {1,2,3}
    m.push(100);
    assert!(approx(m.median(), 3.0));      // {2,3,100}
}

#[test]
fn h_even_window_averages_two_middles() {
    let mut m = RollingMedian::new(4);
    for v in [1, 2, 3, 4] { m.push(v); }
    assert!(approx(m.median(), 2.5));
    m.push(5);
    assert!(approx(m.median(), 3.5));      // {2,3,4,5}
}

#[test]
fn h_duplicates_counted_separately() {
    let mut m = RollingMedian::new(5);
    for v in [7, 7, 7, 1, 9] { m.push(v); }
    assert!(approx(m.median(), 7.0));
    m.push(7);                              // выбывает первая семёрка
    assert!(approx(m.median(), 7.0));       // {7,7,1,9,7}
    for _ in 0..5 { m.push(0); }
    assert!(approx(m.median(), 0.0));
}

#[test]
fn h_negative_and_extremes() {
    let mut m = RollingMedian::new(3);
    m.push(i64::MIN);
    m.push(0);
    m.push(i64::MAX);
    assert!(approx(m.median(), 0.0));
    m.push(-5);
    // {0, i64::MAX, -5} -> медиана 0
    assert!(approx(m.median(), 0.0));
}

#[test]
fn h_window_one() {
    let mut m = RollingMedian::new(1);
    m.push(5);
    assert!(approx(m.median(), 5.0));
    m.push(-3);
    assert!(approx(m.median(), -3.0));
    assert_eq!(m.len(), 1);
}

#[test]
fn h_partial_window_before_full() {
    let mut m = RollingMedian::new(5);
    m.push(4);
    assert!(approx(m.median(), 4.0));
    m.push(2);
    assert!(approx(m.median(), 3.0));       // среднее 2 и 4
    m.push(6);
    assert!(approx(m.median(), 4.0));
    assert_eq!(m.len(), 3);
}

#[test]
fn h_long_adversarial_sequence() {
    // пилообразная последовательность с повторами: ловит реализации,
    // которые «забывают» удалять выбывший элемент из вспомогательной структуры
    let mut m = RollingMedian::new(7);
    let mut naive: std::collections::VecDeque<i64> = std::collections::VecDeque::new();
    for i in 0..200i64 {
        let v = if i % 3 == 0 { i % 11 } else { -(i % 7) };
        m.push(v);
        naive.push_back(v);
        if naive.len() > 7 { naive.pop_front(); }
        let mut s: Vec<i64> = naive.iter().copied().collect();
        s.sort_unstable();
        let n = s.len();
        let expect = if n % 2 == 1 { s[n / 2] as f64 }
                     else { (s[n / 2 - 1] as f64 + s[n / 2] as f64) / 2.0 };
        assert!(approx(m.median(), expect), "шаг {}", i);
    }
}
`;

const ALGO_REFERENCE = `use std::collections::VecDeque;

pub struct RollingMedian {
    window: usize,
    order: VecDeque<i64>,
    sorted: Vec<i64>,
}

impl RollingMedian {
    pub fn new(window: usize) -> Self {
        RollingMedian { window: window.max(1), order: VecDeque::new(), sorted: Vec::new() }
    }

    pub fn push(&mut self, x: i64) {
        if self.order.len() == self.window {
            if let Some(old) = self.order.pop_front() {
                if let Ok(pos) = self.sorted.binary_search(&old) {
                    self.sorted.remove(pos);
                }
            }
        }
        self.order.push_back(x);
        let pos = self.sorted.partition_point(|&v| v < x);
        self.sorted.insert(pos, x);
    }

    pub fn median(&self) -> Option<f64> {
        let n = self.sorted.len();
        if n == 0 { return None; }
        Some(if n % 2 == 1 {
            self.sorted[n / 2] as f64
        } else {
            (self.sorted[n / 2 - 1] as f64 + self.sorted[n / 2] as f64) / 2.0
        })
    }

    pub fn len(&self) -> usize { self.order.len() }
}
`;

// ---------------------------------------------------------------------------
// 3. СОГЛАСОВАННОСТЬ ПОД ПАРАЛЛЕЛИЗМОМ: ограниченный канал с обратным давлением.
// Проверяется не «скомпилировалось», а отсутствие потерь, дубликатов и взаимных блокировок
// при реальных потоках. Тесты идут под таймаутом: зависшая реализация обязана падать, а не
// висеть вечно.
// ---------------------------------------------------------------------------
const CONC_SPEC = `Реализуйте в src/lib.rs ограниченный канал с обратным давлением, только на стандартной
библиотеке (никаких внешних зависимостей, никакого std::sync::mpsc — писать самому):

    pub struct Chan { /* ваши поля */ }

    impl Chan {
        /// cap >= 1 — ёмкость буфера
        pub fn new(cap: usize) -> std::sync::Arc<Chan>;
        /// Кладёт значение. Если буфер полон — БЛОКИРУЕТСЯ, пока не освободится место.
        /// Возвращает Err(v), если канал закрыт.
        pub fn send(&self, v: i64) -> Result<(), i64>;
        /// Забирает значение в порядке FIFO. Если буфер пуст — БЛОКИРУЕТСЯ до появления
        /// значения либо до закрытия канала. После закрытия отдаёт остаток буфера, затем None.
        pub fn recv(&self) -> Option<i64>;
        /// Закрывает канал и будит всех ожидающих.
        pub fn close(&self);
        /// Текущее число значений в буфере.
        pub fn len(&self) -> usize;
    }

Требования:
- ни одно отправленное значение не теряется и не дублируется;
- порядок FIFO;
- ёмкость соблюдается строго: в буфере не может оказаться больше cap значений;
- после close() ожидающие в send и recv обязаны проснуться, а не зависнуть;
- активное ожидание в цикле (busy-wait) недопустимо — используйте Condvar.

Верните ПОЛНОЕ содержимое src/lib.rs.`;

const CONC_VISIBLE = `use hard::Chan;

#[test]
fn send_then_recv() {
    let c = Chan::new(2);
    c.send(1).unwrap();
    c.send(2).unwrap();
    assert_eq!(c.recv(), Some(1));
    assert_eq!(c.recv(), Some(2));
}

#[test]
fn close_unblocks_recv() {
    let c = Chan::new(1);
    let c2 = c.clone();
    std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_millis(50)); c2.close(); });
    assert_eq!(c.recv(), None);
}
`;

const CONC_HIDDEN = `use hard::Chan;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// Прогоняет тело в отдельном потоке и падает, если оно не уложилось в срок.
/// Без этого зависшая реализация висела бы до общего таймаута прогона, и мы не отличили бы
/// «взаимная блокировка» от «медленно».
fn with_deadline<F: FnOnce() + Send + 'static>(ms: u64, f: F) {
    let done = Arc::new(AtomicUsize::new(0));
    let d2 = done.clone();
    let h = thread::spawn(move || { f(); d2.store(1, Ordering::SeqCst); });
    let mut waited = 0;
    while waited < ms && done.load(Ordering::SeqCst) == 0 {
        thread::sleep(Duration::from_millis(10));
        waited += 10;
    }
    assert_eq!(done.load(Ordering::SeqCst), 1, "истёк срок: похоже на взаимную блокировку");
    let _ = h.join();
}

#[test]
fn h_fifo_order() {
    with_deadline(5000, || {
        let c = Chan::new(4);
        for i in 0..4 { c.send(i).unwrap(); }
        for i in 0..4 { assert_eq!(c.recv(), Some(i)); }
    });
}

#[test]
fn h_capacity_is_enforced() {
    with_deadline(5000, || {
        let c = Chan::new(2);
        c.send(1).unwrap();
        c.send(2).unwrap();
        assert_eq!(c.len(), 2);
        let c2 = c.clone();
        let h = thread::spawn(move || { c2.send(3).unwrap(); }); // обязан заблокироваться
        thread::sleep(Duration::from_millis(100));
        assert_eq!(c.len(), 2, "ёмкость нарушена: третье значение попало в полный буфер");
        assert_eq!(c.recv(), Some(1));
        h.join().unwrap();
        assert_eq!(c.recv(), Some(2));
        assert_eq!(c.recv(), Some(3));
    });
}

#[test]
fn h_no_loss_under_contention() {
    with_deadline(20000, || {
        let c = Chan::new(8);
        const P: i64 = 4;
        const N: i64 = 250;
        let mut hs = Vec::new();
        for p in 0..P {
            let c2 = c.clone();
            hs.push(thread::spawn(move || {
                for i in 0..N { c2.send(p * N + i).unwrap(); }
            }));
        }
        let c3 = c.clone();
        let consumer = thread::spawn(move || {
            let mut seen = Vec::new();
            for _ in 0..(P * N) {
                match c3.recv() { Some(v) => seen.push(v), None => break }
            }
            seen
        });
        for h in hs { h.join().unwrap(); }
        let mut seen = consumer.join().unwrap();
        assert_eq!(seen.len() as i64, P * N, "потеряны значения");
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len() as i64, P * N, "есть дубликаты");
    });
}

#[test]
fn h_close_drains_then_none() {
    with_deadline(5000, || {
        let c = Chan::new(4);
        c.send(1).unwrap();
        c.send(2).unwrap();
        c.close();
        assert_eq!(c.recv(), Some(1), "после close остаток буфера обязан отдаваться");
        assert_eq!(c.recv(), Some(2));
        assert_eq!(c.recv(), None);
        assert_eq!(c.recv(), None);
    });
}

#[test]
fn h_send_after_close_errors() {
    with_deadline(5000, || {
        let c = Chan::new(2);
        c.close();
        assert_eq!(c.send(7), Err(7));
    });
}

#[test]
fn h_close_wakes_blocked_sender() {
    with_deadline(5000, || {
        let c = Chan::new(1);
        c.send(1).unwrap();
        let c2 = c.clone();
        let h = thread::spawn(move || c2.send(2)); // блокируется: буфер полон
        thread::sleep(Duration::from_millis(100));
        c.close();
        let r = h.join().unwrap();
        assert!(r.is_err(), "заблокированный send обязан проснуться с ошибкой после close");
    });
}
`;

const CONC_REFERENCE = `use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};

struct Inner {
    buf: VecDeque<i64>,
    closed: bool,
}

pub struct Chan {
    cap: usize,
    inner: Mutex<Inner>,
    not_empty: Condvar,
    not_full: Condvar,
}

impl Chan {
    pub fn new(cap: usize) -> Arc<Chan> {
        Arc::new(Chan {
            cap: cap.max(1),
            inner: Mutex::new(Inner { buf: VecDeque::new(), closed: false }),
            not_empty: Condvar::new(),
            not_full: Condvar::new(),
        })
    }

    pub fn send(&self, v: i64) -> Result<(), i64> {
        let mut g = self.inner.lock().unwrap();
        while !g.closed && g.buf.len() >= self.cap {
            g = self.not_full.wait(g).unwrap();
        }
        if g.closed { return Err(v); }
        g.buf.push_back(v);
        drop(g);
        self.not_empty.notify_one();
        Ok(())
    }

    pub fn recv(&self) -> Option<i64> {
        let mut g = self.inner.lock().unwrap();
        while g.buf.is_empty() && !g.closed {
            g = self.not_empty.wait(g).unwrap();
        }
        let v = g.buf.pop_front();
        drop(g);
        if v.is_some() { self.not_full.notify_one(); }
        v
    }

    pub fn close(&self) {
        let mut g = self.inner.lock().unwrap();
        g.closed = true;
        drop(g);
        self.not_empty.notify_all();
        self.not_full.notify_all();
    }

    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().buf.len()
    }
}
`;

const TASKS = [
  { key: 'edit', kind: 'edit', lang: 'rust', cargoToml: CARGO,
    spec: EDIT_SPEC, starter: EDIT_STARTER, visible: EDIT_VISIBLE,
    hidden: EDIT_HIDDEN, reference: EDIT_REFERENCE },
  { key: 'algo', kind: 'algo', lang: 'rust', cargoToml: CARGO,
    spec: ALGO_SPEC, starter: '', visible: ALGO_VISIBLE,
    hidden: ALGO_HIDDEN, reference: ALGO_REFERENCE },
  { key: 'conc', kind: 'conc', lang: 'rust', cargoToml: CARGO,
    spec: CONC_SPEC, starter: '', visible: CONC_VISIBLE,
    hidden: CONC_HIDDEN, reference: CONC_REFERENCE },
];

module.exports = { TASKS };
