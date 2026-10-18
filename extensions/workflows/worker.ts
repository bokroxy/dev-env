import { chmodSync } from "node:fs";
import { join } from "node:path";
import { persistWorkflowJson } from "./artifacts.ts";
import { RunController } from "./controller.ts";
import { executeWorkflow } from "./engine.ts";
import { PauseGate } from "./pause.ts";
import {
  controlEndpoint,
  isActiveStatus,
  processIdentity,
  serveWorkflowControl,
  type WorkerRequest,
} from "./transport.ts";
import { writeFileAtomic } from "./serialization.ts";

export async function main(request: WorkerRequest) {
  const details = request.details;
  const controller = new RunController();
  const pause = new PauseGate();
  const identity = processIdentity();
  if (!identity)
    throw new Error("Unable to determine workflow worker process identity");
  process.umask(0o077);
  writeFileAtomic(
    join(request.runDir, "worker.json"),
    JSON.stringify(identity),
  );
  details.independent = true;
  const save = () => persistWorkflowJson(request.runDir, details);
  save();
  const unsubscribe = pause.subscribe((state) => {
    if (!isActiveStatus(details.status)) return;
    details.status = state;
    save();
  });
  if (details.status === "paused") pause.requestPause();
  const cancel = () => {
    controller.abort("Workflow explicitly cancelled");
    pause.abort("Workflow explicitly cancelled");
  };
  const close = await serveWorkflowControl(request.runDir, (command) => {
    if (command !== "status" && !isActiveStatus(details.status))
      throw new Error(`Workflow is already ${details.status}`);
    if (command === "pause") pause.requestPause();
    if (command === "resume") pause.resume();
    if (command === "cancel") cancel();
    return { status: details.status };
  });
  if (process.platform !== "win32")
    chmodSync(controlEndpoint(request.runDir), 0o600);
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  try {
    await pause.wait(controller.signal);
    await executeWorkflow({
      script: request.script,
      args: request.args,
      runDir: request.runDir,
      details,
      cwd: request.cwd,
      projectTrusted: request.projectTrusted,
      model: request.model,
      thinkingLevel: request.thinkingLevel,
      controller,
      pause,
    });
  } catch (error) {
    details.status = controller.signal.aborted ? "aborted" : "failed";
    details.error = error instanceof Error ? error.message : String(error);
    details.finishedAt = Date.now();
    save();
  } finally {
    unsubscribe();
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
    await close();
  }
}
