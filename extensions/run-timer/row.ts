import { formatClock, formatDuration } from "../shared/time-format.ts";
import type { RunOutcome, RunTiming } from "./clock.ts";

export const WORKING_LABEL = "Working";

/** The text on the spinner row while a prompt runs: `Working · 1m 32s`. */
export function workingMessage(elapsedMs: number) {
  return `${WORKING_LABEL} · ${formatDuration(elapsedMs)}`;
}

const GLYPHS: Record<RunOutcome, string> = {
  completed: "✓",
  aborted: "■",
  error: "✗",
};

const NOTES: Record<RunOutcome, string> = {
  completed: "",
  aborted: " · interrupted",
  error: " · failed",
};

/**
 * The row beneath a finished reply, split so the caller can colour the glyph
 * by outcome. Collapsed: `22:14:07 · took 4m 12s`. Expanded adds when it began.
 */
export function describeRow(timing: RunTiming, expanded: boolean, now: number) {
  const took = `took ${formatDuration(timing.durationMs)}${NOTES[timing.outcome]}`;
  const completed = formatClock(timing.completedAt, now);
  const text = expanded
    ? `started ${formatClock(timing.startedAt, now)} · completed ${completed} · ${took}`
    : `${completed} · ${took}`;

  return { glyph: GLYPHS[timing.outcome], text };
}
