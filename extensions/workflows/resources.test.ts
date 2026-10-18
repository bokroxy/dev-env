import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkflowResources } from "./runner.ts";
import { PauseGate } from "./pause.ts";

test("pause-aware settings preserve untrusted-project status and do not persist cache-warming changes", async () => {
  const base = mkdtempSync(join(tmpdir(), "pi-workflow-trust-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(base, "agent");
  try {
    const resources = await createWorkflowResources(
      base,
      "plain",
      false,
      new PauseGate(),
    );
    assert.equal(resources.settingsManager.isProjectTrusted(), false);
    assert.equal(resources.settingsManager.getCacheWarmingMode(), "off");
    assert.equal(existsSync(join(base, "agent", "settings.json")), false);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(base, { recursive: true, force: true });
  }
});
