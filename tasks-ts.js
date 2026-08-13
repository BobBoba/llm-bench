// Task definitions for the TypeScript code-gen benchmark (sibling of tasks-rust.js).
// Each task fixes an EXACT public API. Models get the spec + a few VISIBLE example
// tests; scoring uses a larger HIDDEN suite run with `bun test`. A separate `tsc
// --strict` pass is the type-soundness gate (the TS analogue of `cargo build`).
//
// Tasks are chosen to exercise TypeScript-specific skill, not just "algorithms":
//   1. expr      — parsing + DISCRIMINATED-UNION result type + recursion
//   2. lru       — GENERICS + trait-like constraints + Map + strict-null
//   3. asyncpool — async/await + Promise CONCURRENCY control + generics + ordering
// All are single-file, std-lib only (no npm deps), so the temp project builds instantly.

// ---------------------------------------------------------------------------
// Task 1 — arithmetic expression evaluator
//   Skill: recursive-descent parsing, discriminated unions, exhaustive errors.
//   The Result union (not exceptions) forces correct TS type-narrowing.
// ---------------------------------------------------------------------------
const EXPR_SPEC = `Implement a small arithmetic expression evaluator in TypeScript (no external packages, standard library only).

Define EXACTLY this public API in lib.ts (names, types and signatures must match exactly):

    export type EvalResult =
      | { ok: true; value: number }
      | { ok: false; error: "DivisionByZero" | "SyntaxError" };

    export function evaluate(input: string): EvalResult;

Requirements:
- Support binary operators + - * / with usual precedence (* and / bind tighter than + and -), left-associative.
- Support parentheses ( ) for grouping.
- Support unary plus and unary minus (e.g. "-5", "2*-3").
- Support integer and decimal numbers (e.g. "3", "3.5"). No exponent notation required.
- Ignore ASCII whitespace anywhere between tokens.
- Division by zero returns { ok: false, error: "DivisionByZero" }.
- Any malformed input (empty, trailing operator, unbalanced parens, unknown characters, two numbers in a row, etc.) returns { ok: false, error: "SyntaxError" }.
- The code MUST pass \`tsc --strict\` with no implicit any and no type errors.

Example behaviour:
    evaluate("2 + 3 * 4")   => { ok: true, value: 14 }
    evaluate("(2 + 3) * 4") => { ok: true, value: 20 }
    evaluate("10 / 4")      => { ok: true, value: 2.5 }
    evaluate("2 * -3")      => { ok: true, value: -6 }
    evaluate("1 / 0")       => { ok: false, error: "DivisionByZero" }
    evaluate("1 +")         => { ok: false, error: "SyntaxError" }

Return ONLY the full contents of lib.ts. Do not include explanations or markdown fences.`;

const EXPR_VISIBLE = `import { expect, test } from "bun:test";
import { evaluate } from "./lib";
test("v1", () => expect(evaluate("2 + 3 * 4")).toEqual({ ok: true, value: 14 }));
test("v2", () => expect(evaluate("(2 + 3) * 4")).toEqual({ ok: true, value: 20 }));
test("v3", () => expect(evaluate("2 * -3")).toEqual({ ok: true, value: -6 }));
test("v4", () => expect(evaluate("1 / 0")).toEqual({ ok: false, error: "DivisionByZero" }));
test("v5", () => expect(evaluate("1 +")).toEqual({ ok: false, error: "SyntaxError" }));
`;

const EXPR_HIDDEN = `import { expect, test } from "bun:test";
import { evaluate } from "./lib";
// ok(): assert a numeric result within a tiny epsilon (double math).
function ok(s: string, v: number) {
  const r = evaluate(s);
  expect(r.ok).toBe(true);
  if (r.ok) expect(Math.abs(r.value - v) < 1e-9).toBe(true);
}
function dz(s: string) { expect(evaluate(s)).toEqual({ ok: false, error: "DivisionByZero" }); }
function se(s: string) { expect(evaluate(s)).toEqual({ ok: false, error: "SyntaxError" }); }
test("t01", () => ok("1+2", 3));
test("t02", () => ok("2+3*4", 14));
test("t03", () => ok("(2+3)*4", 20));
test("t04", () => ok("10/4", 2.5));
test("t05", () => ok("-5+3", -2));
test("t06", () => ok("2*-3", -6));
test("t07", () => ok("3.5*2", 7));
test("t08", () => ok("((1+2)*(3+4))", 21));
test("t09", () => ok("  7  -  2  ", 5));
test("t10", () => ok("2-3-4", -5));
test("t11", () => ok("100", 100));
test("t12", () => ok("2+2*2-1", 5));
test("t13", () => ok("-(3+4)", -7));
test("t14", () => ok("8/2/2", 2));
test("t15", () => ok("1.5+1.5", 3));
test("t16", () => dz("1/0"));
test("t17", () => dz("2/(3-3)"));
test("t18", () => se(""));
test("t19", () => se("1+"));
test("t20", () => se("(1+2"));
test("t21", () => se("1+*2"));
test("t22", () => se("abc"));
test("t23", () => se("2 2"));
test("t24", () => se("3+4)"));
test("t25", () => se("*5"));
`;

// ---------------------------------------------------------------------------
// Task 2 — generic LRU cache
//   Skill: generics with key constraints, Map, insertion-order semantics,
//   strict-null (get returns V | undefined, never null-vs-undefined confusion).
// ---------------------------------------------------------------------------
const LRU_SPEC = `Implement a generic Least-Recently-Used (LRU) cache in TypeScript (no external packages).

Define EXACTLY this public API in lib.ts (names, types and signatures must match exactly):

    export class LRUCache<K, V> {
      constructor(capacity: number);
      get(key: K): V | undefined;
      put(key: K, value: V): void;
      size(): number;
      isEmpty(): boolean;
    }

Semantics:
- Holds at most \`capacity\` entries.
- put(k, v): if k exists, update its value; otherwise insert. Either way k becomes most-recently-used. If inserting a NEW key would exceed capacity, evict the least-recently-used entry first.
- get(k): returns the value if present and marks k most-recently-used; otherwise returns undefined.
- A capacity of 0 (or negative) means the cache never stores anything.
- size() is the current number of entries; isEmpty() is size()===0.
- Keys are compared by value for primitives (number/string), i.e. use a Map internally.
- The code MUST pass \`tsc --strict\` with no implicit any and no type errors.

Example behaviour:
    const c = new LRUCache<number, string>(2);
    c.put(1, "a"); c.put(2, "b");
    c.get(1);            // touches 1 -> most recent
    c.put(3, "c");       // evicts 2 (least recent)
    c.get(2);            // undefined
    c.get(1);            // "a"
    c.get(3);            // "c"

Return ONLY the full contents of lib.ts. Do not include explanations or markdown fences.`;

const LRU_VISIBLE = `import { expect, test } from "bun:test";
import { LRUCache } from "./lib";
test("v1", () => {
  const c = new LRUCache<number, string>(2);
  c.put(1, "a"); c.put(2, "b");
  expect(c.get(1)).toBe("a");
  c.put(3, "c");              // evicts 2
  expect(c.get(2)).toBeUndefined();
  expect(c.get(3)).toBe("c");
});
test("v2", () => {
  const c = new LRUCache<number, string>(2);
  c.put(1, "a"); c.put(1, "b");
  expect(c.get(1)).toBe("b");
  expect(c.size()).toBe(1);
});
`;

const LRU_HIDDEN = `import { expect, test } from "bun:test";
import { LRUCache } from "./lib";
test("t01", () => { const c = new LRUCache<number,string>(2); c.put(1,"a"); c.put(2,"b"); expect(c.get(1)).toBe("a"); expect(c.get(2)).toBe("b"); });
test("t02", () => { const c = new LRUCache<number,string>(2); c.put(1,"a"); c.put(2,"b"); c.put(3,"c"); expect(c.get(1)).toBeUndefined(); expect(c.get(2)).toBe("b"); expect(c.get(3)).toBe("c"); });
test("t03", () => { const c = new LRUCache<number,string>(2); c.put(1,"a"); c.put(2,"b"); c.get(1); c.put(3,"c"); expect(c.get(2)).toBeUndefined(); expect(c.get(1)).toBe("a"); expect(c.get(3)).toBe("c"); });
test("t04", () => { const c = new LRUCache<number,string>(2); c.put(1,"a"); c.put(1,"b"); expect(c.get(1)).toBe("b"); expect(c.size()).toBe(1); });
test("t05", () => { const c = new LRUCache<number,string>(2); c.put(1,"a"); c.put(2,"b"); c.put(1,"x"); c.put(3,"c"); expect(c.get(2)).toBeUndefined(); expect(c.get(1)).toBe("x"); expect(c.get(3)).toBe("c"); });
test("t06", () => { const c = new LRUCache<number,number>(3); expect(c.isEmpty()).toBe(true); c.put(1,10); expect(c.isEmpty()).toBe(false); expect(c.size()).toBe(1); });
test("t07", () => { const c = new LRUCache<number,string>(1); c.put(1,"a"); c.put(2,"b"); expect(c.get(1)).toBeUndefined(); expect(c.get(2)).toBe("b"); });
test("t08", () => { const c = new LRUCache<number,number>(0); c.put(1,1); expect(c.size()).toBe(0); expect(c.get(1)).toBeUndefined(); });
test("t09", () => { const c = new LRUCache<string,number>(2); c.put("x",1); c.put("y",2); expect(c.get("x")).toBe(1); });
test("t10", () => { const c = new LRUCache<number,number>(3); for (let i=0;i<3;i++) c.put(i,i*i); expect(c.size()).toBe(3); expect(c.get(2)).toBe(4); });
test("t11", () => { const c = new LRUCache<number,number>(3); for (let i=0;i<5;i++) c.put(i,i); expect(c.size()).toBe(3); expect(c.get(0)).toBeUndefined(); expect(c.get(1)).toBeUndefined(); expect(c.get(4)).toBe(4); });
test("t12", () => { const c = new LRUCache<number,string>(2); c.put(1,"a"); c.put(2,"b"); c.get(1); c.get(2); c.put(3,"c"); expect(c.get(1)).toBeUndefined(); });
test("t13", () => { const c = new LRUCache<number,number>(2); expect(c.get(99)).toBeUndefined(); });
test("t14", () => { const c = new LRUCache<number,string>(2); c.put(1,"a"); c.put(1,"a"); c.put(1,"a"); expect(c.size()).toBe(1); });
test("t15", () => { const c = new LRUCache<number,number>(4); for (let i=0;i<4;i++) c.put(i,i); c.get(0); c.put(4,4); expect(c.get(1)).toBeUndefined(); expect(c.get(0)).toBe(0); });
test("t16", () => { const c = new LRUCache<number,number>(2); c.put(10,100); expect(c.get(10)).toBe(100); });
test("t17", () => { const c = new LRUCache<number,string>(3); c.put(1,"a"); c.put(2,"b"); c.put(3,"c"); c.put(2,"B"); c.put(4,"d"); expect(c.get(1)).toBeUndefined(); expect(c.get(2)).toBe("B"); });
test("t18", () => { const c = new LRUCache<number,number[]>(2); c.put(1,[1,2,3]); expect(c.get(1)).toEqual([1,2,3]); });
`;

// ---------------------------------------------------------------------------
// Task 3 — bounded-concurrency async map (the "everyday TS" primitive)
//   Skill: async/await, Promise scheduling, a real concurrency cap, generics,
//   ORDER preservation, and error propagation. Replaces RUST's thread task —
//   in TS the daily-relevant concurrency problem is limiting parallel promises.
// ---------------------------------------------------------------------------
const POOL_SPEC = `Implement a bounded-concurrency async map in TypeScript (no external packages).

Define EXACTLY this public API in lib.ts (names, types and signatures must match exactly):

    export function mapLimit<T, R>(
      items: readonly T[],
      limit: number,
      fn: (item: T, index: number) => Promise<R>
    ): Promise<R[]>;

Semantics:
- Applies \`fn\` to every item and resolves to an array of results in the SAME ORDER as \`items\` (result[i] corresponds to items[i]), regardless of the order in which the promises settle.
- At most \`limit\` invocations of \`fn\` may be in-flight (pending) at any moment. As soon as one settles, the next queued item should start.
- If \`limit\` is 0 or negative, treat it as 1.
- An empty \`items\` array resolves to [].
- If any \`fn\` call rejects, the returned promise rejects with that error (the FIRST rejection observed). It is acceptable for already-started calls to continue, but no NEW calls should be started after a rejection.
- Do not use any external package; use only Promises / async-await.
- The code MUST pass \`tsc --strict\` with no implicit any and no type errors.

Example behaviour:
    const out = await mapLimit([1,2,3,4], 2, async (n) => n * 10);
    // out === [10, 20, 30, 40]
    await mapLimit([], 4, async (x) => x);   // []

Return ONLY the full contents of lib.ts. Do not include explanations or markdown fences.`;

const POOL_VISIBLE = `import { expect, test } from "bun:test";
import { mapLimit } from "./lib";
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
test("v1 order preserved", async () => {
  const out = await mapLimit([1,2,3,4], 2, async (n) => { await delay(1); return n * 10; });
  expect(out).toEqual([10,20,30,40]);
});
test("v2 empty", async () => {
  expect(await mapLimit<number, number>([], 3, async (x) => x)).toEqual([]);
});
`;

const POOL_HIDDEN = `import { expect, test } from "bun:test";
import { mapLimit } from "./lib";
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Instrumented fn: tracks peak concurrency so the limit can be verified objectively.
function tracker() {
  let inFlight = 0, peak = 0, calls = 0;
  const fn = async (n: number) => { calls++; inFlight++; peak = Math.max(peak, inFlight); await delay(5); inFlight--; return n * 2; };
  return { fn, peak: () => peak, calls: () => calls };
}

test("t01 order preserved under jitter", async () => {
  const out = await mapLimit([0,1,2,3,4,5], 3, async (n) => { await delay((6 - n) * 3); return n; });
  expect(out).toEqual([0,1,2,3,4,5]);
});
test("t02 results are mapped values", async () => {
  const out = await mapLimit([1,2,3,4,5], 2, async (n) => n * n);
  expect(out).toEqual([1,4,9,16,25]);
});
test("t03 concurrency never exceeds limit", async () => {
  const t = tracker();
  await mapLimit([1,2,3,4,5,6,7,8,9,10], 3, t.fn);
  expect(t.peak()).toBeLessThanOrEqual(3);
});
test("t04 concurrency actually reaches limit", async () => {
  const t = tracker();
  await mapLimit([1,2,3,4,5,6,7,8,9,10], 4, t.fn);
  expect(t.peak()).toBe(4);
});
test("t05 every item processed exactly once", async () => {
  const t = tracker();
  const out = await mapLimit([1,2,3,4,5,6,7], 2, t.fn);
  expect(t.calls()).toBe(7);
  expect(out.length).toBe(7);
});
test("t06 empty input", async () => {
  expect(await mapLimit<number, number>([], 5, async (x) => x)).toEqual([]);
});
test("t07 limit 0 treated as 1", async () => {
  const t = tracker();
  await mapLimit([1,2,3,4], 0, t.fn);
  expect(t.peak()).toBe(1);
});
test("t08 negative limit treated as 1", async () => {
  const t = tracker();
  await mapLimit([1,2,3], -5, t.fn);
  expect(t.peak()).toBe(1);
});
test("t09 limit larger than items", async () => {
  const t = tracker();
  const out = await mapLimit([1,2,3], 100, t.fn);
  expect(out).toEqual([2,4,6]);
  expect(t.peak()).toBeLessThanOrEqual(3);
});
test("t10 index is passed", async () => {
  const out = await mapLimit(["a","b","c"], 2, async (s, i) => s + i);
  expect(out).toEqual(["a0","b1","c2"]);
});
test("t11 single item", async () => {
  expect(await mapLimit([42], 3, async (n) => n + 1)).toEqual([43]);
});
test("t12 rejection propagates", async () => {
  await expect(mapLimit([1,2,3,4], 2, async (n) => { if (n === 3) throw new Error("boom"); await delay(2); return n; })).rejects.toThrow("boom");
});
`;

const CONFIG_TS = `{
  "compilerOptions": {
    "strict": true,
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "noEmit": true,
    "skipLibCheck": true,
    "lib": ["ES2020", "DOM"],
    "types": []
  },
  "include": ["lib.ts"]
}
`;

const TASKS = [
  { key: 'expr', title: 'Expression evaluator', skill: 'parsing / discriminated unions / recursion',
    spec: EXPR_SPEC, visible: EXPR_VISIBLE, hidden: EXPR_HIDDEN, hiddenCount: 25, tsconfig: CONFIG_TS },
  { key: 'lru', title: 'Generic LRU cache', skill: 'generics / Map / strict-null',
    spec: LRU_SPEC, visible: LRU_VISIBLE, hidden: LRU_HIDDEN, hiddenCount: 18, tsconfig: CONFIG_TS },
  { key: 'asyncpool', title: 'Bounded-concurrency async map', skill: 'async / Promise concurrency / generics',
    spec: POOL_SPEC, visible: POOL_VISIBLE, hidden: POOL_HIDDEN, hiddenCount: 12, tsconfig: CONFIG_TS },
];

module.exports = { TASKS };
