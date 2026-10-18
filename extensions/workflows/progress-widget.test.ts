import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import workflows from "./index.ts";
import { persistWorkflowJson } from "./artifacts.ts";
import { emptyUsage, type Theme, type WorkflowDetails } from "./model.ts";
import { WORKFLOW_PROGRESS_WIDGET } from "./progress-bar.ts";
import { processIdentity } from "./transport.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Widget fixture timed out");
    await delay(10);
  }
}

test("normal chat mounts phase bars below the prompt, polls only its session, reuses finished slots and cleans up", async () => {
  const base = mkdtempSync(join(tmpdir(), "pi-workflow-widget-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = base;
  const events = new Map<
    string,
    (event: { type: string }, ctx: ExtensionContext) => unknown
  >();
  const widgets = new Map<string, Component & { dispose?(): void }>();
  const placements: string[] = [];
  const statuses: string[] = [];
  let currentSession = "owner";
  let renderRequests = 0;
  let factories = 0;
  let modelMessages = 0;
  const tui = {
    requestRender: () => {
      renderRequests++;
    },
  } as unknown as TUI;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const ui = {
    setStatus: (_key: string, value: string | undefined) => {
      statuses.push(value ?? "");
    },
    setWidget: (
      key: string,
      factory:
        | ((tui: TUI, theme: Theme) => Component & { dispose?(): void })
        | undefined,
      options?: { placement: string },
    ) => {
      widgets.get(key)?.dispose?.();
      if (!factory) {
        widgets.delete(key);
        return;
      }
      factories++;
      placements.push(options?.placement ?? "aboveEditor");
      widgets.set(key, factory(tui, theme));
    },
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui,
    sessionManager: {
      getSessionId: () => currentSession,
      getEntries: () => [],
    },
  } as unknown as ExtensionContext;
  const api = {
    registerCommand() {},
    registerTool() {},
    on: (
      name: string,
      handler: (event: { type: string }, ctx: ExtensionContext) => unknown,
    ) => {
      events.set(name, handler);
    },
    sendUserMessage() {
      modelMessages++;
    },
  } as unknown as ExtensionAPI;
  const lines = () =>
    widgets.get(WORKFLOW_PROGRESS_WIDGET)?.render(120).join("\n") ?? "";
  function persist(details: WorkflowDetails) {
    const dir = join(base, "workflows", details.runId);
    persistWorkflowJson(dir, details);
    writeFileSync(join(dir, "worker.json"), JSON.stringify(processIdentity()));
  }
  const own: WorkflowDetails = {
    runId: "wf_aaa",
    name: "LOCAL OLD JOB",
    sessionId: "owner",
    background: false,
    independent: true,
    status: "running",
    startedAt: 1,
    phases: [{ title: "Scan" }, { title: "Build" }],
    currentPhase: "Build",
    agents: [
      {
        index: 1,
        label: "broken",
        phase: "Scan",
        state: "error",
        startedAt: 1,
        preview: "",
        usage: emptyUsage(),
        transcript: [],
      },
    ],
  };
  const foreign = {
    ...own,
    runId: "wf_bbb",
    name: "FOREIGN JOB",
    sessionId: "other",
    agents: [],
  };
  try {
    persist(own);
    persist(foreign);
    workflows(api);
    events.get("session_start")?.({ type: "session_start" }, ctx);
    assert.deepEqual(placements, ["belowEditor"]);
    assert.match(lines(), /LOCAL OLD JOB/);
    assert.match(lines(), /Running with errors/);
    assert.equal(lines().includes("Failed agent:"), false);
    assert.equal(widgets.get(WORKFLOW_PROGRESS_WIDGET)!.render(120).length, 3);
    assert.equal(lines().includes("FOREIGN JOB"), false);
    assert.match(statuses.at(-1)!, /1 running/);

    const finished = { ...own, status: "completed" as const, finishedAt: 5 };
    persist(finished);
    await until(() => lines().includes("Finished with errors"));
    assert.match(lines(), /LOCAL OLD JOB/);
    assert.equal(
      factories,
      1,
      "polling must update, not remount, the component",
    );
    persist({
      ...foreign,
      runId: "wf_ccc",
      startedAt: 6,
      name: "SECOND FOREIGN JOB",
    });
    await delay(1050);
    assert.match(lines(), /LOCAL OLD JOB/);

    persist({
      ...own,
      runId: "wf_ddd",
      name: "LOCAL NEW JOB",
      startedAt: 6,
      agents: [],
    });
    await until(() => lines().includes("LOCAL NEW JOB"));
    assert.equal(lines().includes("LOCAL OLD JOB"), false);
    assert.equal(lines().includes("FOREIGN JOB"), false);
    assert.ok(renderRequests > 0);

    currentSession = "other";
    events.get("session_start")?.({ type: "session_start" }, ctx);
    assert.equal(lines().includes("LOCAL NEW JOB"), false);
    assert.match(lines(), /FOREIGN JOB/);
    assert.match(lines(), /SECOND FOREIGN JOB/);
    events.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    assert.equal(widgets.size, 0);
    assert.equal(
      modelMessages,
      0,
      "UI validation must never send a prompt or call a model",
    );
  } finally {
    events.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(base, { recursive: true, force: true });
  }
});
