/**
 * The duration history used to be fed by every terminal run, so two 18-second
 * rate-limited reviews poisoned the `review` median. `tools/prune-durations.ts`
 * removes the samples of runs that are not done; this test drives the real tool
 * over a temporary history file and checks the backup, the pruning and the
 * recorded-run bookkeeping.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { tempDir } from "./source/fixtures.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);

test("prune-durations drops non-done samples, backs the file up and keeps done ones", () => {
  const base = tempDir("agent-view-prune-");
  const historyDir = path.join(base, "history");
  const runsDir = path.join(base, "runs");
  fs.mkdirSync(historyDir, { recursive: true });

  const now = 2_000_000_000_000;
  const failedRunId = "c0000000-0001-4000-8000-000000000001";
  const stoppedRunId = "c0000000-0002-4000-8000-000000000002";
  const doneRunId = "c0000000-0003-4000-8000-000000000003";
  const missingRunId = "c0000000-0004-4000-8000-000000000004";

  const writeRun = (
    runId: string,
    state: string,
    durationMs: number,
    agent: string,
  ) => {
    const dir = path.join(runsDir, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "status.json"),
      JSON.stringify(
        {
          runId,
          mode: "single",
          state,
          startedAt: now - durationMs,
          endedAt: now,
          lastUpdate: now,
          workflowKey: "review-AF4-0",
          steps: [{ agent, status: state, startedAt: now - durationMs }],
        },
        null,
        1,
      ),
    );
  };
  writeRun(failedRunId, "failed", 18_461, "delegate");
  writeRun(stoppedRunId, "stopped", 18_136, "delegate");
  writeRun(doneRunId, "complete", 1_000_000, "delegate");

  fs.writeFileSync(
    path.join(historyDir, "durations.json"),
    JSON.stringify(
      {
        version: 1,
        roles: { review: [18_461, 18_136, 1_000_000] },
        recorded: {
          [failedRunId]: now,
          [stoppedRunId]: now,
          [doneRunId]: now,
          [missingRunId]: now,
        },
        updatedAt: now,
      },
      null,
      1,
    ),
  );

  const result = spawnSync(
    "node",
    [
      "--experimental-strip-types",
      path.join(HERE, "tools/prune-durations.ts"),
      "--history",
      historyDir,
      "--runs",
      runsDir,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const pruned = JSON.parse(
    fs.readFileSync(path.join(historyDir, "durations.json"), "utf8"),
  );
  assert.deepEqual(pruned.roles.review, [1_000_000]);
  assert.deepEqual(
    Object.keys(pruned.recorded).sort(),
    [doneRunId, missingRunId].sort(),
    "the failed and stopped runs are forgotten, the done and unknown ones stay",
  );
  const backup = fs
    .readdirSync(historyDir)
    .find((name) => name.startsWith("durations.json.bak-"));
  assert.ok(backup, "a backup was written");
  const before = JSON.parse(
    fs.readFileSync(path.join(historyDir, backup), "utf8"),
  );
  assert.deepEqual(before.roles.review, [18_461, 18_136, 1_000_000]);

  // Idempotent: a second run has nothing to prune.
  const second = spawnSync(
    "node",
    [
      "--experimental-strip-types",
      path.join(HERE, "tools/prune-durations.ts"),
      "--history",
      historyDir,
      "--runs",
      runsDir,
    ],
    { encoding: "utf8" },
  );
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /nothing to prune/);
});
