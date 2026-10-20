import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  emptyRunTimerState,
  REFRESH_CHANNEL,
  RUN_TIMER_CHANNEL,
} from "../shared/dashboard-state.ts";
import {
  createRunClock,
  endedInError,
  isRunTiming,
  type RunOutcome,
  type RunTiming,
} from "./clock.ts";
import { describeRow, workingMessage } from "./row.ts";

const ENTRY_TYPE = "run-timing";

const GLYPH_COLORS = {
  completed: "success",
  aborted: "warning",
  error: "error",
} as const satisfies Record<RunOutcome, string>;

/**
 * Times every prompt. While it runs, the spinner row and the footer show a live
 * timer; once it settles, a row beneath the final reply records when it finished
 * and how long it took. The row is a custom session entry, so it is saved with
 * the session, shown again on resume, and never sent to the model.
 */
export default function runTimer(pi: ExtensionAPI) {
  const clock = createRunClock();
  let ticker: ReturnType<typeof setTimeout> | undefined;
  let stopRefreshListener: (() => void) | undefined;
  let state = emptyRunTimerState();

  const publish = () => pi.events.emit(RUN_TIMER_CHANNEL, { ...state });

  const outputPad = () => {
    try {
      return pi.getSettings().outputPad ?? 1;
    } catch {
      return 1;
    }
  };

  pi.registerEntryRenderer<RunTiming>(
    ENTRY_TYPE,
    (entry, { expanded }, theme) => {
      if (!isRunTiming(entry.data)) return undefined;

      const { glyph, text } = describeRow(entry.data, expanded, Date.now());
      const color = GLYPH_COLORS[entry.data.outcome];
      // The host adds the blank line above; padding matches the reply's text.
      return new Text(
        `${theme.fg(color, glyph)} ${theme.fg("dim", text)}`,
        outputPad(),
        0,
      );
    },
  );

  const tick = (ctx: ExtensionContext) => {
    const elapsedMs = clock.elapsed(Date.now());
    ctx.ui.setWorkingMessage(workingMessage(elapsedMs));
    state = { running: true, elapsedMs };
    publish();
  };

  const stopTicker = () => {
    if (ticker) clearTimeout(ticker);
    ticker = undefined;
  };

  // Aim each tick at the next whole second of the run so the display never skips.
  const scheduleTick = (ctx: ExtensionContext) => {
    stopTicker();
    const wait = 1_000 - (clock.elapsed(Date.now()) % 1_000);
    ticker = setTimeout(() => {
      tick(ctx);
      scheduleTick(ctx);
    }, wait);
    ticker.unref();
  };

  const startRun = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;

    const alreadyRunning = clock.running;
    clock.begin(Date.now());
    if (alreadyRunning) return;

    tick(ctx);
    scheduleTick(ctx);
  };

  const lastFinishedRun = (ctx: ExtensionContext) => {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (
        entry?.type === "custom" &&
        entry.customType === ENTRY_TYPE &&
        isRunTiming(entry.data)
      ) {
        return { running: false, elapsedMs: entry.data.durationMs };
      }
    }
    return emptyRunTimerState();
  };

  pi.on("session_start", (_event, ctx) => {
    stopTicker();
    clock.reset();
    stopRefreshListener?.();
    stopRefreshListener = undefined;
    state = emptyRunTimerState();
    if (ctx.mode !== "tui") return;

    // A resumed session shows how long its last prompt took.
    state = lastFinishedRun(ctx);
    // The footer asks every dashboard extension to republish when it installs.
    stopRefreshListener = pi.events.on(REFRESH_CHANNEL, publish);
    publish();
  });

  // Either may be the first signal of a run; the clock ignores the repeat.
  pi.on("before_agent_start", (_event, ctx) => startRun(ctx));
  pi.on("agent_start", (_event, ctx) => startRun(ctx));

  pi.on("agent_end", (event) => {
    clock.markEnd(Date.now(), endedInError(event.messages));
  });

  pi.on("agent_settled", (event, ctx) => {
    stopTicker();
    const timing = clock.settle(Date.now(), event.aborted);
    if (ctx.mode !== "tui") return;

    // Hand the spinner row back to pi so the next run does not flash a stale time.
    ctx.ui.setWorkingMessage();
    if (!timing) return;

    state = { running: false, elapsedMs: timing.durationMs };
    publish();
    pi.appendEntry(ENTRY_TYPE, timing);
  });

  pi.on("session_shutdown", () => {
    stopTicker();
    clock.reset();
    stopRefreshListener?.();
    stopRefreshListener = undefined;
  });
}
