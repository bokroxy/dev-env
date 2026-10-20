export type RunOutcome = "completed" | "aborted" | "error";

/** What the row beneath a finished reply is built from. Persisted in the session. */
export interface RunTiming {
  /** Epoch milliseconds when the prompt started. */
  startedAt: number;
  /** Epoch milliseconds when the last reply of the prompt finished. */
  completedAt: number;
  durationMs: number;
  outcome: RunOutcome;
}

const OUTCOMES: readonly unknown[] = ["completed", "aborted", "error"];

export function isRunTiming(value: unknown): value is RunTiming {
  if (typeof value !== "object" || value === null) return false;
  const timing = value as Record<string, unknown>;

  return (
    typeof timing.startedAt === "number" &&
    typeof timing.completedAt === "number" &&
    typeof timing.durationMs === "number" &&
    OUTCOMES.includes(timing.outcome)
  );
}

interface OpenRun {
  startedAt: number;
  /** Set when the agent loop last ended; cleared if the same prompt resumes (retry). */
  endedAt: number | undefined;
  /** Whether the last agent loop ended on a provider error. */
  failed: boolean;
}

/**
 * Times one prompt from the moment it starts to the moment the whole run has
 * settled. The clock takes `now` as an argument so it stays deterministic.
 */
export function createRunClock() {
  let run: OpenRun | undefined;

  return {
    get running() {
      return run !== undefined;
    },

    /**
     * Starts timing a prompt. Calling it again while a prompt is open keeps the
     * original start: a retry or a queued follow-up belongs to the same prompt.
     */
    begin(now: number) {
      if (run) {
        run.endedAt = undefined;
        run.failed = false;
        return;
      }
      run = { startedAt: now, endedAt: undefined, failed: false };
    },

    /** Records that the agent loop ended. The clock freezes until the prompt resumes or settles. */
    markEnd(now: number, failed: boolean) {
      if (!run) return;
      run.endedAt = now;
      run.failed = failed;
    },

    /** Elapsed milliseconds of the open prompt, frozen once its loop has ended. */
    elapsed(now: number) {
      if (!run) return 0;
      return Math.max(0, (run.endedAt ?? now) - run.startedAt);
    },

    /** Closes the prompt and returns its timing, or undefined when none was open. */
    settle(now: number, aborted: boolean): RunTiming | undefined {
      if (!run) return undefined;

      const completedAt = run.endedAt ?? now;
      const outcome: RunOutcome = aborted
        ? "aborted"
        : run.failed
          ? "error"
          : "completed";
      const timing = {
        startedAt: run.startedAt,
        completedAt,
        durationMs: Math.max(0, completedAt - run.startedAt),
        outcome,
      };
      run = undefined;
      return timing;
    },

    reset() {
      run = undefined;
    },
  };
}

/** True when the final assistant message of a finished loop stopped on an error. */
export function endedInError(
  messages: readonly { role: string; stopReason?: string }[],
) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message.stopReason === "error";
  }
  return false;
}
