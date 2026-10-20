import assert from "node:assert/strict";
import { test } from "node:test";
import { createRunClock, endedInError, isRunTiming } from "./clock.ts";

test("an idle clock has no elapsed time and nothing to settle", () => {
  const clock = createRunClock();
  assert.equal(clock.running, false);
  assert.equal(clock.elapsed(10_000), 0);
  assert.equal(clock.settle(10_000, false), undefined);
});

test("times a prompt and freezes at the end of its last loop", () => {
  const clock = createRunClock();
  clock.begin(1_000);
  assert.equal(clock.running, true);
  assert.equal(clock.elapsed(4_000), 3_000);

  clock.markEnd(5_000, false);
  assert.equal(clock.elapsed(9_000), 4_000);

  assert.deepEqual(clock.settle(9_500, false), {
    startedAt: 1_000,
    completedAt: 5_000,
    durationMs: 4_000,
    outcome: "completed",
  });
  assert.equal(clock.running, false);
});

test("a second begin keeps the original start", () => {
  const clock = createRunClock();
  clock.begin(1_000);
  clock.begin(1_050);
  assert.equal(clock.elapsed(2_000), 1_000);
});

test("a retry resumes the same prompt instead of restarting it", () => {
  const clock = createRunClock();
  clock.begin(1_000);
  clock.markEnd(2_000, true);
  assert.equal(clock.elapsed(2_500), 1_000);

  clock.begin(3_000);
  assert.equal(clock.elapsed(5_000), 4_000);

  clock.markEnd(6_000, false);
  assert.deepEqual(clock.settle(7_000, false), {
    startedAt: 1_000,
    completedAt: 6_000,
    durationMs: 5_000,
    outcome: "completed",
  });
});

test("reports an aborted run, using the settle time when no loop end was seen", () => {
  const clock = createRunClock();
  clock.begin(1_000);
  assert.deepEqual(clock.settle(3_500, true), {
    startedAt: 1_000,
    completedAt: 3_500,
    durationMs: 2_500,
    outcome: "aborted",
  });
});

test("reports a run whose last loop ended on an error", () => {
  const clock = createRunClock();
  clock.begin(1_000);
  clock.markEnd(2_000, true);
  assert.equal(clock.settle(2_100, false)?.outcome, "error");
});

test("ignores a loop end when no prompt is open and clears on reset", () => {
  const clock = createRunClock();
  clock.markEnd(2_000, true);
  assert.equal(clock.settle(3_000, false), undefined);

  clock.begin(1_000);
  clock.reset();
  assert.equal(clock.running, false);
  assert.equal(clock.elapsed(5_000), 0);
});

test("detects an error stop on the final assistant message only", () => {
  assert.equal(endedInError([]), false);
  assert.equal(
    endedInError([{ role: "user" }, { role: "assistant", stopReason: "stop" }]),
    false,
  );
  assert.equal(
    endedInError([
      { role: "assistant", stopReason: "error" },
      { role: "toolResult" },
    ]),
    true,
  );
  assert.equal(
    endedInError([
      { role: "assistant", stopReason: "error" },
      { role: "assistant", stopReason: "stop" },
    ]),
    false,
  );
});

test("validates persisted timing data", () => {
  const valid = {
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    outcome: "completed",
  };
  assert.equal(isRunTiming(valid), true);
  assert.equal(isRunTiming({ ...valid, outcome: "paused" }), false);
  assert.equal(isRunTiming({ ...valid, durationMs: "1" }), false);
  assert.equal(isRunTiming({ startedAt: 1 }), false);
  assert.equal(isRunTiming(null), false);
  assert.equal(isRunTiming(undefined), false);
});
