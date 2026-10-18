import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyEvent,
  applyEventLine,
  bubbleText,
  condense,
  currentThought,
  emptyActivity,
  eventStepIndex,
  parseEventLine,
  toolLine,
} from "./derive.ts";

test("tool lines name the tool and its salient argument", () => {
  assert.equal(
    toolLine("read", { path: "/tmp/report.md" }),
    "read: /tmp/report.md",
  );
  assert.equal(
    toolLine("bash", { command: "go test -race ./..." }),
    "bash: go test -race ./...",
  );
  assert.equal(
    toolLine("search", { query: "blobatar placeholder" }),
    "search: blobatar placeholder",
  );
  assert.equal(
    toolLine("scrape", { url: "https://example.invalid/x" }),
    "scrape: https://example.invalid/x",
  );
  assert.equal(toolLine("read", {}), "read");
  assert.ok(
    (toolLine("bash", { command: "x".repeat(500) }) ?? "").length <= 160,
  );
});

test("thinking text becomes the bubble word, and the tool line is kept for the footer", () => {
  const activity = emptyActivity();
  applyEvent(activity, {
    type: "tool_execution_start",
    toolName: "bash",
    args: { command: "git status" },
    observedAt: 1000,
  });
  assert.equal(activity.tool, "bash: git status");
  assert.equal(bubbleText(activity), undefined, "tools have their own feed");
  applyEventLine(
    activity,
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Checking the rollback path.\nThe guard looks unsafe.",
          },
        ],
      },
      observedAt: 2000,
    }),
  );
  assert.equal(
    activity.thought,
    "Checking the rollback path. The guard looks unsafe.",
  );
  assert.equal(
    bubbleText(activity),
    "Checking the rollback path. The guard looks unsafe.",
  );
});

test("tool_execution_end clears the current tool line", () => {
  const activity = emptyActivity();
  applyEvent(activity, {
    type: "tool_execution_start",
    toolName: "read",
    args: { path: "/a/b" },
    observedAt: 10,
  });
  applyEvent(activity, {
    type: "tool_execution_end",
    toolName: "read",
    observedAt: 20,
  });
  assert.equal(activity.tool, undefined);
});

test("a failed tool records a short error", () => {
  const activity = emptyActivity();
  applyEvent(activity, {
    type: "tool_execution_start",
    toolName: "bash",
    args: { command: "false" },
    observedAt: 10,
  });
  applyEvent(activity, {
    type: "tool_execution_end",
    toolName: "bash",
    result: { isError: true },
    observedAt: 20,
  });
  assert.equal(activity.error, "bash failed");
});

test("redacted thinking is flagged so the bubble can fall back", () => {
  const activity = emptyActivity();
  applyEvent(activity, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "" }],
    },
    observedAt: 30,
  });
  applyEvent(activity, { type: "thinking_dropped", observedAt: 31 });
  assert.equal(activity.thinkingDropped, true);
  assert.equal(activity.thought, undefined);
  const text = {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Found three candidates." }],
    },
    observedAt: 32,
  };
  applyEvent(activity, text);
  assert.equal(bubbleText(activity), "Found three candidates.");
});

test("long-running control events mark the agent sleepy", () => {
  const activity = emptyActivity();
  applyEvent(activity, {
    type: "subagent.control",
    event: {
      type: "active_long_running",
      to: "active_long_running",
      currentTool: "bash",
      currentToolStartedAt: 5,
      currentPath: "&1;",
    },
  });
  assert.equal(activity.longRunning, true);
  assert.equal(activity.tool, "bash: &1;");
});

test("a failed run records the non-zero exit code", () => {
  const activity = emptyActivity();
  applyEvent(activity, {
    type: "subagent.step.completed",
    stepIndex: 0,
    exitCode: 3,
    ts: 1,
  });
  applyEvent(activity, {
    type: "subagent.run.completed",
    status: "failed",
    ts: 2,
  });
  assert.equal(activity.error, "exit code 3");
});

test("unknown and malformed events are ignored", () => {
  const activity = emptyActivity();
  applyEvent(activity, { type: "something.new", payload: 1 });
  applyEventLine(activity, "not json at all");
  applyEventLine(activity, "");
  assert.deepEqual(activity, {});
});

test("bubble text goes through redaction", () => {
  const activity = emptyActivity();
  applyEvent(activity, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking:
            "The command was GITHUB_TOKEN=ghp_abcdefghijklmnopqrst and it failed.",
        },
      ],
    },
    observedAt: 1,
  });
  assert.ok(activity.thought !== undefined);
  assert.ok(
    !activity.thought.includes("ghp_abcdefghijklmnopqrst"),
    activity.thought,
  );
});

test("condense keeps the tail and drops to the last full sentence", () => {
  const long = `${"first sentence. ".repeat(30)}last words carry the meaning.`;
  const condensed = condense(long, 80);
  assert.ok(condensed.length <= 80);
  assert.ok(condensed.includes("last words carry the meaning."), condensed);
  assert.equal(condense("short text"), "short text");
});

test("a tool that started after the thought outranks the stale thought", () => {
  const activity = emptyActivity();
  applyEvent(activity, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Plan: read the config first." }],
    },
    observedAt: 1000,
  });
  assert.equal(bubbleText(activity), "Plan: read the config first.");
  assert.equal(currentThought(activity), "Plan: read the config first.");

  // A later assistant message without a thinking block, then a tool call: the
  // thought is from an earlier turn and must not hide the current tool line.
  applyEvent(activity, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "toolCall" }] },
    observedAt: 1500,
  });
  applyEvent(activity, {
    type: "tool_execution_start",
    toolName: "bash",
    args: { command: "npm test" },
    observedAt: 2000,
  });
  assert.equal(activity.thought, "Plan: read the config first.");
  assert.equal(currentThought(activity), undefined);
  assert.equal(
    bubbleText(activity),
    undefined,
    "tools never replace the thinking bubble",
  );

  // Thinking after the tool is the newer activity again.
  applyEvent(activity, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "The tests disagree." }],
    },
    observedAt: 3000,
  });
  assert.equal(bubbleText(activity), "The tests disagree.");
});

test("a tool line is redacted like every other bubble string", () => {
  assert.equal(
    toolLine("bash", {
      command:
        'curl -H "Authorization: Bearer sk-ant-api03-SECRETSECRETSECRET" x',
    }),
    'bash: curl -H "Authorization: Bearer [redacted]" x',
  );
});

test("a truncated over-long line still yields its type and toolName", () => {
  const line = `{"type":"tool_execution_end","toolName":"read","result":{"output":"${`y`.repeat(400)}`;
  const event = parseEventLine(line);
  assert.equal(event?.type, "tool_execution_end");
  assert.equal(event?.toolName, "read");
  assert.equal(event?.truncated, true);
  // The recovered event is enough to close the tool.
  const activity = emptyActivity();
  applyEvent(activity, {
    type: "tool_execution_start",
    toolName: "read",
    args: { path: "/a/b" },
    observedAt: 10,
  });
  assert.equal(activity.tool, "read: /a/b");
  applyEventLine(activity, line);
  assert.equal(activity.tool, undefined);
  // Prose stays prose.
  assert.equal(parseEventLine("not json at all"), undefined);
});

test("F3: a truncated over-long line recovers its step index", () => {
  const line = `{"type":"tool_execution_end","subagentStepIndex":2,"toolName":"read","result":{"output":"${"y".repeat(5000)}`;
  const event = parseEventLine(line);
  assert.ok(event);
  assert.equal(event.type, "tool_execution_end");
  assert.equal(event.subagentStepIndex, 2);
  // Without the recovered index the truncated end lands on step 0 and closes
  // nothing on the step it belongs to.
  assert.equal(eventStepIndex(event), 2);
});

test("F5: a thought does not return once a later tool ends", () => {
  const activity = emptyActivity();
  applyEvent(activity, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Plan: read the config first." }],
    },
    observedAt: 1000,
  });
  applyEvent(activity, {
    type: "tool_execution_start",
    toolName: "bash",
    args: { command: "npm test" },
    observedAt: 2000,
  });
  applyEvent(activity, {
    type: "tool_execution_end",
    toolName: "bash",
    observedAt: 2500,
  });
  // The tool end clears the tool line; the older thought must not come back.
  assert.equal(currentThought(activity), undefined);
  assert.equal(bubbleText(activity), undefined);
  applyEvent(activity, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Now running the build." }],
    },
    observedAt: 2600,
  });
  assert.equal(bubbleText(activity), "Now running the build.");
});
