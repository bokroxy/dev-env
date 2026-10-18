import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  collectItems,
  dedupeItems,
  extractFacts,
  formatDryRun,
  rankTests,
  runMine,
  selectItems,
  sinceToMs,
  summarizeDryRun,
} from "./clef-mine.ts";
import { readDecisions } from "./clef-log.ts";
import type { ClefBackend } from "./clef.ts";

function write(file: string, content: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    typeof content === "string" ? content : JSON.stringify(content),
  );
}

const GATE =
  "Full race/shuffle gate exited 1: TestNotifier_OnEmitThenLiveIsGapFree at internal/orchestrator/notifier_test.go:352 observed 419 events, expected 500";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "clef-mine-"));
  const agentDir = path.join(root, "agent");
  const asyncRunsDir = path.join(root, "async");
  const project = path.join(root, "project");
  const t1 = Date.parse("2026-10-01T10:00:00Z");
  const t2 = Date.parse("2026-10-03T10:00:00Z");
  const t3 = Date.parse("2026-10-04T10:00:00Z");

  // pi-subagents artifacts: rejected acceptance + error
  const artifacts = path.join(
    agentDir,
    "sessions",
    "--proj--",
    "subagent-artifacts",
  );
  write(path.join(artifacts, "aaaa1111-x_worker_meta.json"), {
    runId: "aaaa1111-x",
    agent: "worker",
    exitCode: 0,
    model: "anthropic/claude",
    timestamp: t2,
    acceptance: {
      status: "rejected",
      runtimeChecks: [
        {
          id: "attestation",
          status: "failed",
          message: "Failed to parse acceptance-report",
        },
      ],
    },
  });
  write(
    path.join(artifacts, "aaaa1111-x_worker_output.md"),
    `lots of text\nFAIL ${GATE}\n`,
  );
  write(path.join(artifacts, "bbbb2222-y_researcher_meta.json"), {
    runId: "bbbb2222-y",
    agent: "researcher",
    exitCode: 1,
    error: "429 rate_limit_error: account limit",
    timestamp: t1,
    acceptance: { status: "rejected" },
  });
  // project-scoped artifacts
  write(
    path.join(
      project,
      ".pi",
      "subagents",
      "artifacts",
      "cccc3333_worker_meta.json",
    ),
    {
      runId: "cccc3333",
      agent: "worker",
      error: "WebSocket closed 1012",
      timestamp: new Date(t3).toISOString(),
    },
  );
  // async status
  write(path.join(asyncRunsDir, "dddd4444", "status.json"), {
    state: "failed",
    lastUpdate: t3,
    steps: [{ status: "failed", error: "Subagent stopped by user." }],
  });
  // legacy workflow
  const wf = path.join(agentDir, "workflows", "wf_abc123");
  write(path.join(wf, "workflow.json"), {
    status: "completed",
    name: "g3",
    startedAt: t2,
    agents: [
      { label: "impl", error: "WebSocket closed 1012" },
      { label: "x", error: "Workflow stopped" },
    ],
  });
  write(path.join(wf, "result.json"), {
    results: [{ id: "R2", stopped: true, why: "blocked", blockers: [GATE] }],
    providerTrail: [
      { label: "a", provider: "openai-codex", ok: true },
      {
        label: "b",
        provider: "anthropic",
        ok: false,
        error: "HTTP 503 overloaded",
      },
    ],
  });
  return { root, agentDir, asyncRunsDir, project, t1, t2, t3 };
}

test("extractFacts finds Go tests, file:line and packages", () => {
  const facts = extractFacts(
    GATE + "\nFAIL\tgithub.com/x/y\nFAIL internal/handler",
  );
  assert.deepEqual(facts.tests, ["TestNotifier_OnEmitThenLiveIsGapFree"]);
  assert.deepEqual(facts.files, ["internal/orchestrator/notifier_test.go:352"]);
  assert.ok(facts.packages.includes("internal/orchestrator"));
  assert.ok(facts.packages.includes("internal/handler"));
});

test("collectItems reads every source, newest first, with --since", () => {
  const f = fixture();
  const items = collectItems({
    agentDir: f.agentDir,
    asyncRunsDir: f.asyncRunsDir,
    roots: [f.project],
  });
  const bySource = (source: string) =>
    items.filter((item) => item.source === source);
  assert.equal(
    bySource("subagent-artifacts").length,
    4,
    "rejected blocker + 2 errors + project error",
  );
  assert.equal(bySource("async-status").length, 1);
  assert.equal(
    bySource("legacy-workflow").length,
    3,
    'blocker, provider-trail error, agent error; "Workflow stopped" skipped',
  );
  assert.deepEqual(
    items.map((item) => item.ts),
    [...items.map((item) => item.ts)].sort((a, b) => b - a),
  );

  const blocker = items.find(
    (item) => item.kind === "blocker" && item.source === "subagent-artifacts",
  );
  assert.match(
    String(blocker?.input.blocker),
    /Failed to parse acceptance-report/,
  );
  assert.match(
    String(blocker?.input.gateLog),
    /TestNotifier_OnEmitThenLiveIsGapFree/,
  );

  const recent = collectItems({
    agentDir: f.agentDir,
    asyncRunsDir: f.asyncRunsDir,
    since: f.t3,
  });
  assert.ok(recent.every((item) => item.ts >= f.t3));
  assert.equal(
    recent.length,
    1,
    "only the async item is newer without the project root",
  );
  assert.equal(sinceToMs("2026-10-03"), Date.parse("2026-10-03T00:00:00Z"));
  assert.throws(() => sinceToMs("yesterday"));
});

test("dedupe folds repeated text and ranking counts recurrences", () => {
  const f = fixture();
  const raw = collectItems({
    agentDir: f.agentDir,
    asyncRunsDir: f.asyncRunsDir,
    roots: [f.project],
  });
  const unique = dedupeItems(raw);
  assert.ok(
    unique.length < raw.length,
    "WebSocket 1012 and the gate blocker repeat",
  );
  const ws = unique.find((item) => /websocket/i.test(item.text));
  assert.equal(ws?.count, 2);
  const ranked = rankTests(raw);
  assert.equal(ranked[0][0], "TestNotifier_OnEmitThenLiveIsGapFree");
  assert.ok(ranked[0][1] >= 1);
});

test("dry run summarises counts and cost without any backend", () => {
  const f = fixture();
  const { raw, unique, selected } = selectItems({
    agentDir: f.agentDir,
    asyncRunsDir: f.asyncRunsDir,
    roots: [f.project],
    limit: 3,
  });
  assert.equal(selected.length, 3);
  const summary = summarizeDryRun(raw, unique, selected);
  assert.equal(summary.selected, 3);
  assert.ok(
    summary.costUsd.clef > summary.costUsd.flash ||
      summary.estimatedTokens === 0,
  );
  const text = formatDryRun(summary);
  assert.match(text, /clef mine --dry:/);
  assert.match(text, /estimated cost/);
});

test("runMine classifies, logs and writes the report + jsonl", async () => {
  const f = fixture();
  const calls: string[] = [];
  const backend: ClefBackend = {
    classify: async (model, context) => {
      calls.push(model.id);
      const question = context.questions.decision;
      const labels =
        question.type === "choice" ? Object.keys(question.criteria) : [];
      const choice = labels.includes("preexisting_flake")
        ? "preexisting_flake"
        : labels[0];
      return {
        api: "cloudflare-workers-ai-system-one",
        provider: model.provider,
        model: model.id,
        answers: {
          decision: {
            type: "choice",
            choice,
            probabilities: { [choice]: 0.95 },
            confidence: 0.5,
          },
        },
        usage: {
          input: 1000,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1000,
          cost: {
            input: 0.0002,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.0002,
          },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
    },
  };
  const logFile = path.join(f.root, "decisions.jsonl");
  const result = await runMine(backend, {
    agentDir: f.agentDir,
    asyncRunsDir: f.asyncRunsDir,
    roots: [f.project],
    logFile,
  });
  assert.ok(
    result.reportPath.startsWith(
      path.join(f.agentDir, "clef", "reports", "mine-"),
    ),
  );
  const report = readFileSync(result.reportPath, "utf8");
  assert.match(report, /## Summary by kind and label/);
  assert.match(report, /TestNotifier_OnEmitThenLiveIsGapFree/);
  const lines = readFileSync(result.jsonlPath, "utf8").trim().split("\n");
  assert.equal(lines.length, result.classified);
  assert.ok(calls.length > 0, "non-rule items reach the classifier");
  assert.ok(
    readDecisions(logFile).every((record) => record.context?.caller === "mine"),
  );
  assert.match(result.summary, /mined \d+ of \d+ unique/);
});
