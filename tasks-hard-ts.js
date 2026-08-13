// ТЯЖЁЛЫЙ набор задач на TypeScript — те же три типа, что в Rust-наборе.
// Два независимых гейта, как в обычном TS-наборе: `tsc --strict` (типобезопасность) и `bun test`
// (корректность на скрытых тестах). Модель может пройти один и провалить другой.
//
// ! Каждая задача обязана проходить свои скрытые тесты эталонным решением ДО кампании.

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true, noImplicitAny: true, strictNullChecks: true,
    target: "ES2022", module: "ESNext", moduleResolution: "bundler",
    noEmit: true, skipLibCheck: true, types: [],
  },
  include: ["lib.ts"],
}, null, 2);

// ---------------------------------------------------------------------------
// 1. ПРАВКА ЧУЖОГО КОДА: хранилище состояния с историей.
// Дефект: при откате не восстанавливается счётчик версии, из-за чего последующая запись
// затирает не ту точку истории. Место не названо.
// ---------------------------------------------------------------------------
const EDIT_STARTER = `export type Action =
  | { kind: "set"; key: string; value: number }
  | { kind: "del"; key: string }
  | { kind: "clear" };

export type Snapshot = Readonly<Record<string, number>>;

/** Хранилище с журналом действий и откатом на N шагов назад. */
export class Store {
  private state: Record<string, number> = {};
  private history: Snapshot[] = [];
  private version = 0;

  getVersion(): number {
    return this.version;
  }

  snapshot(): Snapshot {
    return { ...this.state };
  }

  apply(a: Action): void {
    this.history.push({ ...this.state });
    switch (a.kind) {
      case "set":
        this.state[a.key] = a.value;
        break;
      case "del":
        delete this.state[a.key];
        break;
      case "clear":
        this.state = {};
        break;
    }
    this.version += 1;
  }

  /** Откатывает n шагов назад. Возвращает число фактически откаченных шагов. */
  undo(n: number): number {
    let done = 0;
    while (done < n && this.history.length > 0) {
      const prev = this.history.pop() as Snapshot;
      this.state = { ...prev };
      done += 1;
    }
    return done;
  }
}
`;

const EDIT_SPEC = `В файле lib.ts лежит РАБОЧИЙ класс Store — хранилище пар «строка → число» с журналом
действий и откатом.

Требуется ДВА изменения:

1. НАЙТИ И ИСПРАВИТЬ ДЕФЕКТ. В классе есть одна ошибка, из-за которой после отката номер версии
   перестаёт соответствовать состоянию. Место не указано — найдите сами. Правило простое:
   getVersion() обязан равняться числу примененных действий за вычетом откаченных, и никогда
   не быть отрицательным.

2. ДОБАВИТЬ ПОВТОР (redo):
       redo(n: number): number
   Возвращает число фактически повторённых шагов. Повторять можно только то, что было откачено
   и после чего НЕ применялось новое действие: любое новое apply() обязано обнулять возможность
   повтора (классическая семантика undo/redo в редакторах).

Публичный API ломать нельзя: сигнатуры getVersion, snapshot, apply, undo обязаны остаться
прежними, тип Action менять нельзя. Код обязан проходить tsc --strict без ошибок и без any.
Верните ПОЛНОЕ содержимое lib.ts.`;

const EDIT_VISIBLE = `import { test, expect } from "bun:test";
import { Store } from "./lib";

test("apply and snapshot", () => {
  const s = new Store();
  s.apply({ kind: "set", key: "a", value: 1 });
  expect(s.snapshot()).toEqual({ a: 1 });
  expect(s.getVersion()).toBe(1);
});
`;

const EDIT_HIDDEN = `import { test, expect } from "bun:test";
import { Store } from "./lib";

// --- регрессии ---
test("r_apply_sequence", () => {
  const s = new Store();
  s.apply({ kind: "set", key: "a", value: 1 });
  s.apply({ kind: "set", key: "b", value: 2 });
  s.apply({ kind: "del", key: "a" });
  expect(s.snapshot()).toEqual({ b: 2 });
});

test("r_clear_then_undo", () => {
  const s = new Store();
  s.apply({ kind: "set", key: "a", value: 1 });
  s.apply({ kind: "clear" });
  expect(s.snapshot()).toEqual({});
  expect(s.undo(1)).toBe(1);
  expect(s.snapshot()).toEqual({ a: 1 });
});

test("r_undo_more_than_history", () => {
  const s = new Store();
  s.apply({ kind: "set", key: "a", value: 1 });
  expect(s.undo(5)).toBe(1);
  expect(s.snapshot()).toEqual({});
});

test("r_snapshot_is_a_copy", () => {
  const s = new Store();
  s.apply({ kind: "set", key: "a", value: 1 });
  const snap = s.snapshot() as Record<string, number>;
  snap.a = 999;
  expect(s.snapshot()).toEqual({ a: 1 });
});

// --- дефект: версия обязана уменьшаться при откате ---
test("bug_version_decreases_on_undo", () => {
  const s = new Store();
  s.apply({ kind: "set", key: "a", value: 1 });
  s.apply({ kind: "set", key: "b", value: 2 });
  expect(s.getVersion()).toBe(2);
  s.undo(1);
  expect(s.getVersion()).toBe(1);
  s.undo(1);
  expect(s.getVersion()).toBe(0);
});

test("bug_version_never_negative", () => {
  const s = new Store();
  s.apply({ kind: "set", key: "a", value: 1 });
  s.undo(10);
  expect(s.getVersion()).toBe(0);
});

// --- новый повтор ---
test("n_redo_restores", () => {
  const s = new Store();
  s.apply({ kind: "set", key: "a", value: 1 });
  s.apply({ kind: "set", key: "b", value: 2 });
  s.undo(2);
  expect(s.snapshot()).toEqual({});
  expect(s.redo(2)).toBe(2);
  expect(s.snapshot()).toEqual({ a: 1, b: 2 });
  expect(s.getVersion()).toBe(2);
});

test("n_redo_partial", () => {
  const s = new Store();
  s.apply({ kind: "set", key: "a", value: 1 });
  s.apply({ kind: "set", key: "b", value: 2 });
  s.undo(2);
  expect(s.redo(1)).toBe(1);
  expect(s.snapshot()).toEqual({ a: 1 });
  expect(s.getVersion()).toBe(1);
});

test("n_new_apply_clears_redo", () => {
  const s = new Store();
  s.apply({ kind: "set", key: "a", value: 1 });
  s.apply({ kind: "set", key: "b", value: 2 });
  s.undo(1);
  s.apply({ kind: "set", key: "c", value: 3 }); // ветка повтора обязана пропасть
  expect(s.redo(1)).toBe(0);
  expect(s.snapshot()).toEqual({ a: 1, c: 3 });
});

test("n_redo_with_nothing_to_redo", () => {
  const s = new Store();
  expect(s.redo(3)).toBe(0);
  s.apply({ kind: "set", key: "a", value: 1 });
  expect(s.redo(1)).toBe(0);
});
`;

const EDIT_REFERENCE = `export type Action =
  | { kind: "set"; key: string; value: number }
  | { kind: "del"; key: string }
  | { kind: "clear" };

export type Snapshot = Readonly<Record<string, number>>;

export class Store {
  private state: Record<string, number> = {};
  private history: Snapshot[] = [];
  private future: Snapshot[] = [];
  private version = 0;

  getVersion(): number {
    return this.version;
  }

  snapshot(): Snapshot {
    return { ...this.state };
  }

  apply(a: Action): void {
    this.history.push({ ...this.state });
    this.future = [];
    switch (a.kind) {
      case "set":
        this.state[a.key] = a.value;
        break;
      case "del":
        delete this.state[a.key];
        break;
      case "clear":
        this.state = {};
        break;
    }
    this.version += 1;
  }

  undo(n: number): number {
    let done = 0;
    while (done < n && this.history.length > 0) {
      this.future.push({ ...this.state });
      const prev = this.history.pop() as Snapshot;
      this.state = { ...prev };
      this.version -= 1;
      done += 1;
    }
    return done;
  }

  redo(n: number): number {
    let done = 0;
    while (done < n && this.future.length > 0) {
      this.history.push({ ...this.state });
      const next = this.future.pop() as Snapshot;
      this.state = { ...next };
      this.version += 1;
      done += 1;
    }
    return done;
  }
}
`;

// ---------------------------------------------------------------------------
// 2. АЛГОРИТМИЧЕСКАЯ ГЛУБИНА: минимальная разница двух вложенных структур.
// ---------------------------------------------------------------------------
const ALGO_SPEC = `Реализуйте в lib.ts вычисление разницы двух значений JSON:

    export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
    export type Op =
      | { op: "add"; path: string; value: Json }
      | { op: "remove"; path: string }
      | { op: "replace"; path: string; value: Json };
    export function diff(a: Json, b: Json): Op[];
    export function apply(a: Json, ops: Op[]): Json;

Правила:
- path — указатель в стиле JSON Pointer: "" для корня, "/foo", "/foo/0/bar"; символы "~" и "/"
  внутри ключа экранируются как "~0" и "~1";
- diff обязан возвращать МИНИМАЛЬНЫЙ по числу операций набор: не переписывайте целые поддеревья,
  если изменился один лист;
- для массивов разной длины используйте add/remove по индексам; индексы в remove трактуются
  относительно состояния НА МОМЕНТ применения этой операции (как в RFC 6902);
- apply(a, diff(a, b)) обязан давать структуру, глубоко равную b, для любых a и b;
- apply не должен изменять входное значение a (никаких мутаций).

Код обязан проходить tsc --strict без any. Верните ПОЛНОЕ содержимое lib.ts.`;

const ALGO_VISIBLE = `import { test, expect } from "bun:test";
import { diff, apply } from "./lib";

test("simple leaf change", () => {
  const ops = diff({ a: 1 }, { a: 2 });
  expect(ops).toEqual([{ op: "replace", path: "/a", value: 2 }]);
  expect(apply({ a: 1 }, ops)).toEqual({ a: 2 });
});
`;

const ALGO_HIDDEN = `import { test, expect } from "bun:test";
import { diff, apply, type Json } from "./lib";

function roundtrip(a: Json, b: Json) {
  const ops = diff(a, b);
  const frozen = JSON.stringify(a);
  const got = apply(a, ops);
  expect(got).toEqual(b as never);
  expect(JSON.stringify(a)).toBe(frozen); // вход не изменён
  return ops;
}

test("h_nested_leaf_is_minimal", () => {
  const a = { x: { y: { z: 1, keep: "same" } }, other: [1, 2, 3] };
  const b = { x: { y: { z: 2, keep: "same" } }, other: [1, 2, 3] };
  const ops = roundtrip(a as Json, b as Json);
  expect(ops.length).toBe(1);
  expect(ops[0]!.path).toBe("/x/y/z");
});

test("h_add_and_remove_keys", () => {
  const ops = roundtrip({ a: 1, b: 2 } as Json, { a: 1, c: 3 } as Json);
  expect(ops.length).toBe(2);
  const kinds = ops.map((o) => o.op).sort();
  expect(kinds).toEqual(["add", "remove"]);
});

test("h_array_grow_and_shrink", () => {
  roundtrip([1, 2, 3] as Json, [1, 2, 3, 4, 5] as Json);
  roundtrip([1, 2, 3, 4, 5] as Json, [1, 2] as Json);
  roundtrip([] as Json, [7] as Json);
  roundtrip([7] as Json, [] as Json);
});

test("h_array_element_change_is_minimal", () => {
  const ops = roundtrip([1, 2, 3] as Json, [1, 9, 3] as Json);
  expect(ops.length).toBe(1);
  expect(ops[0]!.path).toBe("/1");
});

test("h_type_change_replaces", () => {
  roundtrip({ a: { b: 1 } } as Json, { a: [1] } as Json);
  roundtrip({ a: 1 } as Json, { a: null } as Json);
  roundtrip(null as Json, { a: 1 } as Json);
  roundtrip(1 as Json, "1" as Json);
});

test("h_root_replace", () => {
  const ops = roundtrip(1 as Json, 2 as Json);
  expect(ops).toEqual([{ op: "replace", path: "", value: 2 }]);
});

test("h_pointer_escaping", () => {
  const a = { "a/b": 1, "c~d": 2 } as Json;
  const b = { "a/b": 9, "c~d": 2 } as Json;
  const ops = roundtrip(a, b);
  expect(ops.length).toBe(1);
  expect(ops[0]!.path).toBe("/a~1b");
});

test("h_identical_gives_no_ops", () => {
  const a = { x: [1, { y: "z" }], n: null } as Json;
  expect(diff(a, JSON.parse(JSON.stringify(a)) as Json)).toEqual([]);
});

test("h_deep_mixed_structure", () => {
  const a = { list: [{ id: 1, tags: ["a", "b"] }, { id: 2, tags: [] }], meta: { v: 1 } } as Json;
  const b = { list: [{ id: 1, tags: ["a", "c"] }], meta: { v: 2, extra: true } } as Json;
  roundtrip(a, b);
});
`;

const ALGO_REFERENCE = `export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Op =
  | { op: "add"; path: string; value: Json }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: Json };

function esc(k: string): string {
  return k.replace(/~/g, "~0").replace(/\\//g, "~1");
}
function isObj(v: Json): v is { [k: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function clone(v: Json): Json {
  return JSON.parse(JSON.stringify(v)) as Json;
}
function same(a: Json, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function walk(a: Json, b: Json, path: string, out: Op[]): void {
  if (same(a, b)) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) walk(a[i]!, b[i]!, path + "/" + i, out);
    for (let i = a.length; i < b.length; i++) out.push({ op: "add", path: path + "/" + i, value: clone(b[i]!) });
    for (let i = a.length - 1; i >= b.length; i--) out.push({ op: "remove", path: path + "/" + i });
    return;
  }
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) {
      if (!(k in b)) out.push({ op: "remove", path: path + "/" + esc(k) });
    }
    for (const k of Object.keys(b)) {
      if (!(k in a)) out.push({ op: "add", path: path + "/" + esc(k), value: clone(b[k]!) });
      else walk(a[k]!, b[k]!, path + "/" + esc(k), out);
    }
    return;
  }
  out.push({ op: "replace", path, value: clone(b) });
}

export function diff(a: Json, b: Json): Op[] {
  const out: Op[] = [];
  walk(a, b, "", out);
  return out;
}

function unesc(t: string): string {
  return t.replace(/~1/g, "/").replace(/~0/g, "~");
}
function parts(path: string): string[] {
  return path === "" ? [] : path.split("/").slice(1).map(unesc);
}

export function apply(a: Json, ops: Op[]): Json {
  let root = clone(a);
  for (const o of ops) {
    const ps = parts(o.path);
    if (ps.length === 0) {
      if (o.op === "remove") { root = null; continue; }
      root = clone((o as { value: Json }).value);
      continue;
    }
    let cur: Json = root;
    for (let i = 0; i < ps.length - 1; i++) {
      const seg = ps[i]!;
      cur = Array.isArray(cur) ? cur[Number(seg)]! : (cur as { [k: string]: Json })[seg]!;
    }
    const last = ps[ps.length - 1]!;
    if (Array.isArray(cur)) {
      const idx = Number(last);
      if (o.op === "remove") cur.splice(idx, 1);
      else if (o.op === "add") cur.splice(idx, 0, clone(o.value));
      else cur[idx] = clone(o.value);
    } else {
      const obj = cur as { [k: string]: Json };
      if (o.op === "remove") delete obj[last];
      else obj[last] = clone((o as { value: Json }).value);
    }
  }
  return root;
}
`;

// ---------------------------------------------------------------------------
// 3. СОГЛАСОВАННОСТЬ: планировщик с ограничением параллелизма и отменой.
// ---------------------------------------------------------------------------
const CONC_SPEC = `Реализуйте в lib.ts планировщик задач с ограничением параллелизма и отменой:

    export interface RunOptions { limit: number; signal?: AbortSignal }
    export function runAll<T>(tasks: ReadonlyArray<() => Promise<T>>, opts: RunOptions):
      Promise<Array<{ status: "ok"; value: T } | { status: "err"; reason: unknown }
                   | { status: "skipped" }>>;

Правила:
- одновременно выполняется не более opts.limit задач; следующая стартует сразу, как только
  освобождается место (не «волнами» по limit штук);
- результат возвращается в ПОРЯДКЕ ИСХОДНОГО МАССИВА, независимо от порядка завершения;
- упавшая задача не отменяет остальные: она даёт { status: "err", reason };
- если signal уже прерван или прерывается по ходу — задачи, которые ЕЩЁ НЕ БЫЛИ ЗАПУЩЕНЫ,
  получают { status: "skipped" }; уже запущенные доводятся до конца и дают свой результат;
- функция никогда не отклоняется (не reject) и не оставляет необработанных отклонений;
- limit >= 1; при пустом массиве задач возвращается пустой массив.

Код обязан проходить tsc --strict без any. Верните ПОЛНОЕ содержимое lib.ts.`;

const CONC_VISIBLE = `import { test, expect } from "bun:test";
import { runAll } from "./lib";

test("runs all and keeps order", async () => {
  const r = await runAll([
    async () => 1,
    async () => 2,
  ], { limit: 1 });
  expect(r).toEqual([{ status: "ok", value: 1 }, { status: "ok", value: 2 }]);
});
`;

const CONC_HIDDEN = `import { test, expect } from "bun:test";
import { runAll } from "./lib";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("h_order_preserved_despite_completion_order", async () => {
  const r = await runAll([
    async () => { await sleep(40); return "slow"; },
    async () => { await sleep(1); return "fast"; },
  ], { limit: 2 });
  expect(r).toEqual([{ status: "ok", value: "slow" }, { status: "ok", value: "fast" }]);
});

test("h_limit_is_respected_and_saturated", async () => {
  let cur = 0;
  let peak = 0;
  const mk = () => async () => {
    cur += 1; peak = Math.max(peak, cur);
    await sleep(20);
    cur -= 1;
    return 0;
  };
  const t0 = Date.now();
  await runAll(Array.from({ length: 9 }, mk), { limit: 3 });
  const ms = Date.now() - t0;
  expect(peak).toBe(3);
  // 9 задач по 20 мс при пределе 3 — около 60 мс; «волнами» вышло бы столько же,
  // поэтому проверяем ещё и насыщение: не должно быть заметно дольше
  expect(ms).toBeLessThan(200);
});

test("h_failure_does_not_stop_others", async () => {
  const r = await runAll([
    async () => { throw new Error("boom"); },
    async () => 2,
  ], { limit: 2 });
  expect(r[0]!.status).toBe("err");
  expect(r[1]).toEqual({ status: "ok", value: 2 });
});

test("h_already_aborted_skips_everything", async () => {
  const ac = new AbortController();
  ac.abort();
  let started = 0;
  const r = await runAll([
    async () => { started += 1; return 1; },
    async () => { started += 1; return 2; },
  ], { limit: 2, signal: ac.signal });
  expect(started).toBe(0);
  expect(r).toEqual([{ status: "skipped" }, { status: "skipped" }]);
});

test("h_abort_midway_skips_unstarted_only", async () => {
  const ac = new AbortController();
  const started: number[] = [];
  const tasks = Array.from({ length: 6 }, (_, i) => async () => {
    started.push(i);
    await sleep(30);
    return i;
  });
  const p = runAll(tasks, { limit: 2, signal: ac.signal });
  await sleep(10);
  ac.abort();
  const r = await p;
  // первые две успели стартовать и обязаны довестись до конца
  expect(r[0]).toEqual({ status: "ok", value: 0 });
  expect(r[1]).toEqual({ status: "ok", value: 1 });
  for (let i = 2; i < 6; i++) expect(r[i]).toEqual({ status: "skipped" });
  expect(started).toEqual([0, 1]);
});

test("h_empty_and_limit_one", async () => {
  expect(await runAll([], { limit: 3 })).toEqual([]);
  const seq: number[] = [];
  const r = await runAll([
    async () => { seq.push(1); await sleep(5); return 1; },
    async () => { seq.push(2); return 2; },
  ], { limit: 1 });
  expect(seq).toEqual([1, 2]); // строго последовательно
  expect(r.length).toBe(2);
});

test("h_never_rejects_on_sync_throw", async () => {
  const r = await runAll([
    (() => { throw new Error("sync"); }) as unknown as () => Promise<number>,
    async () => 5,
  ], { limit: 2 });
  expect(r[0]!.status).toBe("err");
  expect(r[1]).toEqual({ status: "ok", value: 5 });
});
`;

const CONC_REFERENCE = `export interface RunOptions { limit: number; signal?: AbortSignal }
export type Outcome<T> =
  | { status: "ok"; value: T }
  | { status: "err"; reason: unknown }
  | { status: "skipped" };

export function runAll<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  opts: RunOptions,
): Promise<Array<Outcome<T>>> {
  const limit = Math.max(1, opts.limit);
  const out: Array<Outcome<T>> = new Array(tasks.length);
  let next = 0;
  return new Promise((resolve) => {
    if (tasks.length === 0) { resolve([]); return; }
    let active = 0;
    let finished = 0;
    const done = () => {
      finished += 1;
      if (finished === tasks.length) resolve(out);
    };
    const pump = (): void => {
      while (active < limit && next < tasks.length) {
        const i = next++;
        if (opts.signal?.aborted) { out[i] = { status: "skipped" }; done(); continue; }
        active += 1;
        let p: Promise<T>;
        try {
          p = tasks[i]!();
        } catch (e) {
          out[i] = { status: "err", reason: e };
          active -= 1;
          done();
          continue;
        }
        Promise.resolve(p).then(
          (v) => { out[i] = { status: "ok", value: v }; },
          (e) => { out[i] = { status: "err", reason: e }; },
        ).then(() => { active -= 1; done(); pump(); });
      }
    };
    pump();
  });
}
`;

const TASKS = [
  { key: 'edit', kind: 'edit', lang: 'ts', tsconfig: TSCONFIG,
    spec: EDIT_SPEC, starter: EDIT_STARTER, visible: EDIT_VISIBLE,
    hidden: EDIT_HIDDEN, reference: EDIT_REFERENCE },
  { key: 'algo', kind: 'algo', lang: 'ts', tsconfig: TSCONFIG,
    spec: ALGO_SPEC, starter: '', visible: ALGO_VISIBLE,
    hidden: ALGO_HIDDEN, reference: ALGO_REFERENCE },
  { key: 'conc', kind: 'conc', lang: 'ts', tsconfig: TSCONFIG,
    spec: CONC_SPEC, starter: '', visible: CONC_VISIBLE,
    hidden: CONC_HIDDEN, reference: CONC_REFERENCE },
];

module.exports = { TASKS };
