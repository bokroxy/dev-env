/** Session-owned workflow progress: read-only projections, slot retention and TUI rendering. */
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { allocateColumns } from "../context-bar/breakdown.ts";
import type { Theme, WorkflowDetails, WorkflowStatus } from "./model.ts";

export const WORKFLOW_PROGRESS_WIDGET = "workflow-progress";
const MAX_BAR_WIDTH = 96;
const MAX_CONTENT_WIDTH = 120;
const PHASE_COLORS = [
  "accent",
  "syntaxFunction",
  "syntaxNumber",
  "syntaxVariable",
  "syntaxType",
] as const satisfies readonly ThemeColor[];
const active = (status: WorkflowStatus) =>
  status === "running" || status === "pausing" || status === "paused";

function label(text: string) {
  return stripTerminalSequences(text)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** No percentages: scripts can discover more agents; phase slots represent the declared plan. */
export function workflowProgress(details: WorkflowDetails) {
  const agents = Array.isArray(details.agents) ? details.agents : [];
  const titles = [
    ...new Set(
      (Array.isArray(details.phases) ? details.phases : []).map(
        (phase) => phase.title,
      ),
    ),
  ];
  if (details.currentPhase && !titles.includes(details.currentPhase))
    titles.push(details.currentPhase);
  for (const agent of agents) {
    if (agent.phase !== undefined && !titles.includes(agent.phase))
      titles.push(agent.phase);
  }
  const groups = titles.map((title) => ({
    key: `phase:${title}`,
    title,
    agents: agents.filter((agent) => agent.phase === title),
  }));
  const unphased = agents.filter((agent) => agent.phase === undefined);
  if (unphased.length || !groups.length)
    groups.push({
      key: "unphased",
      title: groups.length ? "Unphased" : "Workflow",
      agents: unphased,
    });
  const current = details.currentPhase
    ? groups.findIndex((group) => group.title === details.currentPhase)
    : -1;
  const terminal = !active(details.status);
  const phases = groups.map((group, index) => {
    const done = group.agents.filter((agent) => agent.state === "done").length;
    const failed = group.agents.filter(
      (agent) => agent.state === "error",
    ).length;
    const running = group.agents.length - done - failed;
    const isCurrent = index === current || (current < 0 && groups.length === 1);
    const visited =
      group.agents.length > 0 || (current >= 0 && index <= current);
    return {
      key: group.key,
      title: label(group.title) || "Unnamed phase",
      color: PHASE_COLORS[index % PHASE_COLORS.length],
      done,
      failed,
      running,
      total: group.agents.length,
      current: isCurrent,
      visited,
      settled:
        visited &&
        running === 0 &&
        (terminal || (current >= 0 && index < current)),
      skipped: terminal && !visited,
      fatal: details.status === "failed" && isCurrent,
      interrupted:
        details.status === "interrupted" && (isCurrent || running > 0),
    };
  });
  const done = phases.reduce((total, phase) => total + phase.done, 0);
  const failed = phases.reduce((total, phase) => total + phase.failed, 0);
  // A script-level failure need not have an errored agent. Still mark its current/last phase.
  if (details.status === "failed" && !phases.some((phase) => phase.fatal))
    phases[phases.length - 1].fatal = true;
  return {
    runId: details.runId,
    sessionId: details.sessionId,
    title: label(details.name || details.runId),
    status: details.status,
    startedAt: details.startedAt,
    finishedAt: details.finishedAt,
    done,
    failed,
    total: agents.length,
    phases,
  };
}

export type WorkflowProgress = ReturnType<typeof workflowProgress>;

/** Finished slots are retained and reused only when a later workflow actually spawns. */
export class WorkflowProgressSlots {
  private sessionId?: string;
  private slots: string[] = [];
  private seen = new Set<string>();
  private snapshots = new Map<string, WorkflowProgress>();
  private terminalObservedAt = new Map<string, number>();

  clear() {
    this.slots = [];
    this.seen.clear();
    this.snapshots.clear();
    this.terminalObservedAt.clear();
    this.sessionId = undefined;
  }

  update(
    runs: Iterable<WorkflowDetails>,
    sessionId: string | undefined,
    now = Date.now(),
  ) {
    if (sessionId !== this.sessionId || !sessionId) {
      this.clear();
      this.sessionId = sessionId;
    }
    if (!sessionId) return [];
    const owned = [...runs]
      .filter((run) => run.sessionId === sessionId)
      .sort(
        (a, b) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId),
      );
    for (const run of owned) {
      if (this.seen.has(run.runId) && !this.snapshots.has(run.runId)) continue;
      const view = workflowProgress(run);
      this.snapshots.set(run.runId, view);
      if (!active(view.status) && !this.terminalObservedAt.has(view.runId))
        this.terminalObservedAt.set(view.runId, now);
      if (this.seen.has(run.runId)) continue;
      this.seen.add(run.runId);
      let replace = -1;
      let earliest = Infinity;
      for (let i = 0; i < this.slots.length; i++) {
        const old = this.snapshots.get(this.slots[i]);
        if (!old || active(old.status)) continue;
        const ended =
          old.finishedAt ?? this.terminalObservedAt.get(old.runId) ?? Infinity;
        if (ended <= view.startedAt && ended < earliest) {
          replace = i;
          earliest = ended;
        }
      }
      if (replace < 0) this.slots.push(view.runId);
      else {
        const replaced = this.slots[replace];
        this.snapshots.delete(replaced);
        this.terminalObservedAt.delete(replaced);
        this.slots[replace] = view.runId;
      }
    }
    return this.slots.flatMap((id) => {
      const view = this.snapshots.get(id);
      return view ? [view] : [];
    });
  }
}

function phaseCells(
  phase: WorkflowProgress["phases"][number],
  width: number,
  theme: Theme,
) {
  if (width <= 0) return "";
  if (phase.fatal && phase.failed === 0)
    return theme.fg("error", "█".repeat(width));
  if (phase.interrupted) return theme.fg("error", "█".repeat(width));
  if (phase.total === 0) {
    if (phase.settled) return theme.fg(phase.color, "█".repeat(width));
    if (phase.current && !phase.skipped)
      return theme.fg(phase.color, "▒".repeat(width));
    return theme.fg("dim", "░".repeat(width));
  }
  const columns = allocateColumns(
    [phase.done, phase.failed, phase.running],
    width,
  );
  // Never round a failed portion away, even in a one-column phase.
  if (phase.failed > 0 && columns[1] === 0) {
    const donor = columns[0] > 0 ? 0 : 2;
    if (columns[donor] > 0) {
      columns[donor]--;
      columns[1]++;
    }
  }
  let bar =
    theme.fg(phase.color, "█".repeat(columns[0])) +
    theme.fg("error", "█".repeat(columns[1])) +
    theme.fg(phase.color, "▒".repeat(columns[2]));
  // All *known* agents may have finished while the script is still in this phase.
  if (
    phase.current &&
    !phase.settled &&
    phase.running === 0 &&
    phase.failed === 0
  )
    bar = theme.fg(phase.color, "█".repeat(Math.max(0, width - 1)) + "▒");
  return bar;
}

function outcome(run: WorkflowProgress) {
  if (run.status === "completed")
    return run.failed ? "Finished with errors" : "Complete";
  if (run.status === "failed") return "Workflow failed";
  if (run.status === "interrupted") return "Interrupted";
  if (run.status === "aborted") return "Cancelled";
  if (run.status === "paused") return "Paused";
  if (run.status === "pausing") return "Pausing";
  return run.failed ? "Running with errors" : "Running";
}

function agentSummary(run: WorkflowProgress) {
  if (!run.total) return "no agents started";
  const remaining = run.total - run.done - run.failed;
  return [
    run.done ? `${run.done} succeeded` : "",
    run.failed ? `${run.failed} failed` : "",
    remaining
      ? `${remaining} ${active(run.status) ? "in progress" : "unfinished"}`
      : "",
  ]
    .filter(Boolean)
    .join(", ");
}

export function renderWorkflowProgress(
  runs: readonly WorkflowProgress[],
  width: number,
  theme: Theme,
) {
  if (width <= 0) return [];
  const contentWidth = Math.min(width, MAX_CONTENT_WIDTH);
  const barWidth = Math.min(width, MAX_BAR_WIDTH);
  const lines: string[] = [];
  for (const run of runs) {
    const hasError =
      run.failed > 0 || run.status === "failed" || run.status === "interrupted";
    const stateColor = hasError
      ? "error"
      : run.status === "completed"
        ? "success"
        : "warning";
    const heading = `${theme.bold(theme.fg(stateColor, outcome(run)))} · ${theme.bold(theme.fg("toolTitle", run.title))} · ${agentSummary(run)}`;
    // Unrun terminal phases are not "remaining work". Collapse them instead of
    // letting an abandoned plan occupy most of a finished workflow's bar.
    const displayed = run.phases.filter(
      (phase) =>
        !phase.skipped || phase.failed || phase.fatal || phase.interrupted,
    );
    const omitted = run.phases.length - displayed.length;
    const separators =
      barWidth >= displayed.length * 2 - 1
        ? Math.max(0, displayed.length - 1)
        : 0;
    const columns = allocateColumns(
      displayed.map(() => 1),
      barWidth - separators,
    );
    for (let i = 0; i < displayed.length; i++) {
      const phase = displayed[i];
      if (columns[i] || !(phase.failed || phase.fatal || phase.interrupted))
        continue;
      const donor = columns.findIndex(
        (count, index) =>
          count > 0 &&
          !(
            displayed[index].failed ||
            displayed[index].fatal ||
            displayed[index].interrupted
          ),
      );
      if (donor >= 0) {
        columns[donor]--;
        columns[i]++;
      }
    }
    const bar = displayed.length
      ? displayed
          .map((phase, i) => phaseCells(phase, columns[i], theme))
          .join(separators ? theme.fg("borderMuted", "│") : "")
      : theme.fg("dim", "No phase work recorded");
    const phaseLabels = displayed.map((phase) => {
      const text = phase.failed
        ? `${phase.done} succeeded, ${phase.failed} failed`
        : phase.fatal
          ? "failed"
          : phase.interrupted
            ? "interrupted"
            : phase.running
              ? `${phase.running} in progress${phase.done ? `, ${phase.done} succeeded` : ""}`
              : phase.settled
                ? "complete"
                : phase.total
                  ? `${phase.done} succeeded so far`
                  : phase.current
                    ? "starting"
                    : "pending";
      return `${theme.fg(phase.color, phase.title)}: ${theme.fg(phase.failed || phase.fatal || phase.interrupted ? "error" : "muted", text)}`;
    });
    if (omitted)
      phaseLabels.push(
        theme.fg("dim", `${omitted} phase${omitted === 1 ? "" : "s"} not run`),
      );
    if (lines.length) lines.push("");
    lines.push(
      truncateToWidth(heading, contentWidth),
      truncateToWidth(bar, barWidth, ""),
      truncateToWidth(phaseLabels.join(theme.fg("dim", " · ")), contentWidth),
    );
  }
  return lines;
}
