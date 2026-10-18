import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import type { WorkflowDetails, WorkflowStatus } from "./model.ts";
import type { ThinkingLevel, WorkflowModel } from "./runner.ts";
import { writeFileAtomic } from "./serialization.ts";

export type WorkflowControl = "status" | "pause" | "resume" | "cancel";
export interface WorkerRequest {
  script: string;
  args?: string;
  cwd: string;
  projectTrusted: boolean;
  model?: WorkflowModel;
  thinkingLevel: ThinkingLevel;
  details: WorkflowDetails;
  runDir: string;
  runtimeDir: string;
}

/** PID plus boot/start identity prevents PID reuse from reviving a stale run. */
export function processIdentity(pid = process.pid) {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      if (fields[0] === "Z" || fields[0] === "X") return undefined;
      return {
        pid,
        start: fields[19],
        boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      };
    }
    if (process.platform === "win32") {
      const out = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate.ToFileTimeUtc()`,
        ],
        { encoding: "utf8", timeout: 10_000, windowsHide: true },
      );
      const start = out.stdout?.trim();
      return out.status === 0 && start
        ? { pid, start, boot: "win32" }
        : undefined;
    }
    // macOS and other POSIX systems: ps reports state and start time.
    const out = spawnSync("ps", ["-o", "stat=,lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, LC_ALL: "C" },
    });
    const line = out.stdout?.trim();
    if (out.status !== 0 || !line) return undefined;
    const [state, ...rest] = line.split(/\s+/);
    if (state.startsWith("Z")) return undefined;
    return { pid, start: rest.join(" "), boot: process.platform };
  } catch {
    return undefined;
  }
}

/**
 * Local control endpoint of a run: a unix socket in the run directory, a short
 * hashed socket path when that would exceed the sun_path limit (104 bytes on
 * macOS), or a named pipe on Windows.
 */
export function controlEndpoint(runDir: string) {
  const full = resolve(runDir);
  const hash = createHash("sha256").update(full).digest("hex").slice(0, 24);
  if (process.platform === "win32") return `\\\\.\\pipe\\pi-workflow-${hash}`;
  const inRunDir = join(full, "control.sock");
  return Buffer.byteLength(inRunDir) < 100
    ? inRunDir
    : join(tmpdir(), `pi-wf-${hash}.sock`);
}

const endpointIsFile = () => process.platform !== "win32";

export function workerIsAlive(runDir: string) {
  try {
    const identity = JSON.parse(
      readFileSync(join(runDir, "worker.json"), "utf8"),
    );
    if (!Number.isSafeInteger(identity.pid) || identity.pid < 1) return false;
    const actual = processIdentity(identity.pid);
    return (
      actual !== undefined &&
      actual.start === identity.start &&
      actual.boot === identity.boot
    );
  } catch {
    return false;
  }
}

export function readWorkflow(runDir: string): WorkflowDetails {
  const details: WorkflowDetails = JSON.parse(
    readFileSync(join(runDir, "workflow.json"), "utf8"),
  );
  if (
    details.independent &&
    isActiveStatus(details.status) &&
    !workerIsAlive(runDir)
  ) {
    details.status = "interrupted";
    details.error =
      "Worker stopped or machine restarted. Artifacts retained; no automatic replay.";
  }
  if (details.resultArtifact) {
    try {
      details.result = JSON.parse(
        readFileSync(join(runDir, "result.json"), "utf8"),
      );
    } catch {
      /* checkpoint incomplete */
    }
  }
  return details;
}

export function isActiveStatus(status: WorkflowStatus) {
  return status === "running" || status === "pausing" || status === "paused";
}

/** Single newline-delimited local control request; never signal an unverified arbitrary PID. */
export function controlWorkflow(runDir: string, command: WorkflowControl) {
  return new Promise<{ status: WorkflowStatus }>((resolve, reject) => {
    const socket = createConnection(controlEndpoint(runDir));
    let text = "";
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(5_000, () =>
      fail(new Error("Workflow control timed out")),
    );
    socket.on("error", fail);
    socket.on("end", () => {
      if (!text.includes("\n"))
        fail(new Error("Worker closed without acknowledging control"));
    });
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ command })}\n`),
    );
    socket.on("data", (chunk) => {
      text += chunk.toString();
      if (text.length > 16_384)
        return fail(new Error("Oversized control response"));
      if (!text.includes("\n")) return;
      socket.destroy();
      try {
        const response = JSON.parse(text.split("\n")[0]);
        if (typeof response.error === "string") throw new Error(response.error);
        const statuses = [
          "running",
          "pausing",
          "paused",
          "completed",
          "failed",
          "aborted",
          "interrupted",
        ];
        if (!statuses.includes(response.status))
          throw new Error("Invalid worker acknowledgement");
        resolve({ status: response.status });
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function serveWorkflowControl(
  runDir: string,
  handle: (command: WorkflowControl) => { status: WorkflowStatus },
) {
  const socketPath = controlEndpoint(runDir);
  if (endpointIsFile() && existsSync(socketPath))
    throw new Error("Run already has a control socket");
  const clients = new Set<ReturnType<typeof createConnection>>();
  const server = createServer((client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => client.destroy());
    client.setTimeout(5_000, () => client.destroy());
    let text = "";
    let handled = false;
    client.on("data", (chunk) => {
      if (handled) return;
      text += chunk.toString();
      if (text.length > 4096) {
        handled = true;
        client.destroy();
        return;
      }
      if (!text.includes("\n")) return;
      handled = true;
      try {
        const { command } = JSON.parse(text.split("\n")[0]);
        if (
          command !== "status" &&
          command !== "pause" &&
          command !== "resume" &&
          command !== "cancel"
        )
          throw new Error("Unknown workflow control action");
        client.end(`${JSON.stringify(handle(command))}\n`);
      } catch (error) {
        client.end(
          `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
        );
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return async () => {
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}

/** Detached process + file-backed stdio: no parent IPC pipe, terminal or session-owned cleanup. */
export async function launchWorkflow(
  request: Omit<WorkerRequest, "runtimeDir">,
) {
  mkdirSync(dirname(request.runDir), { recursive: true, mode: 0o700 });
  // Claim a fresh run directory atomically; never overwrite/replay an existing run.
  mkdirSync(request.runDir, { mode: 0o700 });
  const requestPath = join(request.runDir, "launch.json");
  writeFileAtomic(
    requestPath,
    JSON.stringify({ ...request, runtimeDir: getPackageDir() }),
  );
  writeFileAtomic(join(request.runDir, "script.js"), request.script);
  if (request.args !== undefined)
    writeFileAtomic(join(request.runDir, "args.json"), request.args);
  const stdout = openSync(join(request.runDir, "worker.log"), "a", 0o600);
  let child;
  try {
    child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./worker-bootstrap.cjs", import.meta.url)),
        requestPath,
      ],
      {
        cwd: request.cwd,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", stdout, stdout],
        env: { ...process.env, PI_WORKFLOW_WORKER: "1" },
      },
    );
  } finally {
    closeSync(stdout);
  }
  child.unref();
  let error: Error | undefined;
  child.on("error", (value) => {
    error = value;
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (error) throw error;
    if (child.exitCode !== null || child.signalCode !== null) {
      if (existsSync(join(request.runDir, "workflow.json")))
        return readWorkflow(request.runDir);
      const log = readFileSync(
        join(request.runDir, "worker.log"),
        "utf8",
      ).slice(-4096);
      throw new Error(
        `Workflow worker exited during launch. See ${join(request.runDir, "worker.log")}\n${log}`,
      );
    }
    if (!endpointIsFile() || existsSync(controlEndpoint(request.runDir))) {
      try {
        await controlWorkflow(request.runDir, "status");
        return readWorkflow(request.runDir);
      } catch {
        /* still starting */
      }
    }
    await delay(50);
  }
  // Do not kill or replay an ambiguously launched workflow.
  throw new Error(
    `Worker launch acknowledgement timed out. Run ${request.details.runId} may still be starting; inspect /workflows and worker.log.`,
  );
}
