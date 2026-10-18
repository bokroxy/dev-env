/**
 * One timer for the whole view. The period is owned by the caller:
 * 100 ms while something animates, 500 ms when idle, 1000 ms in static mode
 * (reduced motion or NO_COLOR, where the view only redraws when data changed),
 * 0 while the overlay is closed. `unref()` keeps a forgotten clock from holding
 * the process open, and `stop()` is idempotent.
 */

export class Clock {
  private readonly onTick: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private periodMs = 0;
  private stopped = true;

  constructor(onTick: () => void) {
    this.onTick = onTick;
  }

  get period(): number {
    return this.periodMs;
  }

  get running(): boolean {
    return !this.stopped;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** 0 stops the clock; any other value reschedules with the new period. */
  setPeriod(periodMs: number): void {
    const next = Math.max(0, Math.round(periodMs));
    if (next === this.periodMs) return;
    this.periodMs = next;
    if (next === 0) {
      this.stop();
      return;
    }
    if (this.stopped) {
      this.start();
      return;
    }
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped || this.periodMs <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopped || this.periodMs <= 0) return;
      try {
        this.onTick();
      } finally {
        this.schedule();
      }
    }, this.periodMs);
    this.timer.unref?.();
  }
}
