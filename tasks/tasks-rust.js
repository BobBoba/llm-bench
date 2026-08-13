// Task definitions for the ZDR Rust code-gen benchmark.
// Each task fixes an exact public API. Models receive only the spec + a few
// VISIBLE example tests. Scoring uses the larger HIDDEN test suite.
// All tasks are std-only so crates build offline and fast.

const CARGO = (name) => `[package]
name = "${name}"
version = "0.0.0"
edition = "2021"

[lib]
path = "src/lib.rs"
`;

// ---------------------------------------------------------------------------
// Task 1 — arithmetic expression evaluator (parsing / errors / recursion)
// ---------------------------------------------------------------------------
const EXPR_SPEC = `Implement a small arithmetic expression evaluator in Rust (standard library only).

Define EXACTLY this public API in src/lib.rs (names and signatures must match exactly):

    #[derive(Debug, PartialEq)]
    pub enum EvalError {
        DivisionByZero,
        SyntaxError,
    }

    pub fn eval(input: &str) -> Result<f64, EvalError>;

Requirements:
- Support binary operators + - * / with usual precedence (* and / bind tighter than + and -), left-associative.
- Support parentheses ( ) for grouping.
- Support unary plus and unary minus (e.g. "-5", "2*-3").
- Support integer and decimal numbers (e.g. "3", "3.5"). No exponent notation required.
- Ignore ASCII whitespace anywhere between tokens.
- Division by zero returns Err(EvalError::DivisionByZero).
- Any malformed input (empty, trailing operator, unbalanced parens, unknown characters, two numbers in a row, etc.) returns Err(EvalError::SyntaxError).

Example behaviour:
    eval("2 + 3 * 4")      == Ok(14.0)
    eval("(2 + 3) * 4")    == Ok(20.0)
    eval("10 / 4")         == Ok(2.5)
    eval("2 * -3")         == Ok(-6.0)
    eval("1 / 0")          == Err(EvalError::DivisionByZero)
    eval("1 +")            == Err(EvalError::SyntaxError)

Return ONLY the full contents of src/lib.rs. Do not include explanations or markdown fences.`;

const EXPR_VISIBLE = `use bench::{eval, EvalError};
fn approx(a: f64, b: f64) -> bool { (a - b).abs() < 1e-9 }
#[test] fn v1() { assert!(approx(eval("2 + 3 * 4").unwrap(), 14.0)); }
#[test] fn v2() { assert!(approx(eval("(2 + 3) * 4").unwrap(), 20.0)); }
#[test] fn v3() { assert!(approx(eval("2 * -3").unwrap(), -6.0)); }
#[test] fn v4() { assert_eq!(eval("1 / 0"), Err(EvalError::DivisionByZero)); }
#[test] fn v5() { assert_eq!(eval("1 +"), Err(EvalError::SyntaxError)); }
`;

const EXPR_HIDDEN = `use bench::{eval, EvalError};
fn ok(s: &str, v: f64) { let r = eval(s).expect(s); assert!((r - v).abs() < 1e-9, "{} => {} expected {}", s, r, v); }
fn dz(s: &str) { assert_eq!(eval(s), Err(EvalError::DivisionByZero), "{}", s); }
fn se(s: &str) { assert_eq!(eval(s), Err(EvalError::SyntaxError), "{}", s); }
#[test] fn t01() { ok("1+2", 3.0); }
#[test] fn t02() { ok("2+3*4", 14.0); }
#[test] fn t03() { ok("(2+3)*4", 20.0); }
#[test] fn t04() { ok("10/4", 2.5); }
#[test] fn t05() { ok("-5+3", -2.0); }
#[test] fn t06() { ok("2*-3", -6.0); }
#[test] fn t07() { ok("3.5*2", 7.0); }
#[test] fn t08() { ok("((1+2)*(3+4))", 21.0); }
#[test] fn t09() { ok("  7  -  2  ", 5.0); }
#[test] fn t10() { ok("2-3-4", -5.0); }
#[test] fn t11() { ok("100", 100.0); }
#[test] fn t12() { ok("2+2*2-1", 5.0); }
#[test] fn t13() { ok("-(3+4)", -7.0); }
#[test] fn t14() { ok("8/2/2", 2.0); }
#[test] fn t15() { ok("1.5+1.5", 3.0); }
#[test] fn t16() { dz("1/0"); }
#[test] fn t17() { dz("2/(3-3)"); }
#[test] fn t18() { se(""); }
#[test] fn t19() { se("1+"); }
#[test] fn t20() { se("(1+2"); }
#[test] fn t21() { se("1+*2"); }
#[test] fn t22() { se("abc"); }
#[test] fn t23() { se("2 2"); }
#[test] fn t24() { se("3+4)"); }
#[test] fn t25() { se("*5"); }
`;

// ---------------------------------------------------------------------------
// Task 2 — generic LRU cache (generics / trait bounds / ownership / DS)
// ---------------------------------------------------------------------------
const LRU_SPEC = `Implement a generic Least-Recently-Used (LRU) cache in Rust (standard library only).

Define EXACTLY this public API in src/lib.rs (names and signatures must match exactly):

    pub struct LruCache<K, V> { /* your fields */ }

    impl<K: std::hash::Hash + Eq + Clone, V> LruCache<K, V> {
        pub fn new(capacity: usize) -> Self;
        pub fn get(&mut self, key: &K) -> Option<&V>;
        pub fn put(&mut self, key: K, value: V);
        pub fn len(&self) -> usize;
        pub fn is_empty(&self) -> bool;
    }

Semantics:
- Holds at most \`capacity\` entries.
- put(k, v): if k exists, update its value; otherwise insert. Either way k becomes most-recently-used. If inserting a NEW key would exceed capacity, evict the least-recently-used entry first.
- get(&k): returns Some(&value) if present and marks k most-recently-used; otherwise None.
- A capacity of 0 means the cache never stores anything.
- len() is the current number of entries; is_empty() is len()==0.

Example behaviour:
    let mut c = LruCache::new(2);
    c.put(1, "a"); c.put(2, "b");
    c.get(&1);                 // touches 1 -> most recent
    c.put(3, "c");             // evicts 2 (least recent)
    assert_eq!(c.get(&2), None);
    assert_eq!(c.get(&1), Some(&"a"));
    assert_eq!(c.get(&3), Some(&"c"));

Return ONLY the full contents of src/lib.rs. Do not include explanations or markdown fences.`;

const LRU_VISIBLE = `use bench::LruCache;
#[test] fn v1() {
    let mut c = LruCache::new(2);
    c.put(1, "a"); c.put(2, "b");
    assert_eq!(c.get(&1), Some(&"a"));
    c.put(3, "c");              // evicts 2
    assert_eq!(c.get(&2), None);
    assert_eq!(c.get(&3), Some(&"c"));
}
#[test] fn v2() {
    let mut c = LruCache::new(2);
    c.put(1, "a"); c.put(1, "b");
    assert_eq!(c.get(&1), Some(&"b"));
    assert_eq!(c.len(), 1);
}
`;

const LRU_HIDDEN = `use bench::LruCache;
#[test] fn t01() { let mut c=LruCache::new(2); c.put(1,"a"); c.put(2,"b"); assert_eq!(c.get(&1),Some(&"a")); assert_eq!(c.get(&2),Some(&"b")); }
#[test] fn t02() { let mut c=LruCache::new(2); c.put(1,"a"); c.put(2,"b"); c.put(3,"c"); assert_eq!(c.get(&1),None); assert_eq!(c.get(&2),Some(&"b")); assert_eq!(c.get(&3),Some(&"c")); }
#[test] fn t03() { let mut c=LruCache::new(2); c.put(1,"a"); c.put(2,"b"); c.get(&1); c.put(3,"c"); assert_eq!(c.get(&2),None); assert_eq!(c.get(&1),Some(&"a")); assert_eq!(c.get(&3),Some(&"c")); }
#[test] fn t04() { let mut c=LruCache::new(2); c.put(1,"a"); c.put(1,"b"); assert_eq!(c.get(&1),Some(&"b")); assert_eq!(c.len(),1); }
#[test] fn t05() { let mut c=LruCache::new(2); c.put(1,"a"); c.put(2,"b"); c.put(1,"x"); c.put(3,"c"); assert_eq!(c.get(&2),None); assert_eq!(c.get(&1),Some(&"x")); assert_eq!(c.get(&3),Some(&"c")); }
#[test] fn t06() { let mut c:LruCache<i32,i32>=LruCache::new(3); assert!(c.is_empty()); c.put(1,10); assert!(!c.is_empty()); assert_eq!(c.len(),1); }
#[test] fn t07() { let mut c=LruCache::new(1); c.put(1,"a"); c.put(2,"b"); assert_eq!(c.get(&1),None); assert_eq!(c.get(&2),Some(&"b")); }
#[test] fn t08() { let mut c:LruCache<i32,i32>=LruCache::new(0); c.put(1,1); assert_eq!(c.len(),0); assert_eq!(c.get(&1),None); }
#[test] fn t09() { let mut c=LruCache::new(2); c.put(String::from("x"),1); c.put(String::from("y"),2); assert_eq!(c.get(&String::from("x")),Some(&1)); }
#[test] fn t10() { let mut c=LruCache::new(3); for i in 0..3 { c.put(i,i*i); } assert_eq!(c.len(),3); assert_eq!(c.get(&2),Some(&4)); }
#[test] fn t11() { let mut c=LruCache::new(3); for i in 0..5 { c.put(i,i); } assert_eq!(c.len(),3); assert_eq!(c.get(&0),None); assert_eq!(c.get(&1),None); assert_eq!(c.get(&4),Some(&4)); }
#[test] fn t12() { let mut c=LruCache::new(2); c.put(1,"a"); c.put(2,"b"); c.get(&1); c.get(&2); c.put(3,"c"); assert_eq!(c.get(&1),None); }
#[test] fn t13() { let mut c: LruCache<i32, i32> = LruCache::new(2); assert_eq!(c.get(&99), None); }
#[test] fn t14() { let mut c=LruCache::new(2); c.put(1,"a"); c.put(1,"a"); c.put(1,"a"); assert_eq!(c.len(),1); }
#[test] fn t15() { let mut c=LruCache::new(4); for i in 0..4 { c.put(i,i); } c.get(&0); c.put(4,4); assert_eq!(c.get(&1),None); assert_eq!(c.get(&0),Some(&0)); }
#[test] fn t16() { let mut c=LruCache::new(2); c.put(10,100); assert_eq!(*c.get(&10).unwrap(),100); }
#[test] fn t17() { let mut c=LruCache::new(3); c.put(1,"a"); c.put(2,"b"); c.put(3,"c"); c.put(2,"B"); c.put(4,"d"); assert_eq!(c.get(&1),None); assert_eq!(c.get(&2),Some(&"B")); }
#[test] fn t18() { let mut c=LruCache::new(2); c.put(1,vec![1,2,3]); assert_eq!(c.get(&1),Some(&vec![1,2,3])); }
`;

// ---------------------------------------------------------------------------
// Task 3 — parallel word frequency count (threads / Send-Sync / Arc-Mutex)
// ---------------------------------------------------------------------------
const WC_SPEC = `Implement a parallel word-frequency counter in Rust (standard library only — std::thread, no external crates).

Define EXACTLY this public API in src/lib.rs:

    pub fn word_count(text: &str, threads: usize) -> std::collections::HashMap<String, usize>;

Requirements:
- A "word" is a maximal run of non-whitespace characters (split on ASCII whitespace). Counting is case-sensitive; words are taken verbatim (punctuation stays part of the word).
- The returned map maps each distinct word to the number of times it appears in \`text\`.
- The work MUST be distributed across \`threads\` worker threads using std::thread (e.g. split the words into chunks, count per chunk on separate threads, then merge). If \`threads\` is 0, treat it as 1.
- The result must be identical regardless of the number of threads.
- An empty (or whitespace-only) input yields an empty map.

Example behaviour:
    let m = word_count("the cat the dog the", 2);
    assert_eq!(m.get("the"), Some(&3));
    assert_eq!(m.get("cat"), Some(&1));
    assert_eq!(word_count("", 4).len(), 0);

Return ONLY the full contents of src/lib.rs. Do not include explanations or markdown fences.`;

const WC_VISIBLE = `use bench::word_count;
#[test] fn v1() {
    let m = word_count("the cat the dog the", 2);
    assert_eq!(m.get("the"), Some(&3));
    assert_eq!(m.get("cat"), Some(&1));
    assert_eq!(m.get("dog"), Some(&1));
}
#[test] fn v2() { assert_eq!(word_count("   ", 4).len(), 0); }
`;

const WC_HIDDEN = `use bench::word_count;
use std::collections::HashMap;
fn seq(t:&str)->HashMap<String,usize>{ let mut m=HashMap::new(); for w in t.split_whitespace(){ *m.entry(w.to_string()).or_insert(0)+=1; } m }
fn check(t:&str){ for th in [1usize,2,4,8]{ assert_eq!(word_count(t,th), seq(t), "threads={}", th); } }
#[test] fn t01() { check("the cat the dog the"); }
#[test] fn t02() { check(""); }
#[test] fn t03() { check("   \t  \n "); }
#[test] fn t04() { check("a"); }
#[test] fn t05() { check("a a a a a a a a a a"); }
#[test] fn t06() { check("one two three four five six seven eight nine ten"); }
#[test] fn t07() { check("Hello hello HELLO Hello"); }
#[test] fn t08() { check("foo, foo. foo: bar; bar! baz?"); }
#[test] fn t09() { let big: String = (0..1000).map(|i| format!("w{} ", i%37)).collect(); check(&big); }
#[test] fn t10() { check("rust\tis\ngreat   and   fast"); }
#[test] fn t11() { let big: String = std::iter::repeat("x y z ").take(500).collect(); check(&big); }
#[test] fn t12() { assert_eq!(word_count("solo",0).get("solo"), Some(&1)); }
#[test] fn t13() { let m=word_count("alpha beta alpha gamma beta alpha",3); assert_eq!(m.get("alpha"),Some(&3)); assert_eq!(m.get("beta"),Some(&2)); assert_eq!(m.get("gamma"),Some(&1)); assert_eq!(m.len(),3); }
`;

const TASKS = [
  { key: 'expr', title: 'Expression evaluator', skill: 'parsing / errors / recursion',
    cargoToml: CARGO('bench'), spec: EXPR_SPEC, visible: EXPR_VISIBLE, hidden: EXPR_HIDDEN, hiddenCount: 25 },
  { key: 'lru', title: 'Generic LRU cache', skill: 'generics / trait bounds / ownership',
    cargoToml: CARGO('bench'), spec: LRU_SPEC, visible: LRU_VISIBLE, hidden: LRU_HIDDEN, hiddenCount: 18 },
  { key: 'wordcount', title: 'Parallel word count', skill: 'threads / Send+Sync / Arc-Mutex',
    cargoToml: CARGO('bench'), spec: WC_SPEC, visible: WC_VISIBLE, hidden: WC_HIDDEN, hiddenCount: 13 },
];

module.exports = { TASKS };
