import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { persistWorkflowJson } from "./artifacts.ts";
import { WorkflowDashboard, loadRunEntries } from "./dashboard.ts";
import type { Theme, WorkflowDetails } from "./model.ts";
import { processIdentity, serveWorkflowControl } from "./transport.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Dashboard fixture timed out");
    await delay(5);
  }
}

test("a new session can find a paused run, resume with p, and cancel only after x twice", async () => {
  // Short prefix: <base>/workflows/<runId>/control.sock must fit the 107-byte
  // AF_UNIX path limit even when TMPDIR is a long disk-backed lane directory.
  const base = mkdtempSync(join(tmpdir(), "pwd-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = base;
  const runId = "wf_abcdef123456";
  const runDir = join(base, "workflows", runId);
  const details: WorkflowDetails = {
    runId,
    sessionId: "old-session",
    independent: true,
    status: "paused",
    background: true,
    startedAt: Date.now(),
    agents: [],
    phases: [],
  };
  const actions: string[] = [];
  let dashboard: WorkflowDashboard | undefined;
  let close: (() => Promise<void>) | undefined;
  try {
    persistWorkflowJson(runDir, details);
    writeFileSync(
      join(runDir, "worker.json"),
      JSON.stringify(processIdentity()),
    );
    writeFileSync(join(runDir, "script.js"), "return null;");
    const entries = loadRunEntries(new Map(), "new-session", new Set());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].details.status, "paused");
    assert.equal(entries[0].live, true);
    close = await serveWorkflowControl(runDir, (command) => {
      actions.push(command);
      if (command === "resume") details.status = "running";
      if (command === "pause") details.status = "paused";
      if (command === "cancel") details.status = "aborted";
      persistWorkflowJson(runDir, details);
      return { status: details.status };
    });
    const tui = {
      terminal: { rows: 30 },
      requestRender() {},
    } as unknown as TUI;
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;
    const bindings = {
      matches: () => false,
      getKeys: () => ["key"],
    } as unknown as KeybindingsManager;
    dashboard = new WorkflowDashboard(
      tui,
      theme,
      bindings,
      () => new Map(),
      "new-session",
      new Set(),
      () => {},
    );
    dashboard.handleInput("p");
    await until(() =>
      dashboard!.render(120).some((line) => line.includes("resume → running")),
    );
    assert.deepEqual(actions, ["resume"]);
    dashboard.handleInput("x");
    await delay(20);
    assert.deepEqual(actions, ["resume"], "first x must not cancel");
    dashboard.handleInput("x");
    await until(() => actions.includes("cancel"));
    assert.equal(existsSync(join(runDir, "script.js")), true);
    assert.equal(existsSync(join(runDir, "workflow.json")), true);
    assert.equal(existsSync(join(runDir, "transcripts.json")), true);
  } finally {
    dashboard?.dispose();
    await close?.();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(base, { recursive: true, force: true });
  }
});
