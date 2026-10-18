import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  emptyUsage,
  type AgentRecord,
  type Theme,
  type WorkflowDetails,
} from "./model.ts";
import {
  renderWorkflowProgress,
  workflowProgress,
  WorkflowProgressSlots,
} from "./progress-bar.ts";

export function fixtureRun(
  runId: string,
  values: Partial<WorkflowDetails> = {},
): WorkflowDetails {
  return {
    runId,
    sessionId: "owner",
    name: runId,
    background: true,
    independent: true,
    status: "running",
    startedAt: 1,
    phases: [{ title: "Scan" }, { title: "Build" }, { title: "Verify" }],
    currentPhase: "Scan",
    agents: [],
    ...values,
  };
}
function agent(
  state: AgentRecord["state"],
  phase: string | undefined,
): AgentRecord {
  return {
    index: 1,
    label: "fixture",
    phase,
    state,
    startedAt: 1,
    preview: "",
    usage: emptyUsage(),
    transcript: [],
  };
}
const colors: Record<string, number> = {
  error: 31,
  accent: 34,
  syntaxFunction: 35,
  syntaxNumber: 36,
  syntaxVariable: 33,
  syntaxType: 32,
  dim: 90,
  borderMuted: 90,
  warning: 33,
};
export const fixtureTheme = {
  fg: (name: string, text: string) =>
    text ? `\x1b[${colors[name] ?? 37}m${text}\x1b[0m` : "",
  bold: (text: string) => text,
} as unknown as Theme;

const render = (details: WorkflowDetails, width = 100) =>
  renderWorkflowProgress([workflowProgress(details)], width, fixtureTheme);

test("only exact session ownership is eligible, including foreground workflows", () => {
  const slots = new WorkflowProgressSlots();
  assert.deepEqual(
    slots
      .update(
        [
          fixtureRun("own", { background: false }),
          fixtureRun("foreign", { sessionId: "another" }),
          fixtureRun("missing", { sessionId: undefined }),
        ],
        "owner",
      )
      .map((run) => run.runId),
    ["own"],
  );
  assert.deepEqual(
    slots.update([fixtureRun("missing", { sessionId: undefined })], undefined),
    [],
  );
});

test("finished bars are retained until a later spawn, not removed on the next refresh", () => {
  const slots = new WorkflowProgressSlots();
  const finished = fixtureRun("a", {
    status: "completed",
    startedAt: 1,
    finishedAt: 5,
  });
  assert.equal(slots.update([finished], "owner")[0].status, "completed");
  assert.equal(
    slots.update([], "owner")[0].runId,
    "a",
    "a temporarily unreadable artifact must not erase a retained bar",
  );
  const next = fixtureRun("b", { startedAt: 6 });
  assert.deepEqual(
    slots.update([finished, next], "owner").map((run) => run.runId),
    ["b"],
  );
});

test("all overlapping and paused runs stay visible; a later run reuses the oldest finished slot", () => {
  const slots = new WorkflowProgressSlots();
  const a = fixtureRun("a", { startedAt: 1, status: "paused" });
  const b = fixtureRun("b", { startedAt: 2 });
  assert.deepEqual(
    slots.update([a, b], "owner").map((run) => run.runId),
    ["a", "b"],
  );
  const completeB = { ...b, status: "completed" as const, finishedAt: 4 };
  const c = fixtureRun("c", { startedAt: 5 });
  assert.deepEqual(
    slots.update([a, completeB, c], "owner").map((run) => run.runId),
    ["a", "c"],
  );
});

test("cold reload reconstructs overlap from timestamps instead of collapsing history", () => {
  const slots = new WorkflowProgressSlots();
  const a = fixtureRun("a", {
    startedAt: 1,
    finishedAt: 10,
    status: "completed",
  });
  const b = fixtureRun("b", {
    startedAt: 2,
    finishedAt: 8,
    status: "completed",
  });
  const c = fixtureRun("c", {
    startedAt: 11,
    finishedAt: 15,
    status: "completed",
  });
  assert.deepEqual(
    slots.update([c, b, a], "owner").map((run) => run.runId),
    ["a", "c"],
  );
  assert.deepEqual(
    slots.update([c, b, a], "owner").map((run) => run.runId),
    ["a", "c"],
    "replaced historical bars must not reappear",
  );
});

test("foreign spawns do not evict a finished local bar; switching session clears old slots", () => {
  const slots = new WorkflowProgressSlots();
  const a = fixtureRun("a", { status: "failed", finishedAt: 5 });
  const b = fixtureRun("b", { startedAt: 6, sessionId: "other" });
  assert.deepEqual(
    slots.update([a, b], "owner").map((run) => run.runId),
    ["a"],
  );
  assert.deepEqual(
    slots.update([a, b], "other").map((run) => run.runId),
    ["b"],
  );
});

test("partial agent failures remain visibly red even when the overall script completes", () => {
  const run = fixtureRun("audit", {
    status: "completed",
    currentPhase: "Build",
    agents: [agent("done", "Scan"), agent("error", "Build")],
  });
  const lines = render(run);
  assert.match(
    stripTerminalSequences(lines[0]),
    /Finished with errors.*1 failed/,
  );
  assert.match(lines[1], /\x1b\[31m█+/);
  assert.match(stripTerminalSequences(lines[2]), /Build.*1 failed/);
  assert.match(stripTerminalSequences(lines[2]), /1 phase not run/);
  assert.equal(
    workflowProgress(run).phases[2].skipped,
    true,
    "unvisited phases are not fabricated successes",
  );
});

test("a script-level failure without failed agents marks the implicated phase", () => {
  const lines = render(
    fixtureRun("fatal", {
      status: "failed",
      currentPhase: "Verify",
      error: "script failed",
      agents: [agent("done", "Scan")],
    }),
  );
  assert.match(stripTerminalSequences(lines[0]), /Workflow failed/);
  assert.match(stripTerminalSequences(lines[2]), /Verify: failed/);
  assert.match(lines[1], /\x1b\[31m█+/);
  assert.equal(lines.length, 3);
  assert.equal(
    lines.map(stripTerminalSequences).join("\n").includes("script failed"),
    false,
  );
});

test("unknown and unphased agent failures are not dropped from the bar", () => {
  const view = workflowProgress(
    fixtureRun("unknown", {
      agents: [agent("error", "Extra phase"), agent("error", undefined)],
    }),
  );
  assert.equal(view.failed, 2);
  assert.deepEqual(
    view.phases.filter((phase) => phase.failed).map((phase) => phase.title),
    ["Extra phase", "Unphased"],
  );
});

test("each declared phase gets a distinct colour, and paused work stays marked as in-flight", () => {
  const run = fixtureRun("paused", {
    status: "paused",
    currentPhase: "Build",
    agents: [agent("done", "Scan"), agent("running", "Build")],
  });
  const lines = render(run);
  assert.match(lines[1], /\x1b\[34m█/);
  assert.match(lines[1], /\x1b\[35m▒/);
  assert.match(stripTerminalSequences(lines[0]), /Paused/);
});

test("all known agents finishing does not falsely finish the current phase", () => {
  const run = fixtureRun("dynamic", { agents: [agent("done", "Scan")] });
  const lines = render(run);
  assert.match(lines[1], /▒/);
  assert.match(stripTerminalSequences(lines[0]), /1 succeeded/);
  assert.equal(lines.join("").includes("100%"), false);
});

test("narrow/wide terminals and hostile labels cannot overflow or inject terminal commands", () => {
  const run = fixtureRun("unicode", {
    name: "\x1b[2JInjected\n\t名字 🚀 long long name",
    currentPhase: "Scan",
    agents: [agent("error", "Scan")],
    phases: Array.from({ length: 9 }, (_, index) => ({
      title: index ? `阶段 ${index}` : "Scan",
    })),
  });
  for (const width of [0, 1, 2, 3, 7, 12, 20, 40, 80, 160]) {
    for (const line of render(run, width)) {
      assert.ok(
        visibleWidth(line) <= width,
        `${visibleWidth(line)} > ${width}`,
      );
      assert.equal(line.includes("\x1b[2J"), false);
      assert.equal(/[\n\t]/.test(line), false);
    }
  }
  assert.match(
    stripTerminalSequences(render(run, 160)[0]),
    /Running with errors/,
  );
  assert.equal(render(run, 160).length, 3);
});

test("interrupted workflows are labelled instead of quietly looking successful", () => {
  const lines = render(
    fixtureRun("lost", {
      status: "interrupted",
      agents: [agent("running", "Scan")],
    }),
  );
  assert.match(stripTerminalSequences(lines[0]), /Interrupted/);
  assert.match(lines[1], /\x1b\[31m█+/);
});

test("a failed late phase still gets a red cell when there are fewer columns than phases", () => {
  const run = fixtureRun("late", {
    currentPhase: "Verify",
    agents: [agent("error", "Verify")],
  });
  const lines = render(run, 2);
  assert.match(lines[1], /\x1b\[31m█/);
  assert.equal(visibleWidth(lines[1]), 2);
});

test("no-plan, no-agent workflows render without NaN or division by zero", () => {
  for (const status of ["running", "completed", "failed"] as const) {
    const lines = render(
      fixtureRun("empty", { status, phases: [], currentPhase: undefined }),
    );
    assert.ok(lines.length >= 3);
    assert.equal(lines.join("").includes("NaN"), false);
  }
});
