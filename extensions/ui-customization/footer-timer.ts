import type { RunTimerState } from "../shared/dashboard-state.ts";
import { formatDuration } from "../shared/time-format.ts";

/**
 * The timer appended to the footer's usage line after cost and tok/s: the live
 * elapsed time while a prompt runs, `took …` once it has finished, and nothing
 * before the first prompt.
 */
export function footerTimerText(state: RunTimerState) {
  if (state.elapsedMs === null) return "";

  const duration = formatDuration(state.elapsedMs);
  return state.running ? duration : `took ${duration}`;
}
