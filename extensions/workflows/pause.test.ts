import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import type {
  AgentSessionEventListener,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { PauseGate } from "./pause.ts";
import {
  createFirstResponseWatchdog,
  guardWorkflowChildTools,
  guardWorkflowModelRequests,
  guardWorkflowRuntimeRequests,
  type WorkflowModel,
} from "./runner.ts";
import {
  ModelRuntime,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  normalizeContext,
} from "@earendil-works/pi-ai";

function latch() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("pause drains already admitted work and holds new operations until resume", async () => {
  const gate = new PauseGate();
  const drain = latch();
  let started = false;
  const first = gate.operation(async () => {
    started = true;
    await drain.promise;
  });
  await delay(1);
  assert.equal(started, true);
  gate.requestPause();
  assert.equal(gate.state, "pausing");
  let secondStarted = false;
  const second = gate.operation(async () => {
    secondStarted = true;
  });
  drain.resolve();
  await first;
  assert.equal(gate.state, "paused");
  await delay(10);
  assert.equal(secondStarted, false);
  gate.resume();
  await second;
  assert.equal(secondStarted, true);
});

test("nested calls can finish the current tool without deadlocking pause", async () => {
  const gate = new PauseGate();
  await gate.operation(async () => {
    gate.requestPause();
    await gate.operation(async () => {
      assert.equal(gate.state, "pausing");
    });
  });
  assert.equal(gate.state, "paused");
});

test("cancel rejects paused waiters without resuming any operation", async () => {
  const gate = new PauseGate();
  gate.requestPause();
  const waiting = gate.operation(async () => {
    throw new Error("must not start");
  });
  gate.abort("user cancelled");
  await assert.rejects(waiting, /user cancelled/);
});

test("admission rechecks pause after a racing resume", async () => {
  const gate = new PauseGate();
  gate.requestPause();
  let started = false;
  const operation = gate.operation(async () => {
    started = true;
  });
  gate.resume();
  gate.requestPause();
  await delay(5);
  assert.equal(started, false);
  gate.resume();
  await operation;
});

test("aborted invocation wakes a paused waiter", async () => {
  const gate = new PauseGate();
  gate.requestPause();
  const ac = new AbortController();
  const pending = gate.wait(ac.signal);
  ac.abort(new Error("cancelled request"));
  await assert.rejects(pending, /cancelled request/);
});

test("paused time does not consume the first-response watchdog", async () => {
  const gate = new PauseGate();
  gate.requestPause();
  let fired = false;
  const watchdog = createFirstResponseWatchdog(
    async () => {
      fired = true;
    },
    { timeoutMs: 10, deferStart: true },
  );
  const done = latch();
  const waiting = watchdog.waitFor(done.promise);
  await delay(30);
  assert.equal(fired, false);
  gate.resume();
  watchdog.start();
  watchdog.markResponse();
  done.resolve();
  await waiting;
});

test("tool deadlines begin only after resume; timed-out real work still drains", async () => {
  const gate = new PauseGate();
  gate.requestPause();
  const work = latch();
  let ran = false;
  const tool: ToolDefinition = {
    name: "fixture",
    label: "fixture",
    description: "fixture",
    parameters: Type.Object({}),
    execute: async () => {
      ran = true;
      await work.promise;
      return { content: [], details: undefined };
    },
  };
  let listener: AgentSessionEventListener | undefined;
  const registry = {
    getAllTools: () => [{ name: tool.name }],
    getToolDefinition: () => tool,
    subscribe: (callback: AgentSessionEventListener) => {
      listener = callback;
      return () => {};
    },
  };
  const cleanup = guardWorkflowChildTools(registry, 10, gate);
  const execute = tool.execute;
  listener?.({ type: "agent_start" });
  assert.equal(tool.execute, execute, "must not double wrap existing tools");
  // Context is deliberately absent: this fixture ignores it.
  const run = execute.call(
    tool,
    "call",
    {},
    undefined,
    undefined,
    {} as Parameters<typeof execute>[4],
  );
  const rejected = assert.rejects(run, /timed out/);
  await delay(30);
  assert.equal(ran, false);
  gate.resume();
  await rejected;
  gate.requestPause();
  assert.equal(
    gate.state,
    "pausing",
    "timeout cannot hide still-executing tool code",
  );
  work.resolve();
  await delay(1);
  assert.equal(gate.state, "paused");
  cleanup();
});

const fixtureModel = {
  id: "fixture",
  name: "fixture",
  provider: "fixture",
  api: "openai-responses",
  baseUrl: "http://unused",
  reasoning: false,
  input: ["text"],
  contextWindow: 4096,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies WorkflowModel;

test("model stream admission gates normal and compaction requests and drains real responses", async () => {
  const gate = new PauseGate();
  gate.requestPause();
  const response = createAssistantMessageEventStream();
  let calls = 0;
  const owner: Parameters<typeof guardWorkflowModelRequests>[0] = {
    agent: {
      streamFunction: () => {
        calls++;
        return response;
      },
    },
  };
  const restore = guardWorkflowModelRequests(owner, gate);
  const pending = owner.agent.streamFunction(
    fixtureModel,
    normalizeContext({ messages: [] }),
  );
  await delay(10);
  assert.equal(calls, 0);
  gate.resume();
  await pending;
  gate.requestPause();
  assert.equal(gate.state, "pausing");
  response.push({
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  });
  await delay(1);
  assert.equal(gate.state, "paused");
  restore();
});

test("cancellation while waiting for model admission cannot start a provider request", async () => {
  const gate = new PauseGate();
  gate.requestPause();
  let calls = 0;
  const owner: Parameters<typeof guardWorkflowModelRequests>[0] = {
    agent: {
      streamFunction: () => {
        calls++;
        return createAssistantMessageEventStream();
      },
    },
  };
  const restore = guardWorkflowModelRequests(owner, gate);
  const ac = new AbortController();
  const pending = owner.agent.streamFunction(
    fixtureModel,
    normalizeContext({ messages: [] }),
    { signal: ac.signal },
  );
  ac.abort(new Error("cancelled"));
  await assert.rejects(Promise.resolve(pending), /cancelled/);
  assert.equal(calls, 0);
  restore();
});

test("runtime registry completion is gated, not just the agent stream", async () => {
  const gate = new PauseGate();
  gate.requestPause();
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  const response = createAssistantMessageEventStream();
  let calls = 0;
  runtime.streamSimple = () => {
    calls++;
    return response;
  };
  const restore = guardWorkflowRuntimeRequests(runtime, gate);
  const pending = runtime.completeSimple(fixtureModel, { messages: [] });
  await delay(10);
  assert.equal(calls, 0);
  gate.resume();
  await delay(1);
  assert.equal(calls, 1);
  gate.requestPause();
  assert.equal(gate.state, "pausing");
  response.push({
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  });
  await pending;
  await delay(1);
  assert.equal(gate.state, "paused");
  restore();
});

test("admitted silent model keeps its watchdog while a pause drains it", async () => {
  const gate = new PauseGate();
  const release = await gate.enter();
  let fired = false;
  const watchdog = createFirstResponseWatchdog(
    async () => {
      fired = true;
      release();
    },
    { timeoutMs: 10, deferStart: true },
  );
  watchdog.start();
  gate.requestPause();
  await assert.rejects(
    watchdog.waitFor(new Promise<never>(() => {})),
    /stalled/,
  );
  assert.equal(fired, true);
  assert.equal(gate.state, "paused");
});

test("tools registered during a turn are guarded at the tool-call boundary", async () => {
  const gate = new PauseGate();
  gate.requestPause();
  const definitions = new Map<string, ToolDefinition>();
  const extensionRunner: Pick<AgentSession["extensionRunner"], "emitToolCall"> =
    { emitToolCall: async () => undefined };
  const registry = {
    extensionRunner,
    getAllTools: () => [...definitions.keys()].map((name) => ({ name })),
    getToolDefinition: (name: string) => definitions.get(name),
    subscribe: () => () => {},
  };
  const cleanup = guardWorkflowChildTools(registry, 20, gate);
  let called = false;
  const tool: ToolDefinition = {
    name: "late",
    label: "late",
    description: "late",
    parameters: Type.Object({}),
    execute: async () => {
      called = true;
      return { content: [], details: undefined };
    },
  };
  definitions.set(tool.name, tool);
  await extensionRunner.emitToolCall({
    type: "tool_call",
    toolCallId: "id",
    toolName: "late",
    input: {},
  });
  const pending = tool.execute(
    "id",
    {},
    undefined,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );
  await delay(30);
  assert.equal(called, false);
  gate.resume();
  await pending;
  assert.equal(called, true);
  cleanup();
});

test("an admitted virtual request can finish routing after pause without deadlocking", async () => {
  const gate = new PauseGate();
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  const response = createAssistantMessageEventStream();
  let physicalCalls = 0;
  runtime.streamSimple = (model, context, options) => {
    if (model.id === "virtual-fixture") {
      gate.requestPause();
      return runtime.streamSimple(fixtureModel, context, options);
    }
    physicalCalls++;
    return response;
  };
  const restore = guardWorkflowRuntimeRequests(runtime, gate);
  const pending = runtime.completeSimple(
    { ...fixtureModel, id: "virtual-fixture" },
    { messages: [] },
  );
  await delay(10);
  assert.equal(physicalCalls, 1);
  assert.equal(gate.state, "pausing");
  response.push({
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  });
  await pending;
  await delay(1);
  assert.equal(gate.state, "paused");
  restore();
});
