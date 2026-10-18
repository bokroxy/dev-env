/** Workflow execution independent of the launching session and its UI. */

import * as path from "node:path";
import { createWorkflowPersistence, persistWorkflowJson } from "./artifacts.ts";
import type { RunController } from "./controller.ts";
import { prepareWorkflowScript } from "./meta.ts";
import { emptyUsage, type AgentRecord, type WorkflowDetails } from "./model.ts";
import type { PauseGate } from "./pause.ts";
import { buildWorkflowAgentPrompt } from "./prompt.ts";
import {
  createWorkflowResources,
  runAgent,
  type ThinkingLevel,
  type WorkflowModel,
} from "./runner.ts";
import {
  runWorkflowSandbox,
  type SandboxAgentOptions,
  type SandboxAgentResult,
} from "./sandbox.ts";
import { truncateUtf8, writeFileAtomic } from "./serialization.ts";

const PREVIEW_LENGTH = 200;
const EMIT_INTERVAL_MS = 120;
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingLevel[];

export interface ExecuteWorkflowOptions {
  script: string;
  args?: string;
  details: WorkflowDetails;
  runDir: string;
  cwd: string;
  projectTrusted: boolean;
  model?: WorkflowModel;
  thinkingLevel: ThinkingLevel;
  controller: RunController;
  pause: PauseGate;
  onUpdate?: () => void;
}

function errorText(error: unknown) {
  return truncateUtf8(
    error instanceof Error ? error.message : String(error),
    16 * 1024,
  );
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.some((level) => level === value);
}

/**
 * Mutate and persist the supplied run details, then return their final state.
 * Failures are recorded rather than thrown; the caller decides how to report
 * them. Child sessions use only the captured launch options, never a live
 * parent context. Artifacts remain available after failure or cancellation.
 */
export async function executeWorkflow(options: ExecuteWorkflowOptions) {
  const { details, runDir, controller, pause } = options;
  const persistence = createWorkflowPersistence(runDir, details);
  let finalized = false;
  let emitTimer: ReturnType<typeof setTimeout> | undefined;
  let lastEmit = 0;

  const flushUpdate = () => {
    emitTimer = undefined;
    lastEmit = Date.now();
    try {
      options.onUpdate?.();
    } catch {
      // An observer (including a disconnected UI) cannot stop execution.
    }
  };
  const emit = (checkpoint = true) => {
    if (finalized) return;
    if (checkpoint) persistence.checkpoint();
    if (emitTimer) return;
    emitTimer = setTimeout(
      flushUpdate,
      Math.max(0, EMIT_INTERVAL_MS - (Date.now() - lastEmit)),
    );
  };
  const flushNow = () => {
    if (emitTimer) clearTimeout(emitTimer);
    flushUpdate();
  };

  const onPhase = (title: string) => {
    if (finalized) return;
    details.currentPhase = title;
    if (!details.phases.some((phase) => phase.title === title)) {
      details.phases.push({ title });
    }
    // Phase notifications do not wait for the pause gate.
    emit();
  };

  let agentCounter = details.agents.length;
  const onAgent = async (
    promptValue: string,
    opts: SandboxAgentOptions,
    invocationSignal: AbortSignal,
  ): Promise<SandboxAgentResult> => {
    const index = ++agentCounter;
    const label =
      typeof opts.label === "string" && opts.label.trim()
        ? opts.label.trim().slice(0, 160)
        : `agent-${index}`;
    const record: AgentRecord = {
      index,
      label,
      phase:
        typeof opts.phase === "string"
          ? opts.phase.slice(0, 160)
          : details.currentPhase,
      state: "running",
      model: options.model?.id,
      contextWindow: options.model?.contextWindow,
      startedAt: Date.now(),
      preview: "",
      usage: emptyUsage(),
      transcript: [],
    };
    details.agents.push(record);
    persistence.checkpoint({ immediate: true });
    emit(false);

    const fail = (error: string): SandboxAgentResult => {
      const boundedError = errorText(error);
      if (!finalized) {
        record.state = "error";
        record.error = boundedError;
        record.finishedAt = Date.now();
        emit();
      }
      return { ok: false, output: "", error: boundedError };
    };

    try {
      const prompt = buildWorkflowAgentPrompt(promptValue);
      if (!prompt.trim()) {
        return fail("agent() requires a non-empty prompt string");
      }
      if (controller.signal.aborted) {
        return fail("Workflow was aborted before this agent started");
      }
      await pause.wait(controller.signal);

      return await controller.schedule(async (runSignal) => {
        const model = options.model;
        let modelSelection: { model: string; provider?: string } | undefined;
        if (opts.model !== undefined || opts.provider !== undefined) {
          const modelOpt =
            typeof opts.model === "string" ? opts.model : undefined;
          const providerOpt =
            typeof opts.provider === "string" ? opts.provider : undefined;
          if (!modelOpt)
            return fail(`agent "${label}": provider requires model as well`);
          // Resolve after the child's own extensions register their models.
          modelSelection = { model: modelOpt, provider: providerOpt };
        }
        record.model = model?.id;
        record.contextWindow = model?.contextWindow;
        emit();

        let thinkingLevel = options.thinkingLevel;
        if (opts.effort !== undefined) {
          const effort = String(opts.effort);
          if (!isThinkingLevel(effort)) {
            return fail(
              `agent "${label}": invalid effort "${effort}" (use ${THINKING_LEVELS.join("|")})`,
            );
          }
          thinkingLevel = effort;
        }

        const resources = await createWorkflowResources(
          options.cwd,
          opts.schema !== undefined ? "structured" : "plain",
          options.projectTrusted,
          pause,
        );
        runSignal.throwIfAborted();
        const outcome = await runAgent({
          prompt,
          schema: opts.schema,
          model,
          modelSelection,
          thinkingLevel,
          cwd: options.cwd,
          loader: resources.loader,
          settingsManager: resources.settingsManager,
          signal: runSignal,
          pause,
          onProgress: (progress) => {
            if (finalized) return;
            record.preview = progress.preview.slice(0, PREVIEW_LENGTH);
            record.usage = progress.usage;
            record.model = progress.model ?? record.model;
            record.contextWindow =
              progress.contextWindow ?? record.contextWindow;
            record.transcript = progress.transcript;
            emit();
          },
        });

        // Bounded settlement can finish before an uncooperative child. Do not
        // let a late child overwrite the persisted terminal run state.
        if (!finalized) {
          record.usage = outcome.usage;
          record.model = outcome.model ?? record.model;
          record.contextWindow = outcome.contextWindow ?? record.contextWindow;
          record.transcript = outcome.transcript;
          record.preview = (outcome.output || record.preview).slice(
            0,
            PREVIEW_LENGTH,
          );
          record.finishedAt = Date.now();
          record.state = outcome.ok ? "done" : "error";
          if (outcome.ok) delete record.error;
          else record.error = errorText(outcome.error ?? "Agent failed");
          emit();
        }

        return {
          ok: outcome.ok,
          output: outcome.output,
          ...(outcome.structured !== undefined
            ? { structured: outcome.structured }
            : {}),
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        };
      }, invocationSignal);
    } catch (error) {
      return fail(errorText(error));
    }
  };

  let status: WorkflowDetails["status"] = "completed";
  try {
    let prepared: ReturnType<typeof prepareWorkflowScript>;
    try {
      prepared = prepareWorkflowScript(options.script);
    } catch (error) {
      throw new Error(`Workflow script failed to parse: ${errorText(error)}`);
    }

    let args: unknown;
    if (options.args !== undefined) {
      try {
        args = JSON.parse(options.args);
      } catch {
        args = options.args;
      }
    }
    writeFileAtomic(path.join(runDir, "script.js"), options.script);
    if (options.args !== undefined) {
      writeFileAtomic(path.join(runDir, "args.json"), options.args);
    }
    persistWorkflowJson(runDir, details);
    await pause.wait(controller.signal);
    details.result = await runWorkflowSandbox({
      source: prepared.source,
      args,
      cwd: options.cwd,
      signal: controller.signal,
      onAgent,
      onPhase,
    });
    await pause.wait(controller.signal);
    if (controller.signal.aborted) {
      status = "aborted";
      details.error = errorText(controller.signal.reason);
    }
  } catch (error) {
    details.error = errorText(error);
    status = controller.signal.aborted ? "aborted" : "failed";
    controller.abort("Workflow script failed");
  }

  try {
    const settled = await controller.settle({ abort: status !== "completed" });
    if (!settled) {
      controller.abort("Agent shutdown deadline exceeded");
      status = "failed";
      details.error = details.error
        ? errorText(`${details.error}; agent shutdown deadline exceeded`)
        : "Agent shutdown deadline exceeded";
    } else if (status === "completed" && controller.signal.aborted) {
      status = "aborted";
      details.error = errorText(controller.signal.reason);
    }
  } catch (error) {
    status = "failed";
    details.error = errorText(error);
    controller.abort("Workflow settlement failed");
  }

  finalized = true;
  for (const record of details.agents) {
    if (record.state !== "running") continue;
    record.state = "error";
    record.error = record.error ?? "Agent did not settle before run cleanup";
    record.finishedAt = Date.now();
  }
  details.status = status;
  details.finishedAt = Date.now();
  try {
    persistence.flush();
  } catch (error) {
    details.status = "failed";
    const failure = `Artifact persistence failed: ${errorText(error)}`;
    details.error = details.error
      ? errorText(`${details.error}; ${failure}`)
      : failure;
    try {
      persistence.flush();
    } catch {
      // Preserve existing artifacts and return the in-memory failure state.
    }
  } finally {
    flushNow();
  }
  return details;
}
