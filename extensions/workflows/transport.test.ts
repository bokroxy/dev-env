import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  controlEndpoint,
  controlWorkflow,
  launchWorkflow,
  readWorkflow,
  workerIsAlive,
} from "./transport.ts";
import type { WorkflowDetails } from "./model.ts";

const run = promisify(execFile);
const source = fileURLToPath(new URL("./transport.ts", import.meta.url));
function details(runId: string): WorkflowDetails {
  return {
    runId,
    sessionId: "departed-session",
    independent: true,
    status: "paused",
    background: true,
    startedAt: Date.now(),
    phases: [],
    agents: [],
  };
}
async function until(check: () => boolean, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("Fixture timed out");
    await delay(25);
  }
}

async function launchFromExitingParent(base: string) {
  const runId = "wf_123456789abc";
  const runDir = join(base, runId);
  const launcher = join(base, "parent.mjs");
  writeFileSync(
    launcher,
    `import { launchWorkflow } from ${JSON.stringify(source)};\nawait launchWorkflow(${JSON.stringify(
      {
        script: "return args.value;",
        args: '{"value":"retained result"}',
        cwd: base,
        runDir,
        details: details(runId),
        projectTrusted: false,
        thinkingLevel: "off",
      },
    )});\n`,
  );
  await run(process.execPath, ["--experimental-strip-types", launcher], {
    env: { ...process.env, PI_CODING_AGENT_DIR: join(base, "agent") },
    timeout: 30_000,
  });
  return runDir;
}

test(
  "a detached paused worker survives parent exit, reconnects, and resumes the same run",
  { timeout: 45_000 },
  async () => {
    const base = mkdtempSync(join(tmpdir(), "pi-workflow-independent-"));
    let runDir: string | undefined;
    try {
      runDir = await launchFromExitingParent(base);
      assert.equal(workerIsAlive(runDir), true);
      assert.equal(readWorkflow(runDir).status, "paused");
      await delay(75);
      assert.deepEqual(await controlWorkflow(runDir, "status"), {
        status: "paused",
      });
      assert.equal(readWorkflow(runDir).sessionId, "departed-session");
      const before = readFileSync(join(runDir, "launch.json"), "utf8");
      await controlWorkflow(runDir, "resume");
      await until(() => readWorkflow(runDir!).status === "completed");
      assert.equal(readWorkflow(runDir).result, "retained result");
      assert.equal(readFileSync(join(runDir, "launch.json"), "utf8"), before);
      await until(() => !workerIsAlive(runDir!));
    } finally {
      if (runDir && workerIsAlive(runDir)) {
        await controlWorkflow(runDir, "cancel").catch(() => {});
        await until(() => !workerIsAlive(runDir!));
      }
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test(
  "cancelling a paused worker unblocks it but retains script, state and transcripts",
  { timeout: 45_000 },
  async () => {
    const base = mkdtempSync(join(tmpdir(), "pi-workflow-cancel-"));
    let runDir: string | undefined;
    try {
      runDir = await launchFromExitingParent(base);
      await controlWorkflow(runDir, "cancel");
      await until(() => readWorkflow(runDir!).status === "aborted");
      assert.equal(existsSync(join(runDir, "script.js")), true);
      assert.equal(existsSync(join(runDir, "workflow.json")), true);
      assert.equal(existsSync(join(runDir, "transcripts.json")), true);
      await until(() => !workerIsAlive(runDir!));
    } finally {
      if (runDir && workerIsAlive(runDir)) {
        await controlWorkflow(runDir, "cancel").catch(() => {});
        await until(() => !workerIsAlive(runDir!));
      }
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test(
  "worker crash is interrupted, not replayed; PID reuse is rejected",
  { timeout: 45_000 },
  async () => {
    const base = mkdtempSync(join(tmpdir(), "pi-workflow-crash-"));
    let runDir: string | undefined;
    try {
      runDir = await launchFromExitingParent(base);
      const identity = JSON.parse(
        readFileSync(join(runDir, "worker.json"), "utf8"),
      );
      process.kill(identity.pid, "SIGKILL");
      await until(() => !workerIsAlive(runDir!));
      assert.equal(readWorkflow(runDir).status, "interrupted");
      assert.equal(existsSync(join(runDir, "launch.json")), true);
      writeFileSync(
        join(runDir, "worker.json"),
        JSON.stringify({ ...identity, pid: process.pid, start: "wrong" }),
      );
      assert.equal(workerIsAlive(runDir), false);
    } finally {
      if (runDir && workerIsAlive(runDir))
        await controlWorkflow(runDir, "cancel").catch(() => {});
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test("transport module exposes launch without relying on a parent extension context", () => {
  assert.equal(typeof launchWorkflow, "function");
});

test("launch refuses an existing run directory without overwriting its inputs", async () => {
  const base = mkdtempSync(join(tmpdir(), "pi-workflow-existing-"));
  writeFileSync(join(base, "script.js"), "preserved original input");
  try {
    await assert.rejects(
      launchWorkflow({
        script: "replacement",
        runDir: base,
        cwd: base,
        projectTrusted: false,
        thinkingLevel: "off",
        details: details("wf_existing"),
      }),
      /EEXIST/,
    );
    assert.equal(
      readFileSync(join(base, "script.js"), "utf8"),
      "preserved original input",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("control endpoint stays in the run directory, falls back to a short path, and is a pipe on Windows", () => {
  const platform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "linux" });
    assert.equal(
      controlEndpoint("/runs/wf_1"),
      join("/runs/wf_1", "control.sock"),
    );
    const long = controlEndpoint(`/${"x".repeat(120)}`);
    assert.ok(Buffer.byteLength(long) < 100);
    assert.equal(long, controlEndpoint(`/${"x".repeat(120)}`));
    Object.defineProperty(process, "platform", { value: "win32" });
    assert.match(
      controlEndpoint("C:\\runs\\wf_1"),
      /^\\\\\.\\pipe\\pi-workflow-[0-9a-f]{24}$/,
    );
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
  }
});
