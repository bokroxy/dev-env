import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLEF_MODELS,
  formatJudgment,
  presetInputDoc,
  resolveModelRef,
  runJudge,
  runRawClassify,
  toDecisionRecord,
  trimText,
  type ClefBackend,
} from "./clef.ts";

type Call = {
  provider: string;
  id: string;
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
};

function fakeBackend(
  probabilities: Record<string, number> | (() => never),
  options: { stopReason?: "stop" | "error" } = {},
) {
  const calls: Call[] = [];
  let concurrent = 0;
  let peak = 0;
  const backend: ClefBackend = {
    classify: async (ref, context) => {
      calls.push({
        ...ref,
        state: context.state,
        questions: context.questions,
      });
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent--;
      if (typeof probabilities === "function") probabilities();
      const probs = probabilities as Record<string, number>;
      const choice = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
      return {
        api: "cloudflare-workers-ai-system-one",
        provider: ref.provider,
        model: ref.id,
        answers: {
          decision: {
            type: "choice",
            choice,
            probabilities: probs,
            confidence: 0.5,
          },
        },
        usage: {
          input: 1000,
          output: 0,
          totalTokens: 1000,
          cost: { total: 0.00024 },
        },
        stopReason: options.stopReason ?? "stop",
        errorMessage: options.stopReason === "error" ? "boom" : undefined,
        timestamp: Date.now(),
      } as never;
    },
  };
  return { backend, calls, peak: () => peak };
}

test("trimText keeps the requested end and marks the cut", () => {
  const text = "a".repeat(50) + "TAIL";
  assert.match(trimText(text, 10, "tail").text, /trimmed[\s\S]*TAIL$/);
  assert.match(trimText("HEAD" + "b".repeat(50), 10, "head").text, /^HEAD/);
  const middle = trimText("START" + "c".repeat(100) + "END", 20, "middle").text;
  assert.ok(middle.startsWith("START") && middle.endsWith("END"));
  assert.equal(trimText("short", 10, "tail").truncated, false);
});

test("resolveModelRef maps aliases and explicit ids", () => {
  assert.deepEqual(resolveModelRef(undefined, "flash"), {
    provider: "cloudflare-workers-ai",
    id: CLEF_MODELS.flash,
    alias: "flash",
  });
  assert.equal(resolveModelRef("clef", "flash").id, CLEF_MODELS.clef);
  assert.equal(
    resolveModelRef("@cf/cloudflare/clef", "flash").provider,
    "cloudflare-workers-ai",
  );
  assert.deepEqual(resolveModelRef("openrouter/typesafe/jev-1.13", "clef"), {
    provider: "openrouter",
    id: "typesafe/jev-1.13",
    alias: "openrouter/typesafe/jev-1.13",
  });
  assert.throws(() => resolveModelRef("nope", "clef"));
});

test("blocker preset: confident classifier answer maps to an action", async () => {
  const { backend, calls } = fakeBackend({
    preexisting_flake: 0.95,
    stage_regression: 0.03,
    other: 0.02,
  });
  const { judgment, state } = await runJudge(backend, "blocker", {
    blocker:
      "TestNotifier_OnEmitThenLiveIsGapFree observed 419 events, expected 500",
    touchedFiles: ["internal/models/session_v9.go"],
    gateLog: "x".repeat(200_000) + "\nFAIL internal/orchestrator",
  });
  assert.equal(judgment.ok, true);
  assert.equal(judgment.label, "preexisting_flake");
  assert.equal(judgment.confident, true);
  assert.equal(judgment.action, "rerun_isolated_then_investigate");
  assert.equal(judgment.model, "clef");
  assert.equal(judgment.costUsd, 0.00024);
  assert.deepEqual(judgment.truncated, ["gateLog"]);
  assert.match(
    String(state.gateLog),
    /FAIL internal\/orchestrator$/,
    "log keeps its tail",
  );
  assert.equal(calls[0].id, CLEF_MODELS.clef);
  assert.equal(
    (calls[0].questions.decision as { type: string }).type,
    "choice",
  );
  assert.equal(state.touchedFiles, "internal/models/session_v9.go");
});

test("below threshold always escalates", async () => {
  const { backend } = fakeBackend({
    stage_regression: 0.6,
    preexisting_flake: 0.4,
  });
  const { judgment } = await runJudge(backend, "blocker", { blocker: "x" });
  assert.equal(judgment.confident, false);
  assert.equal(judgment.action, "escalate");
  const lowered = await runJudge(
    backend,
    "blocker",
    { blocker: "x" },
    { threshold: 0.5 },
  );
  assert.equal(lowered.judgment.action, "fix_in_stage");
});

test("rules decide unambiguous errors without calling the classifier", async () => {
  const { backend, calls } = fakeBackend({ other: 1 });
  const rate = await runJudge(backend, "error", {
    error: "HTTP 429 Too Many Requests",
  });
  assert.equal(rate.judgment.source, "rule");
  assert.equal(rate.judgment.label, "rate_limit");
  assert.equal(rate.judgment.action, "wait_and_retry");
  assert.equal(calls.length, 0);

  const ambiguous = await runJudge(backend, "error", {
    error: "429 then 401 unauthorized",
  });
  assert.equal(
    ambiguous.judgment.source,
    "classifier",
    "conflicting rules defer to the model",
  );
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].id,
    CLEF_MODELS.flash,
    "error preset defaults to flash",
  );

  const forced = await runJudge(
    backend,
    "error",
    { error: "HTTP 429" },
    { noRules: true },
  );
  assert.equal(forced.judgment.source, "classifier");
});

test("verdict rule reads an explicit VERDICT line", async () => {
  const { backend, calls } = fakeBackend({ undecided: 1 });
  const { judgment } = await runJudge(backend, "verdict", {
    reply: "**VERDICT: FAIL**\n- internal/x.go:12 leaks the reservation",
  });
  assert.equal(judgment.label, "fail");
  assert.equal(judgment.action, "treat_as_fail");
  assert.equal(calls.length, 0);
});

test("failures settle into ok:false and escalate", async () => {
  const missingInput = await runJudge(fakeBackend({ a: 1 }).backend, "claim", {
    claim: "tests pass",
  });
  assert.equal(missingInput.judgment.ok, false);
  assert.match(String(missingInput.judgment.error), /evidence/);

  const providerError = await runJudge(
    fakeBackend({ a: 1 }, { stopReason: "error" }).backend,
    "finding",
    {
      finding: "nit: rename x",
    },
  );
  assert.equal(providerError.judgment.ok, false);
  assert.equal(providerError.judgment.error, "boom");
  assert.equal(providerError.judgment.action, "escalate");

  const unknownKind = await runJudge(
    fakeBackend({ a: 1 }).backend,
    "bogus" as never,
    {},
  );
  assert.match(String(unknownKind.judgment.error), /unknown judge kind/);

  const thrown = await runJudge(
    fakeBackend(() => {
      throw new Error("network down");
    }).backend,
    "finding",
    { finding: "x" },
  );
  assert.equal(thrown.judgment.error, "network down");
});

test("at most four classifier calls run at once", async () => {
  const fake = fakeBackend({ nit: 0.99, blocking: 0.01 });
  await Promise.all(
    Array.from({ length: 10 }, () =>
      runJudge(fake.backend, "finding", { finding: "x" }),
    ),
  );
  assert.equal(fake.calls.length, 10);
  assert.ok(fake.peak() <= 4, `peak ${fake.peak()}`);
});

test("raw classify passes questions through and validates input", async () => {
  const fake = fakeBackend({ yes: 0.8, no: 0.2 });
  const ok = await runRawClassify(
    fake.backend,
    { text: "hi" },
    {
      q: { type: "choice", instructions: "?", criteria: { yes: "y", no: "n" } },
    },
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.answers?.decision?.type, "choice");
  const bad = await runRawClassify(fake.backend, { text: "hi" }, {});
  assert.equal(bad.ok, false);
});

test("decision records and formatting", async () => {
  const { backend } = fakeBackend({ consistent: 0.97, contradicted: 0.03 });
  const { judgment, state } = await runJudge(backend, "claim", {
    claim: "all gates passed",
    evidence: "ok",
  });
  const record = toDecisionRecord(judgment, state, { runId: "wf_x" });
  assert.equal(record.kind, "claim");
  assert.deepEqual(record.context, { runId: "wf_x" });
  assert.equal(record.state.claim, "all gates passed");
  assert.match(
    formatJudgment(judgment),
    /^claim → consistent \(0\.97, clef\) ⇒ trust_claim$/,
  );
  assert.match(presetInputDoc(), /judge\.blocker\(\{ stage, blocker\*/);
});
