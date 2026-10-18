import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import {
  buildFixtureWorld,
  appendEvents,
  thinkingMessage,
  addRun,
  tempDir,
  writeChildLine,
  writeEvents,
  writeStatus,
  type FixtureWorld,
} from "./fixtures.ts";
import { DEFAULT_EXPECTED_MS, RunScanner } from "./runs.ts";
import { workflowBar } from "../ui/status.ts";
import { isDoneState } from "./types.ts";

interface World {
  root: string;
  historyDir: string;
  fixture: FixtureWorld;
  now: number;
}

function makeWorld(now = 1_800_000_000_000): World {
  const base = tempDir("agent-view-runs-");
  const root = path.join(base, "async-subagent-runs");
  const historyDir = path.join(base, "history");
  const fixture = buildFixtureWorld(root, now);
  return { root, historyDir, fixture, now };
}

function scannerFor(
  world: World,
  options: { includeOtherSessions?: boolean } = {},
): RunScanner {
  const scanner = new RunScanner({
    runsDir: world.root,
    historyDir: world.historyDir,
    sessionFile: world.fixture.sessionFile,
    now: () => world.now,
    includeOtherSessions: options.includeOtherSessions === true,
  });
  scanner.poll();
  return scanner;
}

test("discovers the workflows of the current session only", () => {
  const world = makeWorld();
  const scanner = scannerFor(world);
  const snapshot = scanner.snapshot();
  const ids = snapshot.workflows.map((workflow) => workflow.runId).sort();
  assert.ok(ids.includes(world.fixture.workflowRunId));
  assert.ok(ids.includes(world.fixture.singleRunId));
  assert.ok(ids.includes(world.fixture.chainRunId));
  assert.ok(ids.includes(world.fixture.goneRunId));
  assert.ok(ids.includes(world.fixture.finishedRunId));
  assert.equal(ids.includes(world.fixture.otherRunId), false);
  assert.equal(snapshot.workflows.length, 5);
  assert.ok(snapshot.runningCount >= 3);
});

test("other-session runs appear only while they are running and only on request", () => {
  const world = makeWorld();
  const scanner = scannerFor(world, { includeOtherSessions: true });
  const other = scanner
    .snapshot()
    .workflows.find((workflow) => workflow.runId === world.fixture.otherRunId);
  assert.ok(other);
  assert.equal(other.otherSession, true);
  assert.equal(other.activeCount, 1);
});

test("the workflow child list comes from workflow-children.jsonl, not the partial status", () => {
  const world = makeWorld();
  const scanner = scannerFor(world);
  const workflow = scanner
    .snapshot()
    .workflows.find(
      (candidate) => candidate.runId === world.fixture.workflowRunId,
    );
  assert.ok(workflow);
  assert.equal(workflow.inventoryComplete, false);
  const keys = workflow.children.map((child) => child.key);
  // The failed child never made it into status.workflowChildren (which is partial)...
  assert.ok(keys.includes("review-AF3-0"), keys.join(","));
  // ...and the two planned children only exist in workflow.args.plannedChildren.
  assert.ok(keys.includes("review-AF2-0"));
  assert.ok(keys.includes("fix-AF2-1"));
  assert.equal(workflow.children.length, 9);
  assert.equal(workflow.doneCount, 4);
  assert.equal(workflow.activeCount, 2);
  const queued = workflow.children.find(
    (child) => child.key === "review-AF2-0",
  );
  assert.equal(queued?.state, "queued");
  assert.equal(queued?.active, false);
  const failed = workflow.children.find(
    (child) => child.key === "review-AF3-0",
  );
  assert.equal(failed?.failed, true);
  assert.equal(failed?.state, "failed");
});

test("workflow progress is the mean of child estimates and never presented as exact", () => {
  const world = makeWorld();
  const scanner = scannerFor(world);
  const workflow = scanner
    .snapshot()
    .workflows.find(
      (candidate) => candidate.runId === world.fixture.workflowRunId,
    );
  assert.ok(workflow);
  const finished = workflow.children.filter((child) =>
    isDoneState(child.state),
  );
  assert.equal(finished.length, 4);
  for (const child of workflow.children) {
    if (isDoneState(child.state)) assert.equal(child.progress, 1);
    // A failed child is neither done nor running: it contributes no progress
    // and can never rank up.
    else if (child.failed) assert.equal(child.progress, 0, child.key);
    else if (child.state === "queued") assert.equal(child.progress, 0);
    else
      assert.ok(
        child.progress > 0 && child.progress <= 0.995,
        String(child.progress),
      );
  }
  const expected =
    workflow.children.reduce((sum, child) => sum + child.progress, 0) /
    workflow.children.length;
  assert.ok(Math.abs(workflow.progress - expected) < 1e-9);
  assert.ok(workflow.progress > 0 && workflow.progress < 1);
});

test("the running children are the interesting ones: model, effort, thinking and tool line", () => {
  const world = makeWorld();
  const scanner = scannerFor(world);
  const workflow = scanner
    .snapshot()
    .workflows.find(
      (candidate) => candidate.runId === world.fixture.workflowRunId,
    );
  const child = workflow?.children.find(
    (candidate) => candidate.key === "review-AF1-2",
  );
  assert.ok(child);
  assert.equal(child.model, "claude-opus-5-5");
  assert.equal(child.effort, "high");
  assert.match(child.activity.thought ?? "", /counterexample/);
  assert.equal(child.tools, 11);
});

test("the clef child carries its parsed verdict and the cf/clef model name", () => {
  const world = makeWorld();
  const scanner = scannerFor(world);
  const workflow = scanner
    .snapshot()
    .workflows.find(
      (candidate) => candidate.runId === world.fixture.workflowRunId,
    );
  const clef = workflow?.children.find((child) => child.isClef);
  assert.ok(clef);
  assert.equal(clef.verdict?.label, "stage_regression");
  assert.equal(clef.verdict?.p, 0.8924);
  assert.equal(clef.verdict?.action, "escalate");
  assert.equal(clef.model, "cf/clef");
  assert.equal(clef.roleKey, "clef");
});

test("a chain run shows one row per step and routes events by step index", () => {
  const world = makeWorld();
  const scanner = scannerFor(world);
  const chain = scanner
    .snapshot()
    .workflows.find(
      (candidate) => candidate.runId === world.fixture.chainRunId,
    );
  assert.ok(chain);
  assert.equal(chain.children.length, 3);
  assert.deepEqual(
    chain.children.map((child) => child.state),
    ["completed", "running", "pending"],
  );
  assert.equal(
    chain.children[0].key,
    "stage-1",
    "a labelled step uses its label as the key",
  );
  assert.equal(chain.children[1].activity.thought?.includes("Stage two"), true);
  assert.equal(chain.children[0].activity.thought, undefined);
  assert.equal(chain.children[1].agent, "delegate");
  assert.equal(chain.children[2].queued, true);
});

test("tailing is incremental: new events update the bubble", () => {
  const world = makeWorld();
  const scanner = scannerFor(world);
  const before = scanner
    .snapshot()
    .workflows.find(
      (workflow) => workflow.runId === world.fixture.workflowRunId,
    )
    ?.children.find((child) => child.key === "impl-AF2");
  assert.match(before?.activity.thought ?? "", /counterexample/);

  appendEvents(path.join(world.root, "bbbbbbbb-0005-4000-8000-000000000005"), [
    thinkingMessage(
      "The counterexample is in the loader: whitespace-only values are accepted.",
      world.now + 1000,
    ),
  ]);
  world.now += 1000;
  assert.equal(scanner.poll(), true);
  const after = scanner
    .snapshot()
    .workflows.find(
      (workflow) => workflow.runId === world.fixture.workflowRunId,
    )
    ?.children.find((child) => child.key === "impl-AF2");
  assert.match(
    after?.activity.thought ?? "",
    /whitespace-only values are accepted/,
  );
});

test("a run directory created after the first poll shows up on the next one", () => {
  const world = makeWorld();
  const scanner = scannerFor(world);
  const before = scanner.snapshot().runCount;
  const runId = "aaaa1111-2222-4333-8444-555566667777";
  addRun(world.root, {
    runId,
    sessionId: world.fixture.sessionFile,
    mode: "single",
    state: "running",
    startedAt: world.now - 60_000,
    lastUpdate: world.now,
    cwd: "/home/fixture/late",
    agent: "fixer",
  });
  assert.equal(scanner.poll(), true);
  const snapshot = scanner.snapshot();
  assert.equal(snapshot.runCount, before + 1);
  assert.ok(snapshot.workflows.some((workflow) => workflow.runId === runId));
});

test("a run directory that vanishes mid-scan is dropped without throwing", () => {
  const world = makeWorld();
  const scanner = scannerFor(world);
  assert.ok(
    scanner
      .snapshot()
      .workflows.some((workflow) => workflow.runId === world.fixture.goneRunId),
  );
  fs.rmSync(path.join(world.root, world.fixture.goneRunId), {
    recursive: true,
    force: true,
  });
  assert.equal(scanner.poll(), true);
  assert.equal(
    scanner
      .snapshot()
      .workflows.some((workflow) => workflow.runId === world.fixture.goneRunId),
    false,
  );
  assert.equal(scanner.poll(), false);
});

test("a disappearing events.jsonl does not break the next poll", () => {
  const world = makeWorld();
  const scanner = scannerFor(world);
  fs.rmSync(
    path.join(
      world.root,
      "bbbbbbbb-0004-4000-8000-000000000004",
      "events.jsonl",
    ),
  );
  assert.doesNotThrow(() => scanner.poll());
  assert.ok(scanner.snapshot().workflows.length > 0);
});

test("a missing runs directory is no runs on disk, not an error", () => {
  const base = tempDir("agent-view-nodir-");
  const scanner = new RunScanner({
    runsDir: path.join(base, "agent-view-nope"),
    historyDir: path.join(base, "history"),
    now: () => 1,
  });
  // Nothing on disk is not a change and not an error.
  assert.equal(scanner.poll(), false);
  const snapshot = scanner.snapshot();
  assert.equal(snapshot.workflows.length, 0);
  assert.equal(snapshot.error, undefined);
  fs.rmSync(base, { recursive: true, force: true });
});

test("a real scan failure is still reported", () => {
  const base = tempDir("agent-view-notdir-");
  const notADirectory = path.join(base, "runs");
  fs.writeFileSync(notADirectory, "not a directory\n");
  const scanner = new RunScanner({
    runsDir: notADirectory,
    historyDir: path.join(base, "history"),
    now: () => 1,
  });
  assert.equal(scanner.poll(), true);
  assert.match(scanner.snapshot().error ?? "", /not a directory|ENOTDIR/);
  fs.rmSync(base, { recursive: true, force: true });
});

test("an unchanged tree does not re-parse: poll reports no change", () => {
  const world = makeWorld();
  const scanner = scannerFor(world);
  assert.equal(scanner.poll(), false);
  fs.utimesSync(
    path.join(world.root, world.fixture.singleRunId, "status.json"),
    new Date(),
    new Date(),
  );
  assert.equal(scanner.poll(), false);
  // A real edit is noticed.
  const statusFile = path.join(
    world.root,
    world.fixture.singleRunId,
    "status.json",
  );
  const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  status.lastUpdate = world.now + 5000;
  status.state = "complete";
  fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
  assert.equal(scanner.poll(), true);
});

test("finished children feed the duration history, which then drives the estimate", () => {
  const world = makeWorld();
  const scanner = scannerFor(world);
  const file = path.join(world.historyDir, "durations.json");
  assert.equal(fs.existsSync(file), true);
  const book = scanner.durationBook;
  // A single sample per child is recorded, but it is not yet a median.
  assert.equal(book.samples("impl"), 1);
  assert.equal(book.medianMs("impl"), undefined);
  // The value the scanner actually recorded, read back from the written file:
  // it must be the real child duration, not a placeholder. A hand-made median
  // alone (9m/11m below) cannot catch a broken recorder.
  const recorded = JSON.parse(fs.readFileSync(file, "utf8")) as {
    roles: Record<string, number[]>;
  };
  assert.equal(recorded.roles.impl?.length, 1);
  const implSample = recorded.roles.impl?.[0];
  assert.ok(
    implSample !== undefined &&
      implSample > 8 * 60_000 &&
      implSample < 12 * 60_000,
    `recorded impl sample ${implSample}`,
  );
  assert.ok((recorded.roles.review?.[0] ?? 0) > 0, "recorded review sample");
  assert.ok((recorded.roles.clef?.[0] ?? 0) > 0, "recorded clef sample");
  book.record("impl", "extra-1", 9 * 60_000);
  book.record("impl", "extra-2", 11 * 60_000);
  const implMedian = book.medianMs("impl");
  // The median is the middle of the three samples, the recorded one included.
  const expectedMedian = [implSample, 9 * 60_000, 11 * 60_000].sort(
    (left, right) => left - right,
  )[1];
  assert.equal(implMedian, expectedMedian, String(implMedian));
  assert.equal(book.samples("review"), 1);
  assert.equal(book.samples("clef"), 1);
  // One sample per child: the run-level duration is not also booked under the agent name.
  assert.equal(book.samples("worker"), 0);
  assert.equal(book.samples("delegate"), 0);
  // Recording is idempotent across polls.
  const samples = book.samples("impl");
  scanner.poll();
  assert.equal(book.samples("impl"), samples);
});

test("with no history the conservative per-role default is used and clamped below 1", () => {
  const base = tempDir("agent-view-empty-");
  const root = path.join(base, "runs");
  const now = 1_900_000_000_000;
  addRun(root, {
    runId: "99999999-0001-4000-8000-000000000001",
    sessionId: "/home/fixture/sessions/session-a.jsonl",
    mode: "single",
    state: "running",
    startedAt: now - 60 * 60_000,
    lastUpdate: now,
    agent: "worker",
    workflowKey: "impl-long",
  });
  const scanner = new RunScanner({
    runsDir: root,
    historyDir: path.join(base, "history"),
    sessionFile: "/home/fixture/sessions/session-a.jsonl",
    now: () => now,
  });
  scanner.poll();
  const child = scanner.snapshot().workflows[0].children[0];
  assert.equal(child.progress, 0.99);
  assert.equal(child.estimated, true);
  assert.ok(scanner.durationBook.medianMs("impl") === undefined);
});

test("tokens, elapsed time and workflow title come through", () => {
  const world = makeWorld();
  const scanner = scannerFor(world);
  const workflow = scanner
    .snapshot()
    .workflows.find(
      (candidate) => candidate.runId === world.fixture.workflowRunId,
    );
  assert.ok(workflow);
  assert.equal(workflow.title, "arena-fix · AF1→AF4");
  assert.equal(workflow.cwdName, "arena-fix");
  assert.ok(workflow.elapsedMs >= 95 * 60_000, String(workflow.elapsedMs));
  // The root publishes totalTokens/totalCost; when it does not (real failed
  // workflows), they are summed over the children.
  assert.equal(workflow.tokens, 41_200);
  assert.equal(workflow.costUsd, undefined);
  const child = workflow.children.find(
    (candidate) => candidate.key === "impl-AF1",
  );
  assert.equal(child?.tokens?.total, 4030);
  assert.ok((child?.elapsedMs ?? 0) > 0);
});

test("terminal workflows are capped, with the overflow reported", () => {
  const base = tempDir("agent-view-cap-");
  const root = path.join(base, "runs");
  const now = 1_950_000_000_000;
  const sessionFile = "/home/fixture/sessions/session-a.jsonl";
  for (let index = 0; index < 20; index += 1) {
    addRun(root, {
      runId: `11111111-000${String(index).padStart(2, "0")}-4000-8000-000000000000`,
      sessionId: sessionFile,
      mode: "single",
      state: "complete",
      startedAt: now - (index + 1) * 60_000,
      endedAt: now - index * 60_000,
      lastUpdate: now - index * 60_000,
      agent: "worker",
    });
  }
  const scanner = new RunScanner({
    runsDir: root,
    historyDir: path.join(base, "history"),
    sessionFile,
    now: () => now,
    maxTerminalWorkflows: 5,
  });
  scanner.poll();
  const snapshot = scanner.snapshot();
  assert.equal(snapshot.workflows.length, 5);
  assert.equal(snapshot.hiddenWorkflows, 15);
});

// --- Regression tests for the review findings (REVIEW-1 P0..P2) ---------------

const SESSION = "/home/fixture/sessions/session-a.jsonl";

function freshScanner(
  root: string,
  now: number,
  extra: { sessionFile?: string; includeOtherSessions?: boolean } = {},
): RunScanner {
  const base = tempDir("agent-view-reg-");
  const scanner = new RunScanner({
    runsDir: root,
    historyDir: path.join(base, "history"),
    sessionFile: extra.sessionFile ?? SESSION,
    now: () => now,
    ...(extra.includeOtherSessions ? { includeOtherSessions: true } : {}),
  });
  scanner.poll();
  return scanner;
}

test("P0: partial, detached and rejected are terminal: never running, never counted", () => {
  const root = tempDir("agent-view-p0-");
  const now = 2_000_000_000_000;
  (["partial", "detached", "rejected"] as const).forEach((state, index) => {
    addRun(root, {
      runId: `20000000-000${index}-4000-8000-000000000000`,
      sessionId: SESSION,
      mode: "single",
      state,
      startedAt: now - 60 * 60_000,
      endedAt: now - 30 * 60_000,
      lastUpdate: now - 30 * 60_000,
      cwd: "/home/fixture/arena-fix",
      agent: "worker",
      stepStatus: state,
      // The real `partial` run ef6fa643 had a live-looking pid and a future
      // deadline; without this rule it rendered as running forever.
      pid: process.pid,
      deadlineAt: now + 60 * 60_000,
      marker: false,
    });
  });
  const snapshot = freshScanner(root, now).snapshot();
  assert.equal(snapshot.runningCount, 0);
  assert.equal(snapshot.workflows.length, 3);
  for (const workflow of snapshot.workflows) {
    assert.equal(workflow.live, false, workflow.runId);
    assert.equal(workflow.stale, false, workflow.runId);
    for (const child of workflow.children) {
      assert.equal(child.active, false, `${child.state} rendered as active`);
    }
  }
});

test("P0: an unrecognised state is never active, never counted and keeps its name", () => {
  const root = tempDir("agent-view-p0b-");
  const now = 2_000_000_000_000;
  addRun(root, {
    runId: "21000000-0001-4000-8000-000000000001",
    sessionId: SESSION,
    mode: "single",
    state: "frobnicating",
    startedAt: now - 60_000,
    lastUpdate: now - 1000,
    agent: "worker",
    pid: process.pid,
    marker: false,
  });
  const snapshot = freshScanner(root, now).snapshot();
  const child = snapshot.workflows[0].children[0];
  assert.equal(child.state, "frobnicating");
  assert.equal(child.active, false);
  assert.equal(child.stale, false);
  assert.equal(snapshot.runningCount, 0);
});

test("P0: a child of a terminal workflow is never active; the parent's record wins", () => {
  const root = tempDir("agent-view-p0c-");
  const now = 2_000_000_000_000;
  const workflowRunId = "30000000-0001-4000-8000-000000000001";
  const childRunId = "30000000-0002-4000-8000-000000000002";
  writeStatus(path.join(root, workflowRunId), {
    runId: workflowRunId,
    sessionId: SESSION,
    mode: "workflow",
    state: "failed",
    startedAt: now - 120 * 60_000,
    endedAt: now - 60 * 60_000,
    lastUpdate: now - 60 * 60_000,
    cwd: "/home/fixture/arena-fix",
    workflowChildren: {
      inventoryComplete: true,
      children: [
        {
          childId: "review-AF4-0",
          state: "failed",
          runId: childRunId,
          agent: "delegate",
        },
      ],
    },
  });
  writeChildLine(path.join(root, workflowRunId), {
    type: "start",
    key: "review-AF4-0",
    fingerprint: "fp",
    runId: childRunId,
  });
  // The child lies: still `running`, fresh activity and its own marker.
  writeStatus(path.join(root, childRunId), {
    runId: childRunId,
    sessionId: SESSION,
    mode: "single",
    state: "partial",
    startedAt: now - 100 * 60_000,
    endedAt: now - 30 * 60_000,
    lastUpdate: now - 1000,
    cwd: "/home/fixture/arena-fix",
    agent: "delegate",
    stepStatus: "failed",
    parentWorkflowRunId: workflowRunId,
    workflowKey: "review-AF4-0",
  });
  const snapshot = freshScanner(root, now).snapshot();
  const workflow = snapshot.workflows[0];
  assert.equal(workflow.runId, workflowRunId);
  assert.equal(workflow.live, false);
  const child = workflow.children[0];
  assert.equal(child.state, "failed", "the parent's record decides the state");
  assert.equal(child.failed, true);
  assert.equal(child.active, false);
  assert.equal(snapshot.runningCount, 0);
});

test("P1: a running root with a dead pid and no marker is stale, not live", () => {
  const root = tempDir("agent-view-stale-");
  const now = 2_000_000_000_000;
  addRun(root, {
    runId: "40000000-0001-4000-8000-000000000001",
    sessionId: SESSION,
    mode: "single",
    state: "running",
    startedAt: now - 3 * 60 * 60_000,
    lastUpdate: now - 3 * 60 * 60_000,
    lastActivityAt: now - 3 * 60 * 60_000,
    agent: "worker",
    pid: 999999,
    marker: false,
  });
  const snapshot = freshScanner(root, now).snapshot();
  const workflow = snapshot.workflows[0];
  assert.equal(workflow.live, false);
  assert.equal(workflow.stale, true);
  assert.equal(workflow.activeCount, 0);
  assert.equal(workflow.children[0].active, false);
  assert.equal(workflow.children[0].stale, true);
  assert.equal(snapshot.runningCount, 0);
});

test("P1: the pid fallback keeps a fresh run live, and rejects stale activity or an expired deadline", () => {
  const now = 2_000_000_000_000;
  const ok = tempDir("agent-view-live-");
  addRun(ok, {
    runId: "41000000-0001-4000-8000-000000000001",
    sessionId: SESSION,
    mode: "single",
    state: "running",
    startedAt: now - 60_000,
    lastUpdate: now - 1000,
    lastActivityAt: now - 1000,
    agent: "worker",
    pid: process.pid,
    deadlineAt: now + 60 * 60_000,
    marker: false,
  });
  const live = freshScanner(ok, now).snapshot().workflows[0];
  assert.equal(live.live, true);
  assert.equal(live.stale, false);
  assert.equal(live.activeCount, 1);

  const quiet = tempDir("agent-view-quiet-");
  addRun(quiet, {
    runId: "42000000-0001-4000-8000-000000000001",
    sessionId: SESSION,
    mode: "single",
    state: "running",
    startedAt: now - 60 * 60_000,
    lastUpdate: now - 11 * 60_000,
    lastActivityAt: now - 11 * 60_000,
    agent: "worker",
    pid: process.pid,
    deadlineAt: now + 60 * 60_000,
    marker: false,
  });
  assert.equal(freshScanner(quiet, now).snapshot().workflows[0].stale, true);

  const expired = tempDir("agent-view-dead-");
  addRun(expired, {
    runId: "43000000-0001-4000-8000-000000000001",
    sessionId: SESSION,
    mode: "single",
    state: "running",
    startedAt: now - 60 * 60_000,
    lastUpdate: now - 1000,
    lastActivityAt: now - 1000,
    agent: "worker",
    pid: process.pid,
    deadlineAt: now - 1,
    marker: false,
  });
  assert.equal(freshScanner(expired, now).snapshot().workflows[0].stale, true);
});

test("P1: the .active-runs marker alone proves a run is live", () => {
  const root = tempDir("agent-view-marker-");
  const now = 2_000_000_000_000;
  addRun(root, {
    runId: "44000000-0001-4000-8000-000000000001",
    sessionId: SESSION,
    mode: "single",
    state: "running",
    startedAt: now - 60_000,
    lastUpdate: now - 60_000,
    lastActivityAt: now - 60_000,
    agent: "worker",
    pid: 999999,
  });
  const snapshot = freshScanner(root, now).snapshot();
  assert.equal(snapshot.workflows[0].live, true);
  assert.equal(snapshot.workflows[0].stale, false);
});

test("P2: duration samples come only from done runs", () => {
  const root = tempDir("agent-view-dur-");
  const now = 2_000_000_000_000;
  const runs: [string, string, number][] = [
    ["50000000-0001-4000-8000-000000000001", "complete", 10 * 60_000],
    ["50000000-0002-4000-8000-000000000002", "failed", 18_000],
    ["50000000-0003-4000-8000-000000000003", "stopped", 18_500],
    ["50000000-0004-4000-8000-000000000004", "partial", 19_000],
  ];
  for (const [runId, state, duration] of runs) {
    addRun(root, {
      runId,
      sessionId: SESSION,
      mode: "single",
      state,
      startedAt: now - 60 * 60_000,
      endedAt: now - 60 * 60_000 + duration,
      lastUpdate: now - 60 * 60_000 + duration,
      agent: "delegate",
      workflowKey: "review-AF4-0",
      stepStatus: state,
    });
  }
  const book = freshScanner(root, now).durationBook;
  assert.equal(
    book.samples("review"),
    1,
    "only the complete review is a sample",
  );
  // Thin history: one sample is not a median yet.
  assert.equal(book.medianMs("review"), undefined);
  book.record("review", "extra-1", 9 * 60_000);
  book.record("review", "extra-2", 11 * 60_000);
  assert.equal(book.medianMs("review"), 10 * 60_000);
});

test("P2: the ETA is the longest remaining parallel child, not the sum", () => {
  const root = tempDir("agent-view-eta-");
  const now = 2_000_000_000_000;
  const workflowRunId = "60000000-0001-4000-8000-000000000001";
  const children = [
    {
      childId: "impl-A1",
      runId: "60000000-0002-4000-8000-000000000002",
      agent: "worker",
    },
    {
      childId: "review-A1-0",
      runId: "60000000-0003-4000-8000-000000000003",
      agent: "delegate",
    },
  ];
  writeStatus(path.join(root, workflowRunId), {
    runId: workflowRunId,
    sessionId: SESSION,
    mode: "workflow",
    state: "running",
    startedAt: now - 30 * 60_000,
    lastUpdate: now - 1000,
    cwd: "/home/fixture/parallel",
    workflowChildren: {
      inventoryComplete: true,
      children: children.map((child) => ({
        childId: child.childId,
        state: "running",
        runId: child.runId,
        agent: child.agent,
      })),
    },
  });
  for (const child of children) {
    writeChildLine(path.join(root, workflowRunId), {
      type: "start",
      key: child.childId,
      runId: child.runId,
    });
  }
  // impl: 10 of 20 min done, review: 5 of 15 min done -> 10 min remaining each.
  writeStatus(path.join(root, children[0].runId), {
    runId: children[0].runId,
    sessionId: SESSION,
    mode: "single",
    state: "running",
    startedAt: now - 10 * 60_000,
    lastUpdate: now - 1000,
    lastActivityAt: now - 1000,
    agent: "worker",
    parentWorkflowRunId: workflowRunId,
    workflowKey: "impl-A1",
  });
  writeStatus(path.join(root, children[1].runId), {
    runId: children[1].runId,
    sessionId: SESSION,
    mode: "single",
    state: "running",
    startedAt: now - 5 * 60_000,
    lastUpdate: now - 1000,
    lastActivityAt: now - 1000,
    agent: "delegate",
    parentWorkflowRunId: workflowRunId,
    workflowKey: "review-A1-0",
  });
  const workflow = freshScanner(root, now).snapshot().workflows[0];
  assert.equal(workflow.activeCount, 2);
  const expected = [
    DEFAULT_EXPECTED_MS.impl - 10 * 60_000,
    DEFAULT_EXPECTED_MS.review - 5 * 60_000,
  ];
  assert.equal(workflow.etaMs, Math.max(...expected));
  assert.ok(
    Math.abs(workflow.etaMs - 10 * 60_000) < 60_000,
    String(workflow.etaMs),
  );
});

test("P2: header counts are roots and the live/recent split is by liveness", () => {
  const world = makeWorld();
  const snapshot = scannerFor(world).snapshot();
  const live = snapshot.workflows.filter((workflow) => workflow.live);
  const recent = snapshot.workflows.filter((workflow) => !workflow.live);
  assert.equal(live.length + recent.length, snapshot.workflows.length);
  assert.ok(live.length >= 3);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].runId, world.fixture.finishedRunId);
  assert.ok(recent[0].finishedAt !== undefined);
});

test("P3: a run without a sessionId is not silently shown in every session", () => {
  const root = tempDir("agent-view-nosession-");
  const now = 2_000_000_000_000;
  const runId = "70000000-0001-4000-8000-000000000001";
  addRun(root, {
    runId,
    sessionId: SESSION,
    mode: "single",
    state: "running",
    startedAt: now - 60_000,
    lastUpdate: now - 1000,
    lastActivityAt: now - 1000,
    agent: "worker",
    pid: process.pid,
  });
  // Drop the sessionId from the artifact, as an older/garbled run would.
  const file = path.join(root, runId, "status.json");
  const status = JSON.parse(fs.readFileSync(file, "utf8"));
  delete status.sessionId;
  fs.writeFileSync(file, JSON.stringify(status, null, 2));
  assert.equal(freshScanner(root, now).snapshot().workflows.length, 0);
  const other = freshScanner(root, now, {
    includeOtherSessions: true,
  }).snapshot();
  assert.equal(other.workflows.length, 1);
  assert.equal(other.workflows[0].otherSession, true);
});

test("P3: without a session file, a named session is not claimed as ours", () => {
  const base = tempDir("agent-view-nosession-file-");
  const root = path.join(base, "runs");
  const now = 2_000_000_000_000;
  const otherRunId = "b0000000-0001-4000-8000-000000000001";
  const anonRunId = "b0000000-0002-4000-8000-000000000002";
  addRun(root, {
    runId: otherRunId,
    sessionId: "/home/fixture/sessions/session-b.jsonl",
    mode: "single",
    state: "complete",
    startedAt: now - 60 * 60_000,
    endedAt: now - 30 * 60_000,
    lastUpdate: now - 30 * 60_000,
    agent: "worker",
    stepStatus: "complete",
  });
  addRun(root, {
    runId: anonRunId,
    sessionId: SESSION,
    mode: "single",
    state: "running",
    startedAt: now - 60_000,
    lastUpdate: now,
    lastActivityAt: now,
    agent: "worker",
  });
  // Strip the sessionId, as a run of a `pi --no-session` process would have.
  const file = path.join(root, anonRunId, "status.json");
  const status = JSON.parse(fs.readFileSync(file, "utf8"));
  delete status.sessionId;
  fs.writeFileSync(file, JSON.stringify(status, null, 2));

  const historyDir = path.join(base, "history");
  const overlay = new RunScanner({ runsDir: root, historyDir, now: () => now });
  overlay.poll();
  const overlayWorkflows = overlay.snapshot().workflows;
  assert.deepEqual(
    overlayWorkflows.map((workflow) => workflow.runId),
    [anonRunId],
    "another session's finished run is not mixed into our history",
  );
  assert.equal(overlayWorkflows[0].otherSession, false);

  // The standalone watcher has no session either, but it asks for other
  // sessions: its live runs and its recent history both stay visible.
  const watcher = new RunScanner({
    runsDir: root,
    historyDir,
    now: () => now,
    includeOtherSessions: true,
  });
  watcher.poll();
  assert.deepEqual(
    watcher
      .snapshot()
      .workflows.map((workflow) => workflow.runId)
      .sort(),
    [anonRunId, otherRunId].sort(),
  );
});

test("P1: two workflows with the same identity get a short args digest", () => {
  const root = tempDir("agent-view-title-");
  const now = 2_000_000_000_000;
  const digests = ["add8abdfe2288f21", "bd795464238d17f6"];
  digests.forEach((digest, index) => {
    const runId = `80000000-000${index}-4000-8000-000000000000`;
    writeStatus(path.join(root, runId), {
      runId,
      sessionId: SESSION,
      mode: "workflow",
      state: "complete",
      startedAt: now - 60 * 60_000,
      endedAt: now - 30 * 60_000,
      lastUpdate: now - 30 * 60_000,
      cwd: "/home/fixture/arena-fix",
      agent: "worker",
      workflowArgs: { startAt: "AF4", stopAfter: "AF4" },
      argsDigest: digest,
    });
    writeChildLine(path.join(root, runId), {
      type: "start",
      key: "review-AF4-0",
      runId: `81000000-000${index}-4000-8000-000000000000`,
    });
    writeEvents(path.join(root, runId), []);
  });
  const titles = freshScanner(root, now)
    .snapshot()
    .workflows.map((workflow) => workflow.title)
    .sort();
  assert.deepEqual(titles, [
    "arena-fix · AF4→AF4 · add8ab",
    "arena-fix · AF4→AF4 · bd7954",
  ]);
});

test("P1: rows are keyed by workflowRunId/childKey, so duplicate child keys stay distinct", () => {
  const root = tempDir("agent-view-keys-");
  const now = 2_000_000_000_000;
  const workflows = [
    "90000000-0001-4000-8000-000000000001",
    "90000000-0002-4000-8000-000000000002",
  ];
  workflows.forEach((workflowRunId, index) => {
    const childRunId = `90000000-000${index + 3}-4000-8000-00000000000${index + 3}`;
    writeStatus(path.join(root, workflowRunId), {
      runId: workflowRunId,
      sessionId: SESSION,
      mode: "workflow",
      state: "running",
      startedAt: now - 60 * 60_000,
      lastUpdate: now - 1000,
      cwd: "/home/fixture/arena-fix",
      agent: "worker",
      workflowChildren: {
        inventoryComplete: true,
        children: [
          {
            childId: "review-AF4-0",
            state: "running",
            runId: childRunId,
            agent: "delegate",
          },
        ],
      },
    });
    writeChildLine(path.join(root, workflowRunId), {
      type: "start",
      key: "review-AF4-0",
      runId: childRunId,
    });
    writeStatus(path.join(root, childRunId), {
      runId: childRunId,
      sessionId: SESSION,
      mode: "single",
      state: "running",
      startedAt: now - 10 * 60_000,
      lastUpdate: now - 1000,
      lastActivityAt: now - 1000,
      agent: "delegate",
      parentWorkflowRunId: workflowRunId,
      workflowKey: "review-AF4-0",
    });
  });
  const snapshot = freshScanner(root, now).snapshot();
  const rowKeys = snapshot.workflows.flatMap((workflow) =>
    workflow.children.map((child) => child.rowKey),
  );
  assert.deepEqual(rowKeys.sort(), [
    "90000000-0001-4000-8000-000000000001/review-AF4-0",
    "90000000-0002-4000-8000-000000000002/review-AF4-0",
  ]);
  assert.equal(new Set(rowKeys).size, rowKeys.length);
});

test("P1: the first line of a top-level status.error reaches the row", () => {
  const root = tempDir("agent-view-error-");
  const now = 2_000_000_000_000;
  addRun(root, {
    runId: "a0000000-0001-4000-8000-000000000001",
    sessionId: SESSION,
    mode: "single",
    state: "failed",
    startedAt: now - 60 * 60_000,
    endedAt: now - 50 * 60_000,
    lastUpdate: now - 50 * 60_000,
    agent: "delegate",
    stepStatus: "failed",
    error:
      "429 rate_limit_error: this request would exceed the rate limit\n    at async run",
  });
  const workflow = freshScanner(root, now).snapshot().workflows[0];
  assert.equal(
    workflow.error,
    "429 rate_limit_error: this request would exceed the rate limit",
  );
  assert.equal(workflow.children[0].error, workflow.error);
});

test("P1: run errors and single-run titles are redacted before they reach a row", () => {
  const root = tempDir("agent-view-redact-");
  const now = 2_000_000_000_000;
  addRun(root, {
    runId: "a1000000-0001-4000-8000-000000000001",
    sessionId: SESSION,
    mode: "single",
    state: "failed",
    startedAt: now - 60 * 60_000,
    endedAt: now - 50 * 60_000,
    lastUpdate: now - 50 * 60_000,
    agent: "delegate",
    stepStatus: "failed",
    sessionName: "delegate: use the key sk-ant-api03-SECRETSECRETSECRET",
    error: "auth failed with GITHUB_TOKEN=ghp_abcdefghijklmnopqrst",
  });
  const workflow = freshScanner(root, now).snapshot().workflows[0];
  assert.equal(workflow.title.includes("SECRETSECRETSECRET"), false);
  assert.match(workflow.title, /^delegate: use the key \[redacted/);
  assert.equal(
    workflow.sessionName,
    workflow.title,
    "the dimmed session name is redacted too",
  );
  assert.equal(workflow.error, "auth failed with GITHUB_TOKEN=[redacted]");
  assert.equal(workflow.children[0].error, workflow.error);
});

test("P2: every chain step row uses its own model, effort, start time and output file", () => {
  const root = tempDir("agent-view-chain-");
  const now = 2_000_000_000_000;
  const runId = "a2000000-0001-4000-8000-000000000001";
  writeStatus(path.join(root, runId), {
    runId,
    sessionId: SESSION,
    mode: "chain",
    state: "running",
    startedAt: now - 30 * 60_000,
    lastUpdate: now - 1000,
    cwd: "/home/fixture/quill-b8",
    steps: [
      {
        agent: "worker",
        status: "complete",
        label: "stage-1",
        model: "anthropic/claude-opus-5-5:high",
        startedAt: now - 30 * 60_000,
        durationMs: 12 * 60_000,
      },
      {
        agent: "reviewer",
        status: "running",
        label: "stage-2",
        model: "openai/gpt-6:low",
        startedAt: now - 10 * 60_000,
      },
    ],
  });
  writeEvents(path.join(root, runId), []);
  const children = freshScanner(root, now).snapshot().workflows[0].children;
  assert.equal(children.length, 2);
  // Model-first rows: a mixed-model chain must label every row with its own
  // model, not with step 0's.
  assert.equal(children[0].model, "claude-opus-5-5");
  assert.equal(children[0].effort, "high");
  assert.equal(children[1].model, "gpt-6");
  assert.equal(children[1].effort, "low");
  assert.equal(children[0].agent, "worker");
  assert.equal(children[1].agent, "reviewer");
  assert.equal(children[0].startedAt, now - 30 * 60_000);
  assert.equal(children[0].elapsedMs, 12 * 60_000);
  assert.equal(children[1].startedAt, now - 10 * 60_000);
  assert.equal(children[1].elapsedMs, 10 * 60_000);
  // Enter on step 2 opens step 2's output file, not step 1's.
  assert.match(children[0].outputPath ?? "", /output-0\.log$/);
  assert.match(children[1].outputPath ?? "", /output-1\.log$/);
});

test("F3: a chain step does not show another step's activity", () => {
  const root = tempDir("agent-view-chain-activity-");
  const now = 2_000_000_000_000;
  const runId = "a2100000-0001-4000-8000-000000000001";
  writeStatus(path.join(root, runId), {
    runId,
    sessionId: SESSION,
    mode: "chain",
    state: "running",
    startedAt: now - 30 * 60_000,
    lastUpdate: now - 1000,
    cwd: "/home/fixture/quill-b8",
    steps: [
      {
        agent: "worker",
        status: "complete",
        label: "stage-1",
        startedAt: now - 30 * 60_000,
        durationMs: 12 * 60_000,
      },
      {
        agent: "reviewer",
        status: "running",
        label: "stage-2",
        startedAt: now - 10 * 60_000,
      },
    ],
  });
  writeEvents(path.join(root, runId), [
    {
      ...thinkingMessage(
        "Stage one finished; stage two is next.",
        now - 20 * 60_000,
      ),
      subagentStepIndex: 0,
    },
  ]);
  const children = freshScanner(root, now).snapshot().workflows[0].children;
  assert.equal(children.length, 2);
  assert.equal(
    children[0].activity.thought,
    "Stage one finished; stage two is next.",
  );
  // Step two has no events of its own yet: it must not borrow step one's.
  assert.deepEqual(children[1].activity, {});
});

test("P2: a thin durations.json is not trusted and a running estimate never reads 100%", () => {
  const base = tempDir("agent-view-thin-");
  const root = path.join(base, "runs");
  const historyDir = path.join(base, "history");
  const now = 2_000_000_000_000;
  fs.mkdirSync(historyDir, { recursive: true });
  // Three samples whose median (200 s) is below the 25%-of-default floor for
  // the worker role (5 min), so the default wins instead of a lucky short run.
  fs.writeFileSync(
    path.join(historyDir, "durations.json"),
    JSON.stringify({
      version: 1,
      roles: { worker: [180_000, 200_000, 220_000] },
      recorded: {},
      updatedAt: now,
    }),
  );
  addRun(root, {
    runId: "a3000000-0001-4000-8000-000000000001",
    sessionId: SESSION,
    mode: "single",
    state: "running",
    startedAt: now - 4 * 60_000,
    lastUpdate: now - 500,
    lastActivityAt: now - 500,
    agent: "worker",
    workflowKey: "impl-thin",
  });
  const scanner = new RunScanner({
    runsDir: root,
    historyDir,
    sessionFile: SESSION,
    now: () => now,
  });
  scanner.poll();
  const child = scanner.snapshot().workflows[0].children[0];
  assert.equal(scanner.durationBook.samples("worker"), 3);
  assert.equal(scanner.durationBook.medianMs("worker"), 200_000);
  // 4 min of a floored 5 min expectation: 80 %, not a clamped ~100 %.
  assert.ok(Math.abs(child.progress - 0.8) < 1e-9, String(child.progress));
  assert.equal(scanner.snapshot().workflows[0].expectedMs, 300_000);
});

test("P2: an overrunning run says overrunning with the typical duration, and never 100%", () => {
  const base = tempDir("agent-view-overrun-");
  const root = path.join(base, "runs");
  const historyDir = path.join(base, "history");
  const now = 2_000_000_000_000;
  addRun(root, {
    runId: "a4000000-0001-4000-8000-000000000001",
    sessionId: SESSION,
    mode: "single",
    state: "running",
    // Far past the 20-minute impl default.
    startedAt: now - 90 * 60_000,
    lastUpdate: now - 500,
    lastActivityAt: now - 500,
    agent: "worker",
    workflowKey: "impl-overrun",
  });
  const scanner = new RunScanner({
    runsDir: root,
    historyDir,
    sessionFile: SESSION,
    now: () => now,
  });
  scanner.poll();
  const workflow = scanner.snapshot().workflows[0];
  assert.equal(workflow.children[0].progress, 0.99);
  const bar = workflowBar(workflow);
  assert.ok(bar.text.includes("~99%"), bar.text);
  assert.equal(bar.text.includes("100%"), false, bar.text);
  assert.ok(bar.text.includes("overrunning · typical 20m00s"), bar.text);
});

test("F4: a running workflow with no active child waits, never overruns", () => {
  const root = tempDir("agent-view-waiting-");
  const now = 2_000_000_000_000;
  const runId = "a6000000-0001-4000-8000-000000000001";
  writeStatus(path.join(root, runId), {
    runId,
    sessionId: SESSION,
    mode: "workflow",
    state: "running",
    startedAt: now - 60_000,
    lastUpdate: now - 500,
    cwd: "/home/fixture/waiting",
    workflowChildren: {
      inventoryComplete: true,
      children: [
        {
          childId: "stage-1",
          runId: "a6000000-0002-4000-8000-000000000002",
          agent: "worker",
          state: "queued",
        },
      ],
    },
  });
  writeEvents(path.join(root, runId), []);
  const workflow = freshScanner(root, now).snapshot().workflows[0];
  assert.equal(workflow.activeCount, 0);
  const bar = workflowBar(workflow);
  assert.equal(bar.text.includes("overrunning"), false, bar.text);
  assert.ok(bar.text.includes("waiting for the next agent"), bar.text);
});

test("N6: a running workflow whose only child went stale says so in the bar", () => {
  const root = tempDir("agent-view-stale-wait-");
  const now = 2_000_000_000_000;
  const runId = "a6000000-0002-4000-8000-000000000002";
  const childRunId = "a6000000-0003-4000-8000-000000000003";
  writeStatus(path.join(root, runId), {
    runId,
    sessionId: SESSION,
    mode: "workflow",
    state: "running",
    startedAt: now - 60_000,
    lastUpdate: now - 500,
    cwd: "/home/fixture/stale-wait",
    workflowChildren: {
      inventoryComplete: true,
      children: [
        {
          childId: "stage-1",
          runId: childRunId,
          agent: "worker",
          state: "running",
        },
      ],
    },
  });
  writeEvents(path.join(root, runId), []);
  // The child claims to be running but has no liveness marker: the card says
  // `stale`, so the bar must not promise another agent.
  writeStatus(path.join(root, childRunId), {
    runId: childRunId,
    sessionId: SESSION,
    mode: "single",
    state: "running",
    startedAt: now - 50_000,
    lastUpdate: now - 500,
    agent: "worker",
    workflowKey: "stage-1",
    parentWorkflowRunId: runId,
    marker: false,
  });
  writeChildLine(path.join(root, runId), {
    type: "start",
    key: "stage-1",
    fingerprint: "fp-stage-1",
    runId: childRunId,
  });
  const workflow = freshScanner(root, now).snapshot().workflows[0];
  assert.equal(workflow.children[0].stale, true);
  assert.equal(workflow.activeCount, 0);
  const bar = workflowBar(workflow);
  assert.equal(
    bar.text.includes("waiting for the next agent"),
    false,
    bar.text,
  );
  assert.ok(bar.text.includes("an agent went stale"), bar.text);
});

test("P3: a child that started just before the workflow turned terminal is indexed", () => {
  const root = tempDir("agent-view-final-");
  const now = 2_000_000_000_000;
  const workflowRunId = "a5000000-0001-4000-8000-000000000001";
  const firstChild = "a5000000-0002-4000-8000-000000000002";
  const lateChild = "a5000000-0003-4000-8000-000000000003";
  writeStatus(path.join(root, workflowRunId), {
    runId: workflowRunId,
    sessionId: SESSION,
    mode: "workflow",
    state: "running",
    startedAt: now - 60 * 60_000,
    lastUpdate: now - 1000,
    cwd: "/home/fixture/arena-fix",
    workflowChildren: {
      inventoryComplete: false,
      children: [
        {
          childId: "impl-A1",
          state: "complete",
          runId: firstChild,
          agent: "worker",
        },
      ],
    },
  });
  writeChildLine(path.join(root, workflowRunId), {
    type: "start",
    key: "impl-A1",
    runId: firstChild,
  });
  writeEvents(path.join(root, workflowRunId), []);
  const scanner = freshScanner(root, now);
  assert.deepEqual(
    scanner.snapshot().workflows[0].children.map((child) => child.key),
    ["impl-A1"],
  );

  // The workflow turns terminal and a child's `start` line lands in the same
  // breath: the closing pass must still index it.
  writeStatus(path.join(root, workflowRunId), {
    runId: workflowRunId,
    sessionId: SESSION,
    mode: "workflow",
    state: "complete",
    startedAt: now - 60 * 60_000,
    endedAt: now,
    lastUpdate: now,
    cwd: "/home/fixture/arena-fix",
    workflowChildren: {
      inventoryComplete: true,
      children: [
        {
          childId: "impl-A1",
          state: "complete",
          runId: firstChild,
          agent: "worker",
        },
        {
          childId: "impl-A2",
          state: "complete",
          runId: lateChild,
          agent: "worker",
        },
      ],
    },
  });
  writeChildLine(path.join(root, workflowRunId), {
    type: "start",
    key: "impl-A2",
    runId: lateChild,
  });
  scanner.poll();
  assert.deepEqual(
    scanner.snapshot().workflows[0].children.map((child) => child.key),
    ["impl-A1", "impl-A2"],
  );
});
