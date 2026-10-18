import assert from "node:assert/strict";
import { test } from "node:test";
import { clefOutputPaths, parseVerdict } from "./verdict.ts";

const REAL_SHAPE = {
  ok: true,
  kind: "blocker",
  label: "stage_regression",
  p: 0.8924,
  confident: false,
  action: "escalate",
  probabilities: {
    preexisting_flake: 0.021,
    stage_regression: 0.8924,
    contract_ambiguity: 0.051,
  },
  model: "clef",
  source: "classifier",
  ms: 2124,
  costUsd: 0.00049896,
  tokens: 2079,
};

test("parses a plain verdict line", () => {
  const verdict = parseVerdict(`${JSON.stringify(REAL_SHAPE)}\n`);
  assert.equal(verdict?.label, "stage_regression");
  assert.equal(verdict?.p, 0.8924);
  assert.equal(verdict?.action, "escalate");
  assert.equal(verdict?.kind, "blocker");
  assert.equal(verdict?.confident, false);
  assert.equal(verdict?.probabilities?.contract_ambiguity, 0.051);
});

test("parses a verdict embedded in prose and takes the last one", () => {
  const first = JSON.stringify({
    label: "preexisting_flake",
    p: 0.2,
    action: "ignore",
  });
  const second = JSON.stringify({
    label: "blocking",
    p: 0.98,
    action: "fix_now",
  });
  const verdict = parseVerdict(
    `step 1: ${first}\n\nthe classifier disagreed:\n${second}\ndone`,
  );
  assert.equal(verdict?.label, "blocking");
  assert.equal(verdict?.confident, true);
});

test("derives a label from probabilities when one is missing", () => {
  const verdict = parseVerdict(
    JSON.stringify({ probabilities: { a: 0.1, b: 0.7 }, action: "escalate" }),
  );
  assert.equal(verdict?.label, "b");
  assert.ok(Math.abs((verdict?.p ?? 0) - 0.7) < 1e-9);
  assert.equal(verdict?.confident, false);
});

test("the confident flag is keyed on p, never on the record's own claim", () => {
  // The brief gates the bubble colour on p >= 0.9; a classifier that says
  // `confident: true` below the gate must not turn the bubble green.
  const belowGate = parseVerdict(
    JSON.stringify({ label: "preexisting_flake", p: 0.4, confident: true }),
  );
  assert.equal(belowGate?.confident, false);
  const aboveGate = parseVerdict(
    JSON.stringify({ label: "blocking", p: 0.95, confident: false }),
  );
  assert.equal(aboveGate?.confident, true);
  const atGate = parseVerdict(JSON.stringify({ label: "blocking", p: 0.9 }));
  assert.equal(atGate?.confident, true);
});

test("returns undefined for non-verdict content", () => {
  assert.equal(parseVerdict(""), undefined);
  assert.equal(parseVerdict("no json here"), undefined);
  assert.equal(parseVerdict('{"label":"x"}'), undefined);
  assert.equal(parseVerdict('{"p":0.5}'), undefined);
  assert.equal(parseVerdict('{"label":"x","p":"high"}'), undefined);
  assert.equal(parseVerdict('{"label":"x","p":'), undefined);
});

test("survives braces inside strings and clamps probabilities", () => {
  const verdict = parseVerdict('{"label":"we{d}ird","p":1.4,"action":"retry"}');
  assert.equal(verdict?.label, "we{d}ird");
  assert.equal(verdict?.p, 1);
});

test("clef output paths are ordered and de-duplicated", () => {
  const paths = clefOutputPaths("/runs/abc", "abc");
  assert.deepEqual(paths, [
    "/runs/abc/output-0.log",
    "/runs/abc/subagent-log-abc.md",
  ]);
  assert.deepEqual(
    clefOutputPaths("/runs/abc", "abc", 2)[0],
    "/runs/abc/output-2.log",
  );
});
