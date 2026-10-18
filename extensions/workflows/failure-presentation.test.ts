import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { emptyUsage, type Theme, type WorkflowDetails } from "./model.ts";
import { renderWorkflowProgress, workflowProgress } from "./progress-bar.ts";

const theme = {
  fg: (name: string, text: string) =>
    text ? `\x1b[${name === "error" ? 31 : 37}m${text}\x1b[0m` : "",
  bold: (text: string) => text,
} as unknown as Theme;
function screenshotRun(): WorkflowDetails {
  return {
    runId: "wf_fixture",
    sessionId: "owner",
    background: true,
    status: "completed",
    name: "quill-investigate-repair-recover",
    startedAt: 1,
    finishedAt: 10,
    currentPhase: "Investigate tests",
    phases: [
      "Investigate tests",
      "Repair baseline",
      "Verify baseline",
      "Implement stages",
      "Audit stages",
      "Repair findings",
      "Final verification",
    ].map((title) => ({ title })),
    agents: ["concurrency", "network-timeouts", "state-contracts"].map(
      (suffix, index) => ({
        index: index + 1,
        label: `investigate:${suffix}`,
        phase: "Investigate tests",
        state: index === 1 ? "error" : "done",
        error: index === 1 ? "WebSocket closed 1012" : undefined,
        startedAt: 1,
        finishedAt: 9,
        preview: "",
        usage: emptyUsage(),
        transcript: [],
      }),
    ),
  };
}
const display = (run: WorkflowDetails, width: number) =>
  renderWorkflowProgress([workflowProgress(run)], width, theme);

test("normal chat retains failure outcome and phase counts without agent/error diagnostic rows", () => {
  const run = screenshotRun();
  const lines = display(run, 300);
  const text = lines.map(stripTerminalSequences).join("\n");
  assert.equal(lines.length, 3);
  assert.match(text, /Finished with errors/);
  assert.match(text, /2 succeeded, 1 failed/);
  assert.match(text, /Investigate tests/);
  assert.match(text, /6 phases not run/);
  assert.equal(text.includes("Failed agent:"), false);
  assert.equal(text.includes("investigate:network-timeouts"), false);
  assert.equal(text.includes("WebSocket closed 1012"), false);
  assert.equal(text.includes("Details:"), false);
  assert.equal(visibleWidth(lines[1]), 96);
  assert.match(lines[1], /\x1b\[31m█+/);
  assert.equal(
    run.agents[1].error,
    "WebSocket closed 1012",
    "dashboard/artifact diagnostic data is untouched",
  );
});

test("long recorded errors never expand normal chat or break terminal width", () => {
  const run = screenshotRun();
  run.agents[1].error =
    "WebSocket closed 1012 " + "supporting detail ".repeat(100);
  for (const width of [1, 2, 10, 40, 80, 120, 300]) {
    const lines = display(run, width);
    assert.equal(lines.length, 3);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
    assert.equal(
      lines
        .map(stripTerminalSequences)
        .join("\n")
        .includes("supporting detail"),
      false,
    );
  }
});

test("many failures show the total while keeping one compact three-row workflow", () => {
  const run = screenshotRun();
  run.agents = Array.from({ length: 8 }, (_, index) => ({
    ...run.agents[1],
    index,
    label: `failed-agent-${index}`,
  }));
  const lines = display(run, 120);
  assert.equal(lines.length, 3);
  assert.match(lines.map(stripTerminalSequences).join("\n"), /8 failed/);
  assert.equal(lines.join("").includes("Failed agent:"), false);
});

test("script-level and hostile diagnostic text stays out of the widget without hiding failure state", () => {
  const run = screenshotRun();
  run.status = "failed";
  run.error = "\x1b[2Jscript detail to inspect in /workflows";
  run.agents[1].error = "\x1b[2JWebSocket\nclosed\t1012";
  const lines = display(run, 120);
  assert.equal(lines.length, 3);
  const text = lines.map(stripTerminalSequences).join("\n");
  assert.match(text, /Workflow failed/);
  assert.equal(lines.join("").includes("\x1b[2J"), false);
  assert.equal(text.includes("script detail"), false);
  assert.equal(text.includes("WebSocket"), false);
});
