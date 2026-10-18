import { AsyncLocalStorage } from "node:async_hooks";

export type PauseState = "running" | "pausing" | "paused";

/** Cooperative admission control. Paused means all admitted operations have actually drained. */
export class PauseGate {
  private requested = false;
  private active = 0;
  private stopped?: Error;
  private listeners = new Set<(state: PauseState) => void>();
  private waiters = new Set<() => void>();
  private scope = new AsyncLocalStorage<{ active: boolean }>();

  get state(): PauseState {
    return !this.requested ? "running" : this.active > 0 ? "pausing" : "paused";
  }

  subscribe(listener: (state: PauseState) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed() {
    for (const listener of this.listeners) listener(this.state);
  }

  requestPause() {
    if (this.stopped) throw this.stopped;
    this.requested = true;
    this.changed();
  }

  resume() {
    if (this.stopped) throw this.stopped;
    this.requested = false;
    for (const wake of [...this.waiters]) wake();
    this.changed();
  }

  abort(reason = "Workflow cancelled") {
    this.stopped ??= new Error(reason);
    for (const wake of [...this.waiters]) wake();
  }

  async wait(signal?: AbortSignal) {
    // A currently executing orchestration tool can finish its own nested calls.
    // Blocking those while draining the outer tool would deadlock pause.
    while (this.requested && !this.scope.getStore()?.active) {
      this.check(signal);
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.waiters.delete(wake);
          signal?.removeEventListener("abort", wake);
          resolve();
        };
        this.waiters.add(wake);
        signal?.addEventListener("abort", wake, { once: true });
      });
    }
    this.check(signal);
  }

  private check(signal?: AbortSignal) {
    if (this.stopped) throw this.stopped;
    signal?.throwIfAborted();
  }

  async enter(signal?: AbortSignal) {
    do {
      await this.wait(signal);
    } while (this.requested && !this.scope.getStore()?.active);
    // Admission and the pause request cannot interleave within this synchronous section.
    this.check(signal);
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.changed();
    };
  }

  async operation<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.enter(signal);
    const scope = { active: true };
    try {
      return await this.scope.run(scope, task);
    } finally {
      scope.active = false;
      release();
    }
  }
}
