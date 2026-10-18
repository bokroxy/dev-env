import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import workflows from "./index.ts";
import { persistWorkflowJson } from "./artifacts.ts";

function client(history: SessionEntry[], sent: string[]) {
  const events = new Map<
    string,
    (event: { type: string }, ctx: ExtensionContext) => unknown
  >();
  const api = {
    registerCommand() {},
    registerTool() {},
    on: (
      event: string,
      handler: (event: { type: string }, ctx: ExtensionContext) => unknown,
    ) => {
      events.set(event, handler);
    },
    sendUserMessage: (message: string) => {
      sent.push(message);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "rpc",
    hasUI: false,
    sessionManager: { getSessionId: () => "owner", getEntries: () => history },
  } as unknown as ExtensionContext;
  workflows(api);
  return {
    start: () => events.get("session_start")?.({ type: "session_start" }, ctx),
    shutdown: () =>
      events.get("session_shutdown")?.({ type: "session_shutdown" }, ctx),
  };
}

test("RPC/reloaded clients reconcile missed completion from artifacts and durable transcript receipts", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-workflow-client-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = base;
  const sent: string[] = [];
  const history: SessionEntry[] = [];
  let first: ReturnType<typeof client> | undefined;
  let reloaded: ReturnType<typeof client> | undefined;
  try {
    persistWorkflowJson(join(base, "workflows", "wf_abcdef"), {
      runId: "wf_abcdef",
      sessionId: "owner",
      background: true,
      independent: true,
      status: "completed",
      startedAt: Date.now(),
      finishedAt: Date.now(),
      agents: [],
      phases: [],
      result: "retained",
    });
    first = client(history, sent);
    first.start();
    assert.equal(
      sent.length,
      1,
      "completion should arrive even though this client did not launch the run",
    );
    assert.match(sent[0], /Background workflow wf_abcdef completed/);
    history.push({
      type: "message",
      id: "receipt",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: sent[0], timestamp: Date.now() },
    });
    first.shutdown();
    reloaded = client(history, sent);
    reloaded.start();
    assert.equal(
      sent.length,
      1,
      "persisted follow-up must not be sent again on reload",
    );
  } finally {
    first?.shutdown();
    reloaded?.shutdown();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(base, { recursive: true, force: true });
  }
});
