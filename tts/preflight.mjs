#!/usr/bin/env node
// Preflight discovery script for the omp-vs-pi time-to-solution benchmark.
//
// WHY THIS EXISTS: before writing a parser that depends on the exact shape of
// `--mode json` output from omp and pi, we removed every unknown empirically
// (real network calls against OpenRouter, real CLI flags, real session files).
// This script re-runs those same probes so the discovery in CONTRACT.md stays
// reproducible. It does NOT replace CONTRACT.md -- CONTRACT.md is the
// authoritative, human-curated record of what was found; this script is the
// mechanism used to find it (and to re-verify it later, e.g. after a harness
// upgrade changes the JSON shape).
//
// Usage: node preflight.mjs [step1] [step2] [step2b] [step2c] [step3]
//   No args = run every step (full re-verification, matches CONTRACT.md end
//   to end). Passing one or more step names runs only those steps against a
//   freshly created scratch dir -- useful to cheaply re-check a single
//   finding (e.g. `node preflight.mjs step2c`) without re-paying for the
//   expensive step3 slug checks (sonnet/opus calls).
//
// Cost: a handful of cheap OpenRouter calls (claude-haiku-4.5 mostly), a few
// cents total for a single step; running all steps (step3 included) costs
// more because it exercises sonnet-4.5/sonnet-5/opus-4.8. Auth is read by
// omp/pi themselves from their own config/.env -- this script never touches
// API keys and never prints secret values.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");

// omp is a Bun-installed global symlink; pi is the upstream CLI installed via
// nvm/npm. `pi` also exists as an interactive zsh shell function in the user's
// shell profile -- when invoking from a script we always call the resolved
// binary path below, never the bare `pi` command, otherwise the shell
// function (not the real CLI) would run.
const OMP = path.join(process.env.HOME, ".bun/bin/omp");
const PI = path.join(process.env.HOME, ".nvm/versions/node/v24.10.0/bin/pi");

function run(label, cmd, args, opts = {}) {
  console.log(`\n=== ${label} ===`);
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 120_000,
    cwd: opts.cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    console.log(`  spawn error: ${res.error.message}`);
  }
  console.log(`  exit=${res.status} stdout_bytes=${(res.stdout || "").length} stderr_bytes=${(res.stderr || "").length}`);
  return res;
}

function lastAgentEndUsage(stdout) {
  const lines = stdout.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (obj.type === "agent_end" && Array.isArray(obj.messages)) {
      const last = obj.messages[obj.messages.length - 1];
      return last && last.usage;
    }
  }
  return null;
}

function step1_capture(D) {
  console.log("\n########## STEP 1: cheap probe, capture raw JSON to fixtures/ ##########");
  mkdirSync(FIXTURES, { recursive: true });

  const ompRes = run(
    "omp probe (claude-haiku-4.5)",
    OMP,
    ["--model", "openrouter/anthropic/claude-haiku-4.5", "--cwd", D, "--mode", "json", "--no-session", "-p", "Reply with exactly: OK"]
  );
  writeFileSync(path.join(FIXTURES, "omp-sample.json"), ompRes.stdout || "");
  writeFileSync(path.join(FIXTURES, "omp-sample.err"), ompRes.stderr || "");

  // IMPORTANT: pi has NO --cwd flag (unlike omp). It always operates in the
  // process's own cwd. To point it at a scratch directory you must `cd`
  // there before invoking it (spawnSync `cwd` option), not pass a flag.
  const piRes = run(
    "pi probe (claude-haiku-4.5)",
    PI,
    ["--model", "openrouter/anthropic/claude-haiku-4.5", "--mode", "json", "--no-session", "--approve", "-p", "Reply with exactly: OK"],
    { cwd: D }
  );
  writeFileSync(path.join(FIXTURES, "pi-sample.json"), piRes.stdout || "");
  writeFileSync(path.join(FIXTURES, "pi-sample.err"), piRes.stderr || "");

  console.log(`\nomp fixture bytes: ${(ompRes.stdout || "").length}`);
  console.log(`pi  fixture bytes: ${(piRes.stdout || "").length}`);

  const ompUsage = lastAgentEndUsage(ompRes.stdout || "");
  const piUsage = lastAgentEndUsage(piRes.stdout || "");
  console.log("omp last-message usage:", JSON.stringify(ompUsage));
  console.log("pi  last-message usage:", JSON.stringify(piUsage));
}

function step2_continue(D) {
  console.log("\n########## STEP 2: session-dir + continue mechanism ##########");

  const sOmp = path.join(D, "s-omp");
  const sPi = path.join(D, "s-pi");
  mkdirSync(sOmp, { recursive: true });
  mkdirSync(sPi, { recursive: true });

  // omp: --session-dir DIR ... -p "..."   then   --session-dir DIR --continue --mode json -p "..."
  run("omp turn 1 (session-dir)", OMP, ["--model", "openrouter/anthropic/claude-haiku-4.5", "--cwd", D, "--session-dir", sOmp, "--mode", "json", "-p", "Remember the secret word: PINEAPPLE. Reply OK."]);
  const ompCont = run("omp turn 2 (--continue)", OMP, ["--session-dir", sOmp, "--continue", "--mode", "json", "-p", "What was the secret word?"]);
  const recalledOmp = (ompCont.stdout || "").includes("PINEAPPLE");
  console.log(`omp recalled secret word across --continue: ${recalledOmp}`);

  // pi: same shape, plus --approve, and cwd via spawn option (no --cwd flag).
  run("pi turn 1 (session-dir)", PI, ["--model", "openrouter/anthropic/claude-haiku-4.5", "--session-dir", sPi, "--mode", "json", "--approve", "-p", "Remember the secret word: MANGOSTEEN. Reply OK."], { cwd: D });
  const piCont = run("pi turn 2 (--continue)", PI, ["--session-dir", sPi, "--continue", "--mode", "json", "--approve", "-p", "What was the secret word?"], { cwd: D });
  const recalledPi = (piCont.stdout || "").includes("MANGOSTEEN");
  console.log(`pi recalled secret word across --continue: ${recalledPi}`);

  return { recalledOmp, recalledPi };
}

function step2b_pi_approve_edit(D) {
  console.log("\n########## STEP 2b: pi -p --approve file-edit (no interactive hang) ##########");
  const res = run("pi create file (--approve)", PI, ["--mode", "json", "--no-session", "--approve", "-p", "create file z.txt with the text hi"], { cwd: D });
  const created = existsSync(path.join(D, "z.txt"));
  console.log(`z.txt created without hanging: ${created}`);
  if (created) {
    console.log(`z.txt contents: ${JSON.stringify(readFileSync(path.join(D, "z.txt"), "utf8"))}`);
  }
  return created;
}

function step2c_omp_tool_call(D) {
  // Parity check with step2b: does omp also produce a second turn_start/
  // turn_end pair when the model makes a tool call, same as pi did? This is
  // what backs the "verified on both harnesses" claim in CONTRACT.md section
  // 1 -- without this probe, only pi's tool-call turn-pair behavior had an
  // executable check in this script.
  console.log("\n########## STEP 2c: omp tool-call turn-pair probe (parity check with step 2b) ##########");
  const sub = path.join(D, "omp-edit");
  mkdirSync(sub, { recursive: true });
  const res = run(
    "omp create file (tool-call probe)",
    OMP,
    ["--model", "openrouter/anthropic/claude-haiku-4.5", "--cwd", sub, "--mode", "json", "--no-session", "-p", "create file z.txt with the text hi"]
  );
  const created = existsSync(path.join(sub, "z.txt"));
  const lines = (res.stdout || "").split("\n").filter(Boolean);
  let turnEndCount = 0;
  for (const l of lines) {
    try {
      if (JSON.parse(l).type === "turn_end") turnEndCount++;
    } catch {
      // ignore unparseable line
    }
  }
  console.log(`z.txt created without hanging: ${created}, turn_end count: ${turnEndCount}`);
  return { created, turnEndCount };
}

function step3_slugs(D) {
  console.log("\n########## STEP 3: confirm OpenRouter slugs ##########");
  const candidates = [
    "deepseek/deepseek-v3.2",
    "deepseek/deepseek-v4-pro",
    "anthropic/claude-sonnet-4.5",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-opus-4.8",
    "anthropic/claude-haiku-4.5",
  ];
  const results = {};
  for (const m of candidates) {
    const res = run(`slug check: ${m}`, OMP, ["--model", `openrouter/${m}`, "--cwd", D, "--mode", "json", "--no-session", "-p", "Reply: OK"]);
    const usage = lastAgentEndUsage(res.stdout || "");
    const ok = res.status === 0 && !!usage;
    results[m] = { ok, cost: usage && usage.cost && usage.cost.total };
    console.log(`  -> ${m}: ok=${ok} cost=${results[m].cost}`);
  }
  return results;
}

function main() {
  const requested = process.argv.slice(2);
  const runAll = requested.length === 0;
  const want = (name) => runAll || requested.includes(name);

  const D = mkdtempSync(path.join(tmpdir(), "tts-preflight-"));

  const summary = {};
  if (want("step1")) step1_capture(D);
  if (want("step2")) summary.contResult = step2_continue(D);
  if (want("step2b")) summary.piEditResult = step2b_pi_approve_edit(D);
  if (want("step2c")) summary.ompToolCallResult = step2c_omp_tool_call(D);
  if (want("step3")) summary.slugResults = step3_slugs(D);

  console.log("\n########## SUMMARY ##########");
  console.log(JSON.stringify(summary, null, 2));
  console.log("\nSee tts/CONTRACT.md for the curated findings (JSON key paths, gotchas).");
  console.log(`Scratch dir used: ${D} (not auto-deleted; rm -rf it yourself if desired)`);
}

main();
