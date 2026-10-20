import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunTiming } from "./clock.ts";
import { describeRow, workingMessage } from "./row.ts";

const completedAt = new Date(2026, 9, 19, 22, 14, 7).getTime();
const startedAt = new Date(2026, 9, 19, 22, 10, 0).getTime();
const now = new Date(2026, 9, 19, 22, 30, 0).getTime();

const timing = (overrides: Partial<RunTiming> = {}): RunTiming => ({
  startedAt,
  completedAt,
  durationMs: completedAt - startedAt,
  outcome: "completed",
  ...overrides,
});

test("the spinner message carries the live elapsed time", () => {
  assert.equal(workingMessage(0), "Working · 0s");
  assert.equal(workingMessage(92_000), "Working · 1m 32s");
});

test("describes a completed run by completion time and duration", () => {
  assert.deepEqual(describeRow(timing(), false, now), {
    glyph: "✓",
    text: "22:14:07 · took 4m 07s",
  });
});

test("marks an interrupted run", () => {
  assert.deepEqual(describeRow(timing({ outcome: "aborted" }), false, now), {
    glyph: "■",
    text: "22:14:07 · took 4m 07s · interrupted",
  });
});

test("marks a failed run", () => {
  assert.deepEqual(describeRow(timing({ outcome: "error" }), false, now), {
    glyph: "✗",
    text: "22:14:07 · took 4m 07s · failed",
  });
});

test("expanding adds when the prompt started", () => {
  assert.equal(
    describeRow(timing(), true, now).text,
    "started 22:10:00 · completed 22:14:07 · took 4m 07s",
  );
});

test("carries the date when the run finished on another day", () => {
  const tomorrow = new Date(2026, 9, 20, 9, 0, 0).getTime();
  assert.equal(
    describeRow(timing(), false, tomorrow).text,
    "Oct 19 22:14:07 · took 4m 07s",
  );
});
