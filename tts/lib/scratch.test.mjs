import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeScratch, cleanupScratch, cleanEnv } from "./scratch.mjs";

test("makeScratch copies template files", async () => {
  const tpl = await mkdtemp(join(tmpdir(), "tpl-"));
  await writeFile(join(tpl, "marker.txt"), "hi");
  const s = await makeScratch(tpl);
  await access(join(s, "marker.txt")); // throws if missing
  await cleanupScratch(s);
  await assert.rejects(() => access(join(s, "marker.txt")));
});

test("cleanEnv strips CLAUDE_* vars", () => {
  process.env.CLAUDE_TESTVAR = "leak";
  const env = cleanEnv();
  assert.equal(env.CLAUDE_TESTVAR, undefined);
  assert.equal(typeof env.PATH, "string");
});
