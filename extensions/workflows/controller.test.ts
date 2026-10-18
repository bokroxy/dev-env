import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_AGENT_CALLS, RunController } from "./controller.ts";

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

test("RunController reserves calls synchronously without capping fanout", async () => {
  const controller = new RunController();
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 12 }, (_, index) =>
    controller.schedule(async () => {
      active++;
      peak = Math.max(peak, active);
      await delay(5);
      active--;
      return index;
    }),
  );
  assert.deepEqual(
    await Promise.all(tasks),
    Array.from({ length: 12 }, (_, i) => i),
  );
  assert.equal(peak, 12);
  assert.equal(await controller.settle(), true);
});

test("RunController propagates invocation cancellation without aborting the run", async () => {
  const controller = new RunController();
  const invocation = new AbortController();
  const pending = controller.schedule(
    (signal) =>
      new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => resolve("stopped"), {
          once: true,
        });
      }),
    invocation.signal,
  );

  invocation.abort(new Error("Workflow agent request was cancelled"));
  await assert.rejects(pending, /request was cancelled/);
  assert.equal(controller.signal.aborted, false);
  assert.equal(await controller.schedule(async () => "recovered"), "recovered");
  assert.equal(await controller.settle(), true);
});

test("RunController enforces call budget and aborts running tasks", async () => {
  const controller = new RunController();
  const blocker = controller.schedule(
    (signal) =>
      new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      ),
  );
  const running = Array.from({ length: MAX_AGENT_CALLS - 1 }, () =>
    controller.schedule(
      (signal) =>
        new Promise<string>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        ),
    ),
  );
  await assert.rejects(
    controller.schedule(async () => "too many"),
    /exceeded the limit/,
  );
  controller.abort();
  await assert.rejects(blocker, /aborted/);
  const results = await Promise.allSettled(running);
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.equal(await controller.settle({ abort: true }), true);
});
