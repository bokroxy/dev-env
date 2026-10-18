/**
 * Root-run state and outcome labels, shared by the workflow bar and the Recent
 * list. A failed workflow is never labelled "complete": the bar and the one-line
 * history row say `failed after <dur>` instead of `100% complete`, and an
 * unknown total gets an indeterminate bar plus `done/seen`.
 */
import {
  MAX_RUNNING_PROGRESS,
  stateKind,
  type WorkflowSnapshot,
} from "../source/types.ts";
import { formatDuration, formatEta, formatPercent } from "./text.ts";

export type RootTone =
  "running" | "queued" | "done" | "failed" | "stopped" | "stale" | "unknown";

export interface RootState {
  tone: RootTone;
  glyph: string;
  /** `running`, `complete`, `failed`, `? frobnicating`, ... */
  text: string;
}

const GLYPHS: Record<RootTone, string> = {
  running: "●",
  queued: "○",
  done: "✓",
  failed: "✗",
  stopped: "○",
  stale: "⚠",
  unknown: "?",
};

const TEXTS: Record<string, string> = {
  running: "running",
  queued: "queued",
  done: "complete",
  failed: "failed",
  stopped: "stopped",
};

/** State of a root run, with `? <state>` for anything not modelled. */
export function rootState(workflow: WorkflowSnapshot): RootState {
  if (workflow.stale)
    return { tone: "stale", glyph: GLYPHS.stale, text: "stale" };
  const kind = stateKind(workflow.state);
  const tone: RootTone =
    kind === "unrecognised" ? "unknown" : (kind as RootTone);
  return {
    tone,
    glyph: GLYPHS[tone],
    text:
      tone === "unknown"
        ? `? ${workflow.state}`
        : (TEXTS[tone] ?? workflow.state),
  };
}

export interface WorkflowBar {
  /** Filled fraction for the bar; ignored when `indeterminate`. */
  progress: number;
  /** The total is unknown, so the bar shows a sweep instead of a percentage. */
  indeterminate: boolean;
  /** Label after the bar. */
  text: string;
}

/** The progress bar plus its label, driven by the workflow state, never by `progress >= 1`. */
export function workflowBar(workflow: WorkflowSnapshot): WorkflowBar {
  const duration = formatDuration(workflow.elapsedMs);
  if (workflow.stale)
    return {
      progress: 0,
      indeterminate: false,
      text: "stale · no live process",
    };
  switch (stateKind(workflow.state)) {
    case "running": {
      if (!workflow.inventoryComplete)
        return {
          progress: 0,
          indeterminate: true,
          text: `${workflow.doneCount}/${workflow.seenCount} done · total unknown`,
        };
      // Never present a running estimate as complete: the raw mean may round to
      // 100 %, which reads as "done" while the run is still going.
      const shown = Math.min(MAX_RUNNING_PROGRESS, workflow.progress);
      if (workflow.progress >= 1)
        return { progress: shown, indeterminate: false, text: "finishing" };
      // With no active child there is no ETA to quote: before the first child
      // starts or between stages a zero estimate is not "overrunning". A stale
      // child is named, because the bar must not promise the next agent while
      // the card underneath says `stale`.
      if (workflow.activeCount === 0)
        return {
          progress: shown,
          indeterminate: false,
          text: workflow.children.some((child) => child.stale)
            ? `~${formatPercent(shown)} · an agent went stale`
            : `~${formatPercent(shown)} · waiting for the next agent`,
        };
      return {
        progress: shown,
        indeterminate: false,
        text: `~${formatPercent(shown)} · ${formatEta(workflow.etaMs, true, workflow.expectedMs)}`,
      };
    }
    case "failed":
      return {
        progress: workflow.progress,
        indeterminate: false,
        text: `failed after ${duration}`,
      };
    case "stopped":
      return {
        progress: workflow.progress,
        indeterminate: false,
        text: `stopped after ${duration}`,
      };
    case "done":
      return {
        progress: 1,
        indeterminate: false,
        text: workflow.inventoryComplete
          ? "100% · complete"
          : `${workflow.doneCount}/${workflow.seenCount} seen · complete`,
      };
    case "queued":
      return { progress: 0, indeterminate: false, text: "queued" };
    default:
      return {
        progress: workflow.progress,
        indeterminate: false,
        text: `${workflow.state} after ${duration}`,
      };
  }
}
