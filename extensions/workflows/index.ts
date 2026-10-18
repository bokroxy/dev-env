/** Session UI/client for independent, file-backed workflow workers. */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  getAgentDir,
  getMarkdownTheme,
  keyHint,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { showWorkflowDashboard } from "./dashboard.ts";
import {
  extractMeta,
  prepareWorkflowScript,
  type WorkflowMeta,
} from "./meta.ts";
import {
  agentContext,
  aggregateUsage,
  countStates,
  formatElapsed,
  formatUsage,
  phaseGroups,
  resultJson,
  stateSquare,
  statusColor,
  statusWord,
  SQUARE,
  type WorkflowDetails,
} from "./model.ts";
import {
  buildBackgroundWorkflowFollowUp,
  buildBackgroundWorkflowLaunchResult,
  buildWorkflowResultMessage,
  WORKFLOW_PARAMETER_DESCRIPTIONS,
  WORKFLOW_PROMPT_GUIDELINES,
  WORKFLOW_PROMPT_SNIPPET,
  WORKFLOW_TOOL_DESCRIPTION,
} from "./prompt.ts";
import {
  controlWorkflow,
  isActiveStatus,
  launchWorkflow,
  readWorkflow,
  type WorkflowControl,
} from "./transport.ts";
import { safeStringify } from "./serialization.ts";
import {
  renderWorkflowProgress,
  WorkflowProgressSlots,
  WORKFLOW_PROGRESS_WIDGET,
  type WorkflowProgress,
} from "./progress-bar.ts";

const WorkflowParams = Type.Object({
  script: Type.String({ description: WORKFLOW_PARAMETER_DESCRIPTIONS.script }),
  args: Type.Optional(
    Type.String({ description: WORKFLOW_PARAMETER_DESCRIPTIONS.args }),
  ),
  background: Type.Optional(
    Type.Boolean({ description: WORKFLOW_PARAMETER_DESCRIPTIONS.background }),
  ),
});
type WorkflowInput = Static<typeof WorkflowParams>;
const runsDir = () => path.join(getAgentDir(), "workflows");

function compactToolDetails(details: WorkflowDetails): WorkflowDetails {
  return {
    ...details,
    ...(details.result !== undefined
      ? {
          result: JSON.parse(
            safeStringify(details.result, { maxBytes: 64 * 1024 }),
          ),
        }
      : {}),
    agents: details.agents.map((agent) => ({ ...agent, transcript: [] })),
  };
}

function discoverRuns() {
  const runs = new Map<string, WorkflowDetails>();
  try {
    for (const runId of fs.readdirSync(runsDir())) {
      if (!/^wf_[a-f0-9]+$/.test(runId)) continue;
      try {
        runs.set(runId, readWorkflow(path.join(runsDir(), runId)));
      } catch {
        /* incomplete launch or old artifact */
      }
    }
  } catch {
    /* no workflows yet */
  }
  return runs;
}

function resolveRun(value: string) {
  const runs = [...discoverRuns().values()].filter(
    (run) => run.runId === value || run.runId.endsWith(value),
  );
  if (runs.length !== 1)
    throw new Error(
      runs.length ? `Ambiguous run ID: ${value}` : `No run matching: ${value}`,
    );
  return runs[0];
}

export default function workflows(pi: ExtensionAPI) {
  let monitor: ReturnType<typeof setInterval> | undefined;
  let ui: ExtensionContext["ui"] | undefined;
  let sessionId: string | undefined;
  const announced = new Set<string>();
  let deliveredRuns = () => new Set<string>();
  const progressSlots = new WorkflowProgressSlots();
  let progress: WorkflowProgress[] = [];
  let widgetAttached = false;
  let requestWidgetRender: (() => void) | undefined;

  const clearWidget = () => {
    ui?.setWidget(WORKFLOW_PROGRESS_WIDGET, undefined);
    widgetAttached = false;
    requestWidgetRender = undefined;
    progress = [];
    progressSlots.clear();
  };
  const updateWidget = (runs: Iterable<WorkflowDetails>) => {
    if (!ui || !sessionId) return;
    progress = progressSlots.update(runs, sessionId);
    if (!progress.length) {
      if (widgetAttached) ui.setWidget(WORKFLOW_PROGRESS_WIDGET, undefined);
      widgetAttached = false;
      return;
    }
    if (!widgetAttached) {
      widgetAttached = true;
      ui.setWidget(
        WORKFLOW_PROGRESS_WIDGET,
        (tui, theme) => {
          requestWidgetRender = () => tui.requestRender();
          return {
            render: (width: number) =>
              renderWorkflowProgress(progress, width, theme),
            invalidate() {},
            dispose() {
              requestWidgetRender = undefined;
            },
          };
        },
        { placement: "belowEditor" },
      );
    }
    requestWidgetRender?.();
  };

  const refresh = () => {
    const runs = discoverRuns();
    updateWidget(runs.values());
    const live = [...runs.values()].filter(
      (run) =>
        run.sessionId === sessionId &&
        run.independent &&
        isActiveStatus(run.status),
    );
    const running = live.filter((run) => run.status === "running").length;
    const pausing = live.filter((run) => run.status === "pausing").length;
    const paused = live.filter((run) => run.status === "paused").length;
    ui?.setStatus(
      "workflows",
      live.length
        ? `workflows ${running} running${pausing ? ` · ${pausing} pausing` : ""}${paused ? ` · ${paused} paused` : ""}`
        : undefined,
    );
    const delivered = deliveredRuns();
    for (const [runId, details] of runs) {
      if (
        isActiveStatus(details.status) ||
        announced.has(runId) ||
        delivered.has(runId)
      )
        continue;
      if (
        details.sessionId !== sessionId ||
        !details.independent ||
        !details.background
      )
        continue;
      announced.add(runId);
      try {
        pi.sendUserMessage(
          buildBackgroundWorkflowFollowUp({
            runId,
            status: details.status,
            result: buildWorkflowResultMessage(
              details,
              path.join(runsDir(), runId),
            ),
          }),
          { deliverAs: "followUp" },
        );
      } catch {
        announced.delete(runId); // Retry on reconnect; never remove run artifacts.
      }
    }
    return runs;
  };

  pi.on("session_start", (_event, ctx) => {
    if (monitor) clearInterval(monitor);
    clearWidget();
    announced.clear();
    sessionId = ctx.sessionManager.getSessionId();
    // Finalized follow-up messages in the session JSONL are durable delivery receipts.
    deliveredRuns = () => {
      const delivered = new Set<string>();
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== "message" || entry.message.role !== "user") continue;
        const content = entry.message.content;
        const text =
          typeof content === "string"
            ? content
            : content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
        const match = /^\[Background workflow (wf_[a-f0-9]+) /.exec(text);
        if (match) delivered.add(match[1]);
      }
      return delivered;
    };
    ui = ctx.mode === "tui" ? ctx.ui : undefined;
    if (ctx.mode === "tui" || ctx.mode === "rpc") {
      refresh();
      monitor = setInterval(refresh, 1_000);
      monitor.unref?.();
    }
  });
  pi.on("session_shutdown", () => {
    if (monitor) clearInterval(monitor);
    monitor = undefined;
    clearWidget();
    ui?.setStatus("workflows", undefined);
    ui = undefined;
    sessionId = undefined;
    deliveredRuns = () => new Set<string>();
    // Detach ONLY. Workers own their sessions and are never aborted here.
  });

  pi.registerCommand("workflows", {
    description:
      "Workflow dashboard; /workflows pause|resume|cancel|status <runId>",
    handler: async (rawArgs, ctx) => {
      const args = rawArgs.trim().split(/\s+/).filter(Boolean);
      const action = args[0];
      if (
        action === "pause" ||
        action === "resume" ||
        action === "cancel" ||
        action === "status"
      ) {
        try {
          if (args.length !== 2)
            throw new Error(`Usage: /workflows ${action} <runId>`);
          const run = resolveRun(args[1]);
          if (action === "status") {
            ctx.ui.notify(
              buildWorkflowResultMessage(run, path.join(runsDir(), run.runId)),
              "info",
            );
            return;
          }
          if (!run.independent)
            throw new Error("This older run has no independent worker");
          if (
            action === "cancel" &&
            ctx.mode === "tui" &&
            !(await ctx.ui.confirm(
              "Cancel workflow?",
              `${run.name ?? run.runId}: stop execution, retain all artifacts.`,
            ))
          )
            return;
          const response = await controlWorkflow(
            path.join(runsDir(), run.runId),
            action satisfies WorkflowControl,
          );
          ctx.ui.notify(
            `${run.runId}: ${action === "cancel" ? "cancellation requested (artifacts retained)" : response.status}`,
            "info",
          );
          refresh();
        } catch (error) {
          ctx.ui.notify(
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
        return;
      }
      if (ctx.mode === "tui") {
        await showWorkflowDashboard(
          ctx,
          () =>
            new Map(
              [...refresh()].filter(([, run]) => isActiveStatus(run.status)),
            ),
          action,
        );
        return;
      }
      const runs = [...refresh().values()].sort(
        (a, b) => b.startedAt - a.startedAt,
      );
      if (action) {
        try {
          const run = resolveRun(action);
          ctx.ui.notify(
            buildWorkflowResultMessage(run, path.join(runsDir(), run.runId)),
            "info",
          );
        } catch (error) {
          ctx.ui.notify(String(error), "warning");
        }
      } else {
        ctx.ui.notify(
          runs.length
            ? runs
                .map((r) => `${r.runId}  ${r.status}  ${r.name ?? ""}`)
                .join("\n")
            : "No workflows yet.",
          "info",
        );
      }
    },
  });

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_PROMPT_SNIPPET,
    promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
    parameters: WorkflowParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const prepared = prepareWorkflowScript(params.script);
      const runId = `wf_${randomBytes(6).toString("hex")}`;
      const runDir = path.join(runsDir(), runId);
      const details: WorkflowDetails = {
        runId,
        sessionId: ctx.sessionManager.getSessionId(),
        name: prepared.meta.name,
        description: prepared.meta.description,
        background: params.background ?? false,
        independent: true,
        status: "running",
        startedAt: Date.now(),
        phases: [...prepared.meta.phases],
        agents: [],
      };
      const started = await launchWorkflow({
        script: params.script,
        args: params.args,
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
        model: ctx.model,
        thinkingLevel: pi.getThinkingLevel(),
        details,
        runDir,
      });
      if (!isActiveStatus(started.status)) announced.add(runId);
      refresh();
      if (details.background && isActiveStatus(started.status)) {
        return {
          content: [
            {
              type: "text",
              text: buildBackgroundWorkflowLaunchResult({
                runId,
                name: details.name,
                runDir,
              }),
            },
          ],
          details: compactToolDetails(started),
        };
      }
      let current = started;
      while (isActiveStatus(current.status)) {
        if (signal?.aborted)
          throw new Error(
            `Stopped waiting for ${runId}; independent workflow continues. Use /workflows pause ${runId} or /workflows cancel ${runId}.`,
          );
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `workflow ${current.name ?? runId}: ${current.status} · ${current.agents.length} agents`,
            },
          ],
          details: compactToolDetails(current),
        });
        await delay(250);
        current = readWorkflow(runDir);
      }
      announced.add(runId);
      const text = buildWorkflowResultMessage(current, runDir);
      if (current.status !== "completed") throw new Error(text);
      return {
        content: [{ type: "text", text }],
        details: compactToolDetails(current),
      };
    },
    renderCall(args: Partial<WorkflowInput>, theme) {
      const meta =
        typeof args.script === "string"
          ? extractMeta(args.script)
          : { phases: [] };
      let text =
        theme.fg("toolTitle", theme.bold("workflow ")) +
        theme.fg("accent", (meta as WorkflowMeta).name ?? "(script)");
      if (args.background) text += theme.fg("dim", " (background)");
      const description = (meta as WorkflowMeta).description;
      if (description) text += `\n  ${theme.fg("dim", description)}`;
      for (const phase of meta.phases.slice(0, 8)) {
        text += `\n  ${theme.fg("dim", SQUARE)} ${theme.fg("accent", phase.title)}${
          phase.detail ? theme.fg("dim", ` — ${phase.detail}`) : ""
        }`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as WorkflowDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(
          first?.type === "text" ? first.text : "(no output)",
          0,
          0,
        );
      }

      const { done, failed } = countStates(details);
      const settled = done + failed;
      const elapsed = formatElapsed(details.startedAt, details.finishedAt);
      let header =
        `${theme.fg(statusColor(details.status), SQUARE)} ${theme.fg("toolTitle", theme.bold("workflow "))}` +
        `${theme.fg("accent", details.name ?? details.runId)} ` +
        theme.fg(
          "dim",
          `${settled}/${details.agents.length} agents · ${elapsed} · `,
        ) +
        theme.fg(statusColor(details.status), statusWord(details.status));
      if (failed) header += theme.fg("error", ` · ${failed} failed`);
      if (details.background) header += theme.fg("dim", " (background)");
      if (details.status === "running" && details.currentPhase) {
        header += theme.fg("muted", ` · ${details.currentPhase}`);
      }
      const totals = formatUsage(aggregateUsage(details.agents));

      if (!expanded) {
        let text = header;
        for (const agent of details.agents) {
          const context = agentContext(agent);
          text += `\n  ${stateSquare(agent.state, theme)} ${theme.fg("accent", agent.label)}${
            agent.phase ? theme.fg("dim", ` (${agent.phase})`) : ""
          }${theme.fg(
            "dim",
            `${context ? ` · ${context}` : ""} · ${formatElapsed(agent.startedAt, agent.finishedAt)}`,
          )}`;
        }
        if (totals) text += `\n  ${theme.fg("dim", `Total: ${totals}`)}`;
        if (details.error)
          text += `\n  ${theme.fg("error", `Error: ${details.error}`)}`;
        text += `\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
        return new Text(text, 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(header, 0, 0));
      if (details.description) {
        container.addChild(
          new Text(theme.fg("dim", details.description), 0, 0),
        );
      }

      for (const group of phaseGroups(details)) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("muted", `─── ${group.title} ───`), 0, 0),
        );
        for (const agent of group.agents) {
          const usage = formatUsage(agent.usage, agent.model);
          const context = agentContext(agent);
          let line = `${stateSquare(agent.state, theme)} ${theme.fg("accent", agent.label)} ${theme.fg(
            "dim",
            [context, formatElapsed(agent.startedAt, agent.finishedAt)]
              .filter(Boolean)
              .join(" · "),
          )}`;
          if (usage) line += ` ${theme.fg("dim", usage)}`;
          container.addChild(new Text(line, 0, 0));
          if (agent.error) {
            container.addChild(
              new Text(`  ${theme.fg("error", agent.error)}`, 0, 0),
            );
          } else if (agent.preview) {
            const preview = agent.preview.split("\n").slice(0, 2).join(" ");
            container.addChild(new Text(`  ${theme.fg("dim", preview)}`, 0, 0));
          }
        }
      }

      if (details.error) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("error", `Error: ${details.error}`), 0, 0),
        );
      }

      if (details.result !== undefined) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── result ───"), 0, 0));
        container.addChild(
          new Markdown(
            `\`\`\`json\n${resultJson(details.result)}\n\`\`\``,
            0,
            0,
            getMarkdownTheme(),
          ),
        );
      }

      if (totals) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", `Total: ${totals}`), 0, 0));
      }
      return container;
    },
  });
}
