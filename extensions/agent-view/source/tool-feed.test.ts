import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyEvent,
  bubbleText,
  emptyActivity,
  toolDisplayName,
} from "./derive.ts";

test("mentioning a tool in shell output is not an invocation of it", () => {
  assert.equal(
    toolDisplayName("bash", { command: "echo higgsfield generate" }),
    "Bash",
  );
  assert.equal(
    toolDisplayName("bash", { command: "higgsfield generate --prompt demo" }),
    "Higgsfield",
  );
  assert.equal(
    toolDisplayName("bash", { command: "/usr/local/bin/higgsfield generate" }),
    "Higgsfield",
  );
});

test("tool-only activity never becomes bubble text", () => {
  const activity = emptyActivity();
  applyEvent(activity, {
    type: "tool_execution_start",
    toolName: "firecrawl_scrape",
    toolCallId: "f1",
    args: { url: "https://example.org" },
    observedAt: 10,
  });
  assert.equal(bubbleText(activity), undefined);
});

test("recent tools survive completion, have brand labels, and contain no arguments", () => {
  const activity = emptyActivity();
  for (const [id, name, args] of [
    [
      "f1",
      "mcp",
      {
        tool: "firecrawl_scrape",
        args: { url: "https://user:secret@example.org" },
      },
    ],
    ["b1", "search", { query: "SECRET" }],
    ["h1", "bash", { command: "higgsfield generate --prompt SECRET" }],
  ] as const) {
    applyEvent(activity, {
      type: "tool_execution_start",
      toolName: name,
      toolCallId: id,
      args,
      observedAt: 10,
    });
    applyEvent(activity, {
      type: "tool_execution_end",
      toolName: name,
      toolCallId: id,
      observedAt: 20,
    });
  }
  assert.deepEqual(
    activity.recentTools?.map((tool) => tool.label),
    ["Firecrawl", "Brave", "Higgsfield"],
  );
  assert.doesNotMatch(
    JSON.stringify(activity.recentTools),
    /SECRET|secret|example.org/,
  );
});

test("the feed is bounded and failed results update only their own invocation", () => {
  const activity = emptyActivity();
  for (let i = 0; i < 20; i += 1) {
    applyEvent(activity, {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: `r${i}`,
      observedAt: i,
    });
  }
  assert.equal(activity.recentTools?.length, 8);
  applyEvent(activity, {
    type: "tool_execution_end",
    toolName: "read",
    toolCallId: "r18",
    isError: true,
    observedAt: 30,
  });
  assert.equal(
    activity.recentTools?.find((tool) => tool.id === "r18")?.failed,
    true,
  );
  assert.equal(
    activity.recentTools?.find((tool) => tool.id === "r19")?.failed,
    false,
  );
});

test("repeated starts with the same call id are not duplicated", () => {
  const activity = emptyActivity();
  const event = {
    type: "tool_execution_start",
    toolName: "search",
    toolCallId: "one",
    observedAt: 1,
  };
  applyEvent(activity, event);
  applyEvent(activity, event);
  assert.equal(activity.recentTools?.length, 1);
});
