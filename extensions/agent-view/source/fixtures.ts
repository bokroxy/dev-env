/**
 * Synthetic pi-subagents run directories for tests and the render harness.
 * The shapes mirror the real artifacts (status.json, workflow-children.jsonl,
 * events.jsonl, output-0.log) but every prompt, path and tool line here is
 * invented: nothing is copied out of a real run.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface FixtureRunOptions {
  runId: string;
  sessionId: string;
  mode: "single" | "chain" | "parallel" | "workflow";
  state: string;
  startedAt: number;
  lastUpdate: number;
  cwd?: string;
  agent?: string;
  model?: string;
  thinking?: string;
  /** `steps[0].sessionName`: the human line the view titles a single run with. */
  sessionName?: string;
  /** Top-level `status.error`, shown (first line) on failed rows. */
  error?: string;
  workflowKey?: string;
  parentWorkflowRunId?: string;
  workflowChildren?: {
    inventoryComplete: boolean;
    children: {
      childId: string;
      state: string;
      runId: string;
      agent: string;
    }[];
  };
  /** `status.workflow.args.plannedChildren` — a declared plan (optional in real runs). */
  plannedChildren?: string[];
  /** `status.workflow.args.startAt` / `stopAfter` / `title`. */
  workflowArgs?: { startAt?: string; stopAfter?: string; title?: string };
  /** `status.workflow.argsDigest`, used to disambiguate colliding titles. */
  argsDigest?: string;
  steps?: {
    agent: string;
    status: string;
    label?: string;
    model?: string;
    startedAt?: number;
    durationMs?: number;
  }[];
  stepStatus?: string;
  endedAt?: number;
  tokens?: { input: number; output: number; total: number; window?: number };
  totalCost?: { inputTokens?: number; outputTokens?: number; costUsd: number };
  /**
   * Dead pid by default: a fixture without the `.active-runs` marker must be
   * stale on any machine. Pass `process.pid` to fake a live process.
   */
  pid?: number;
  deadlineAt?: number;
  lastActivityAt?: number;
  /** false keeps the `.active-runs/<runId>` marker away (the stale case). */
  marker?: boolean;
}

export interface WorkflowFixture {
  runId: string;
  sessionId: string;
  children: {
    childId: string;
    runId: string;
    agent: string;
    state: string;
    workflowKey: string;
  }[];
  root: string;
}

export function writeStatus(dir: string, options: FixtureRunOptions): void {
  fs.mkdirSync(dir, { recursive: true });
  const sessionName =
    options.sessionName ??
    `${options.agent ?? "worker"}: fixture run ${options.runId.slice(0, 8)}`;
  const steps =
    options.mode === "workflow"
      ? (options.workflowChildren?.children ?? []).slice(-3).map((child) => ({
          agent: child.agent,
          label: child.childId,
          workflowKey: child.childId,
          parentWorkflowRunId: options.runId,
          status: child.state,
          startedAt: options.startedAt,
          runId: child.runId,
          sessionName: `${child.agent}: fixture child ${child.childId}`,
        }))
      : options.steps
        ? options.steps.map((step) => ({
            agent: step.agent,
            ...(step.label ? { label: step.label } : {}),
            ...(step.model ? { model: step.model } : {}),
            status: step.status,
            sessionName:
              `${step.agent}: fixture step ${step.label ?? ""}`.trim(),
            ...(step.startedAt !== undefined
              ? { startedAt: step.startedAt }
              : {}),
            ...(step.durationMs !== undefined
              ? { durationMs: step.durationMs }
              : {}),
          }))
        : [
            {
              agent: options.agent ?? "worker",
              sessionName,
              model: options.model ?? "anthropic/claude-sonnet-5-5:high",
              thinking: options.thinking ?? "high",
              status: options.stepStatus ?? options.state,
              startedAt: options.startedAt,
              ...(options.endedAt !== undefined
                ? { durationMs: options.endedAt - options.startedAt }
                : {}),
            },
          ];
  const workflow =
    options.plannedChildren || options.workflowArgs
      ? {
          ...(options.plannedChildren
            ? { args: { plannedChildren: options.plannedChildren } }
            : {}),
          ...(options.workflowArgs
            ? { args: { ...options.workflowArgs } }
            : {}),
          ...(options.argsDigest ? { argsDigest: options.argsDigest } : {}),
        }
      : undefined;
  const status = {
    lifecycleArtifactVersion: 3,
    runId: options.runId,
    toolCallId: "toolu_fixture",
    sessionId: options.sessionId,
    completionOwnerId: "fixture-owner",
    mode: options.mode,
    state: options.state,
    startedAt: options.startedAt,
    lastUpdate: options.lastUpdate,
    lastActivityAt: options.lastActivityAt ?? options.lastUpdate,
    cwd: options.cwd ?? "/home/fixture/project",
    pid: options.pid ?? 999999,
    ...(options.deadlineAt !== undefined
      ? { deadlineAt: options.deadlineAt }
      : {}),
    ...(options.endedAt !== undefined ? { endedAt: options.endedAt } : {}),
    ...(options.parentWorkflowRunId
      ? { parentWorkflowRunId: options.parentWorkflowRunId }
      : {}),
    ...(options.workflowKey ? { workflowKey: options.workflowKey } : {}),
    ...(options.error ? { error: options.error } : {}),
    steps,
    // `args.plannedChildren` and `args.*` share one `args` object, so merge
    // them by spreading the same planned list into the args when both exist.
    ...(workflow
      ? {
          workflow: {
            ...workflow,
            ...(options.plannedChildren && options.workflowArgs
              ? {
                  args: {
                    plannedChildren: options.plannedChildren,
                    ...options.workflowArgs,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(options.workflowChildren
      ? { workflowChildren: { version: 1, ...options.workflowChildren } }
      : {}),
    ...(options.tokens ? { totalTokens: options.tokens } : {}),
    ...(options.totalCost ? { totalCost: options.totalCost } : {}),
    turnCount: 4,
    toolCount: 11,
    ...(options.mode !== "workflow"
      ? { outputFile: path.join(dir, "output-0.log") }
      : {}),
  };
  fs.writeFileSync(
    path.join(dir, "status.json"),
    `${JSON.stringify(status, null, 2)}\n`,
    "utf8",
  );
  // pi-subagents writes one marker per in-flight run; a running fixture without
  // one is exactly the stale case the liveness check exists for.
  if (
    options.marker !== false &&
    (options.state === "running" || options.state === "queued")
  ) {
    const markerDir = path.join(path.dirname(dir), ".active-runs");
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, options.runId), "", "utf8");
  }
}

/**
 * A temporary directory that is removed when the process exits. Tests and the
 * measurement tools must not leave `agent-view-*` directories (or a
 * multi-megabyte `events.jsonl`) behind in a tmpfs /tmp.
 */
const TEMP_DIRS: string[] = [];
let tempCleanupRegistered = false;

export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  if (!tempCleanupRegistered) {
    tempCleanupRegistered = true;
    process.on("exit", () => {
      for (const created of TEMP_DIRS) {
        try {
          fs.rmSync(created, { recursive: true, force: true });
        } catch {
          // A temp dir that will not delete is not worth failing a run over.
        }
      }
    });
  }
  return dir;
}

export function writeEvents(dir: string, lines: unknown[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "events.jsonl"),
    lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
    "utf8",
  );
}

export function appendEvents(dir: string, lines: unknown[]): void {
  fs.appendFileSync(
    path.join(dir, "events.jsonl"),
    lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
    "utf8",
  );
}

export function writeChildLine(dir: string, value: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, "workflow-children.jsonl"),
    `${JSON.stringify(value)}\n`,
    "utf8",
  );
}

export function thinkingMessage(text: string, ts: number) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: text }],
    },
    observedAt: ts,
  };
}

export function toolStart(
  name: string,
  args: Record<string, unknown>,
  ts: number,
) {
  return { type: "tool_execution_start", toolName: name, args, observedAt: ts };
}

export function toolEnd(name: string, ts: number) {
  return { type: "tool_execution_end", toolName: name, observedAt: ts };
}

export interface FixtureWorld {
  root: string;
  sessionFile: string;
  otherSessionFile: string;
  workflowRunId: string;
  workflowChildren: {
    childId: string;
    runId: string;
    agent: string;
    state: string;
  }[];
  clefRunId: string;
  failedRunId: string;
  redactedRunId: string;
  singleRunId: string;
  goneRunId: string;
  chainRunId: string;
  otherRunId: string;
  /** A finished single run, so the Recent list is never empty in the harness. */
  finishedRunId: string;
}

/**
 * A world with:
 *  - a workflow with 9 planned children (4 done, 2 running, 2 planned, 1 failed; inventory partial)
 *  - a failed child and a clef child with a verdict
 *  - a plain single run, a chain run, and a run whose thinking is redacted
 *  - a run of another session, and a run dir a test can delete mid-scan
 * Times are relative to `now`.
 */
export function buildFixtureWorld(
  root: string,
  now = Date.now(),
): FixtureWorld {
  fs.mkdirSync(root, { recursive: true });
  const sessionFile = "/home/fixture/sessions/session-a.jsonl";
  const otherSessionFile = "/home/fixture/sessions/session-b.jsonl";
  const workflowRunId = "aaaaaaaa-1111-4111-8111-000000000001";
  const workflowDir = path.join(root, workflowRunId);
  const minutes = (value: number) => value * 60_000;

  const children = [
    {
      childId: "impl-AF1",
      runId: "bbbbbbbb-0001-4000-8000-000000000001",
      agent: "worker",
      state: "completed",
      workflowKey: "impl-AF1",
    },
    {
      childId: "review-AF1-0",
      runId: "bbbbbbbb-0002-4000-8000-000000000002",
      agent: "delegate",
      state: "completed",
      workflowKey: "review-AF1-0",
    },
    {
      childId: "fix-AF1-1",
      runId: "bbbbbbbb-0003-4000-8000-000000000003",
      agent: "worker",
      state: "completed",
      workflowKey: "fix-AF1-1",
    },
    {
      childId: "review-AF1-2",
      runId: "bbbbbbbb-0004-4000-8000-000000000004",
      agent: "delegate",
      state: "running",
      workflowKey: "review-AF1-2",
    },
    {
      childId: "impl-AF2",
      runId: "bbbbbbbb-0005-4000-8000-000000000005",
      agent: "worker",
      state: "running",
      workflowKey: "impl-AF2",
    },
    {
      childId: "review-AF2-0",
      runId: "bbbbbbbb-0006-4000-8000-000000000006",
      agent: "delegate",
      state: "queued",
      workflowKey: "review-AF2-0",
    },
    {
      childId: "fix-AF2-1",
      runId: "bbbbbbbb-0007-4000-8000-000000000007",
      agent: "worker",
      state: "queued",
      workflowKey: "fix-AF2-1",
    },
    {
      childId: "clef-1-blocker",
      runId: "cccccccc-0001-4000-8000-000000000001",
      agent: "clef",
      state: "completed",
      workflowKey: "clef-1-blocker",
    },
    {
      childId: "review-AF3-0",
      runId: "bbbbbbbb-0009-4000-8000-000000000009",
      agent: "delegate",
      state: "failed",
      workflowKey: "review-AF3-0",
    },
  ];

  const parentStartedAt = now - minutes(96);
  writeStatus(workflowDir, {
    runId: workflowRunId,
    sessionId: sessionFile,
    mode: "workflow",
    state: "running",
    startedAt: parentStartedAt,
    lastUpdate: now - 500,
    cwd: "/home/fixture/arena-fix",
    // Deliberately partial inventory: the jsonl holds children the status does not list yet.
    workflowChildren: {
      inventoryComplete: false,
      children: children
        .slice(0, 5)
        .map(({ childId, state: childState, runId, agent }) => ({
          childId,
          state: childState,
          runId,
          agent,
        })),
    },
    plannedChildren: children.map((child) => child.childId),
    workflowArgs: { startAt: "AF1", stopAfter: "AF4" },
    argsDigest: "aaaaaaaa1111bbbb",
    tokens: { input: 1200, output: 40_000, total: 41_200, window: 90_000 },
  });
  // `start` lines exist only for children that actually started; the plan names the rest.
  const startedIndexes = [0, 1, 2, 3, 4, 7, 8];
  for (const index of startedIndexes) {
    const child = children[index];
    writeChildLine(workflowDir, {
      type: "start",
      key: child.childId,
      fingerprint: `fp-${child.childId}`,
      runId: child.runId,
    });
  }
  // A settle line (long, like the real ones) that the scanner must survive.
  writeChildLine(workflowDir, {
    type: "settle",
    key: "impl-AF1",
    fingerprint: "fp-impl-AF1",
    result: {
      key: "impl-AF1",
      ok: true,
      output: "x".repeat(9000),
      task: "[prompt redacted]",
    },
  });

  const childDir = (runId: string) => path.join(root, runId);

  // Three finished children.
  for (const [index, child] of children.slice(0, 3).entries()) {
    const startedAt = parentStartedAt + minutes(index * 12);
    const endedAt = startedAt + minutes(9 + index);
    writeStatus(childDir(child.runId), {
      runId: child.runId,
      sessionId: sessionFile,
      mode: "single",
      state: "complete",
      startedAt,
      endedAt,
      lastUpdate: endedAt,
      cwd: "/home/fixture/arena-fix",
      agent: child.agent,
      model: "anthropic/claude-sonnet-5-5:high",
      workflowKey: child.childId,
      parentWorkflowRunId: workflowRunId,
      stepStatus: "completed",
      tokens: { input: 30, output: 4000, total: 4030, window: 40_000 },
    });
    writeEvents(childDir(child.runId), [
      {
        type: "subagent.run.started",
        runId: child.runId,
        mode: "single",
        ts: startedAt,
      },
      { type: "agent_start", subagentStepIndex: 0, observedAt: startedAt + 10 },
      thinkingMessage(
        `Finished the ${child.childId} pass; the report is written.`,
        endedAt - 1000,
      ),
      {
        type: "subagent.run.completed",
        runId: child.runId,
        status: "complete",
        ts: endedAt,
      },
    ]);
    fs.writeFileSync(
      path.join(childDir(child.runId), "output-0.log"),
      `report for ${child.childId}\n`,
      "utf8",
    );
  }

  // Two running children with live thinking and a tool call.
  const running = [children[3], children[4]];
  for (const [index, child] of running.entries()) {
    const startedAt = now - minutes(14 - index * 4);
    writeStatus(childDir(child.runId), {
      runId: child.runId,
      sessionId: sessionFile,
      mode: "single",
      state: "running",
      startedAt,
      lastUpdate: now - 800,
      cwd: "/home/fixture/arena-fix",
      agent: child.agent,
      model:
        index === 0
          ? "anthropic/claude-opus-5-5:high"
          : "anthropic/claude-sonnet-5-5:high",
      workflowKey: child.childId,
      parentWorkflowRunId: workflowRunId,
      stepStatus: "running",
      tokens: { input: 120, output: 12_000, total: 12_120, window: 80_000 },
    });
    writeEvents(childDir(child.runId), [
      {
        type: "subagent.run.started",
        runId: child.runId,
        mode: "single",
        ts: startedAt,
      },
      { type: "agent_start", subagentStepIndex: 0, observedAt: startedAt + 5 },
      thinkingMessage(
        `Re-reading the ${child.childId} diff to find the crash window before I trust the fix.`,
        now - 30_000,
      ),
      toolStart(
        "read",
        { path: "/home/fixture/arena-fix/internal/handler/council.go" },
        now - 20_000,
      ),
      toolEnd("read", now - 19_000),
      toolStart(
        "bash",
        { command: "go test -race ./internal/modes/arena" },
        now - 18_000,
      ),
      thinkingMessage(
        `The rollback path still looks unsafe for ${child.childId}; I need a counterexample.`,
        now - 2000,
      ),
    ]);
    fs.writeFileSync(
      path.join(childDir(child.runId), "output-0.log"),
      `${child.childId} in progress\n`,
      "utf8",
    );
  }

  // clef child with a verdict in output-0.log.
  const clefRunId = children[7].runId;
  const clefStartedAt = now - minutes(30);
  writeStatus(childDir(clefRunId), {
    runId: clefRunId,
    sessionId: sessionFile,
    mode: "single",
    state: "complete",
    startedAt: clefStartedAt,
    endedAt: clefStartedAt + 2200,
    lastUpdate: clefStartedAt + 2200,
    cwd: "/home/fixture/arena-fix",
    agent: "clef",
    model: "cf/clef",
    workflowKey: "clef-1-blocker",
    parentWorkflowRunId: workflowRunId,
    stepStatus: "completed",
  });
  writeEvents(childDir(clefRunId), [
    {
      type: "subagent.run.started",
      runId: clefRunId,
      mode: "single",
      ts: clefStartedAt,
    },
    {
      type: "subagent.step.completed",
      stepIndex: 0,
      agent: "clef",
      exitCode: 0,
      ts: clefStartedAt + 2200,
    },
    {
      type: "subagent.run.completed",
      runId: clefRunId,
      status: "complete",
      ts: clefStartedAt + 2200,
    },
  ]);
  fs.writeFileSync(
    path.join(childDir(clefRunId), "output-0.log"),
    `${JSON.stringify({
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
      tokens: 2079,
    })}\n`,
    "utf8",
  );

  // Failed child with an error event.
  const failedRunId = children[8].runId;
  const failedStartedAt = now - minutes(52);
  writeStatus(childDir(failedRunId), {
    runId: failedRunId,
    sessionId: sessionFile,
    mode: "single",
    state: "failed",
    startedAt: failedStartedAt,
    endedAt: failedStartedAt + minutes(6),
    lastUpdate: failedStartedAt + minutes(6),
    cwd: "/home/fixture/arena-fix",
    agent: "delegate",
    model: "anthropic/claude-opus-5-5:high",
    workflowKey: "review-AF3-0",
    parentWorkflowRunId: workflowRunId,
    stepStatus: "failed",
  });
  writeEvents(childDir(failedRunId), [
    {
      type: "subagent.run.started",
      runId: failedRunId,
      mode: "single",
      ts: failedStartedAt,
    },
    {
      type: "subagent.step.completed",
      stepIndex: 0,
      agent: "delegate",
      exitCode: 3,
      ts: failedStartedAt + minutes(6),
    },
    {
      type: "subagent.run.completed",
      runId: failedRunId,
      status: "failed",
      ts: failedStartedAt + minutes(6),
    },
  ]);
  fs.writeFileSync(
    path.join(childDir(failedRunId), "output-0.log"),
    "partial review output before the crash\n",
    "utf8",
  );

  // Single top-level run whose thinking is redacted.
  const singleRunId = "dddddddd-0001-4000-8000-000000000001";
  const singleStartedAt = now - minutes(8);
  writeStatus(childDir(singleRunId), {
    runId: singleRunId,
    sessionId: sessionFile,
    mode: "single",
    state: "running",
    startedAt: singleStartedAt,
    lastUpdate: now - 400,
    cwd: "/home/fixture/research",
    agent: "researcher",
    model: "anthropic/claude-sonnet-5-5:low",
    thinking: "low",
    stepStatus: "running",
    tokens: { input: 10, output: 900, total: 910 },
  });
  writeEvents(childDir(singleRunId), [
    {
      type: "subagent.run.started",
      runId: singleRunId,
      mode: "single",
      ts: singleStartedAt,
    },
    {
      type: "agent_start",
      subagentStepIndex: 0,
      observedAt: singleStartedAt + 5,
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "" }],
      },
      observedAt: now - 20_000,
    },
    { type: "thinking_dropped", observedAt: now - 20_000 },
    toolStart("search", { query: "medieval role thesaurus" }, now - 9000),
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Found three candidate thesauri; comparing them now.",
          },
        ],
      },
      observedAt: now - 5000,
    },
  ]);
  fs.writeFileSync(
    path.join(childDir(singleRunId), "output-0.log"),
    "research in progress\n",
    "utf8",
  );

  // A run of another session.
  const otherRunId = "eeeeeeee-0001-4000-8000-000000000001";
  writeStatus(childDir(otherRunId), {
    runId: otherRunId,
    sessionId: otherSessionFile,
    mode: "single",
    state: "running",
    startedAt: now - minutes(20),
    lastUpdate: now - 700,
    cwd: "/home/fixture/other",
    agent: "worker",
    stepStatus: "running",
  });
  writeEvents(childDir(otherRunId), [
    {
      type: "subagent.run.started",
      runId: otherRunId,
      mode: "single",
      ts: now - minutes(20),
    },
    thinkingMessage(
      "Work in another pi session; visible only when the `a` filter is on.",
      now - 3000,
    ),
  ]);

  // A chain run: one run dir holding three steps (its own children rows).
  const chainRunId = "dddddddd-0002-4000-8000-000000000002";
  const chainStartedAt = now - minutes(40);
  writeStatus(childDir(chainRunId), {
    runId: chainRunId,
    sessionId: sessionFile,
    mode: "chain",
    state: "running",
    startedAt: chainStartedAt,
    lastUpdate: now - 600,
    cwd: "/home/fixture/quill-b8",
    plannedChildren: ["stage-1", "stage-2", "stage-3"],
    steps: [
      {
        agent: "worker",
        status: "completed",
        label: "stage-1",
        model: "anthropic/claude-sonnet-5-5:high",
        startedAt: chainStartedAt,
        durationMs: minutes(11),
      },
      {
        agent: "delegate",
        status: "running",
        label: "stage-2",
        model: "anthropic/claude-opus-5-5:high",
        startedAt: now - minutes(12),
      },
      {
        agent: "worker",
        status: "pending",
        label: "stage-3",
        model: "anthropic/claude-sonnet-5-5:high",
      },
    ],
  });
  writeEvents(childDir(chainRunId), [
    {
      type: "subagent.run.started",
      runId: chainRunId,
      mode: "chain",
      ts: chainStartedAt,
    },
    {
      type: "subagent.step.started",
      stepIndex: 0,
      agent: "worker",
      ts: chainStartedAt,
    },
    {
      type: "subagent.step.completed",
      stepIndex: 0,
      agent: "worker",
      exitCode: 0,
      ts: chainStartedAt + minutes(11),
    },
    {
      type: "subagent.step.started",
      stepIndex: 1,
      agent: "delegate",
      ts: now - minutes(12),
    },
    {
      ...thinkingMessage(
        "Stage two: re-running the surviving mutants on a plain copy.",
        now - 4000,
      ),
      subagentStepIndex: 1,
      subagentAgent: "delegate",
    },
  ]);
  fs.writeFileSync(
    path.join(childDir(chainRunId), "output-0.log"),
    "stage one output\n",
    "utf8",
  );

  // A finished single root: the Recent list of the default (live) view.
  const finishedRunId = "dddddddd-0003-4000-8000-000000000003";
  const finishedStartedAt = now - minutes(150);
  writeStatus(childDir(finishedRunId), {
    runId: finishedRunId,
    sessionId: sessionFile,
    mode: "single",
    state: "complete",
    startedAt: finishedStartedAt,
    endedAt: finishedStartedAt + minutes(22),
    lastUpdate: finishedStartedAt + minutes(22),
    cwd: "/home/fixture/arena-fix",
    agent: "researcher",
    sessionName: "worker: fixture arena fix, round one",
    workflowKey: "research-finished",
    stepStatus: "completed",
    tokens: { input: 100, output: 20_000, total: 20_100 },
    totalCost: { inputTokens: 100, outputTokens: 20_000, costUsd: 1.25 },
  });
  writeEvents(childDir(finishedRunId), [
    {
      type: "subagent.run.started",
      runId: finishedRunId,
      mode: "single",
      ts: finishedStartedAt,
    },
    {
      type: "subagent.run.completed",
      runId: finishedRunId,
      status: "complete",
      ts: finishedStartedAt + minutes(22),
    },
  ]);

  // A run dir that exists so a test can delete it mid-scan.
  const goneRunId = "ffffffff-0001-4000-8000-000000000001";
  writeStatus(childDir(goneRunId), {
    runId: goneRunId,
    sessionId: sessionFile,
    mode: "single",
    state: "running",
    startedAt: now - minutes(3),
    lastUpdate: now - 300,
    cwd: "/home/fixture/gone",
    agent: "scout",
    stepStatus: "running",
  });
  writeEvents(childDir(goneRunId), [
    {
      type: "subagent.run.started",
      runId: goneRunId,
      mode: "single",
      ts: now - minutes(3),
    },
  ]);

  return {
    root,
    sessionFile,
    otherSessionFile,
    workflowRunId,
    workflowChildren: children.map(
      ({ childId, runId, agent, state: childState }) => ({
        childId,
        runId,
        agent,
        state: childState,
      }),
    ),
    clefRunId,
    failedRunId,
    redactedRunId: singleRunId,
    singleRunId,
    goneRunId,
    chainRunId,
    otherRunId,
    finishedRunId,
  };
}

/** Add a workflow child run directory after the fixture world exists. */
export function addRun(root: string, options: FixtureRunOptions): string {
  const dir = path.join(root, options.runId);
  writeStatus(dir, options);
  writeEvents(dir, [
    {
      type: "subagent.run.started",
      runId: options.runId,
      mode: options.mode,
      ts: options.startedAt,
    },
  ]);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "output-0.log"),
    `output for ${options.runId}\n`,
    "utf8",
  );
  return dir;
}
