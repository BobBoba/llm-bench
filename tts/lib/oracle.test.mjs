import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOracle } from "./oracle.mjs";

// Мини-оракул echo-типа: скрипт echo-check.sh существует в oracles/ и pass при наличии PASS-файла
test("runOracle passes when marker present, fails otherwise", async () => {
  const good = await mkdtemp(join(tmpdir(), "ok-"));
  await writeFile(join(good, "PASS"), "");
  const bad = await mkdtemp(join(tmpdir(), "no-"));
  const p = await runOracle("echo-check", good);
  const f = await runOracle("echo-check", bad);
  assert.equal(p.pass, true);
  assert.equal(f.pass, false);
});
