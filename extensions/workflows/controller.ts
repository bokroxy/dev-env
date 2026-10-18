export const MAX_AGENT_CALLS = 32;
export const RUN_SHUTDOWN_TIMEOUT_MS = 8_000;

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Workflow was aborted");
}

/** Owns every agent task and the run-wide abort/request budget. */
export class RunController {
  private readonly abortController = new AbortController();
  private readonly tasks = new Set<Promise<unknown>>();
  private callCount = 0;
  private sealed = false;
  private parentAbort?: () => void;
  private parentSignal?: AbortSignal;

  constructor(parentSignal?: AbortSignal) {
    if (parentSignal) {
      this.parentSignal = parentSignal;
      this.parentAbort = () => this.abort("Parent operation was aborted");
      if (parentSignal.aborted) this.parentAbort();
      else
        parentSignal.addEventListener("abort", this.parentAbort, {
          once: true,
        });
    }
  }

  get signal() {
    return this.abortController.signal;
  }

  get calls() {
    return this.callCount;
  }

  schedule<T>(
    task: (signal: AbortSignal) => Promise<T>,
    invocationSignal?: AbortSignal,
  ): Promise<T> {
    if (this.sealed) return Promise.reject(new Error("Workflow is settling"));
    if (this.signal.aborted) return Promise.reject(abortError(this.signal));
    if (this.callCount >= MAX_AGENT_CALLS) {
      return Promise.reject(
        new Error(
          `Workflow exceeded the limit of ${MAX_AGENT_CALLS} agent calls`,
        ),
      );
    }
    this.callCount++;

    const running = (async () => {
      const taskAbort = new AbortController();
      const onRunAbort = () => taskAbort.abort(this.signal.reason);
      const onInvocationAbort = () => taskAbort.abort(invocationSignal?.reason);
      this.signal.addEventListener("abort", onRunAbort, { once: true });
      invocationSignal?.addEventListener("abort", onInvocationAbort, {
        once: true,
      });
      if (this.signal.aborted) onRunAbort();
      else if (invocationSignal?.aborted) onInvocationAbort();

      try {
        if (taskAbort.signal.aborted) throw abortError(taskAbort.signal);
        const result = await task(taskAbort.signal);
        if (invocationSignal?.aborted) throw abortError(invocationSignal);
        return result;
      } finally {
        this.signal.removeEventListener("abort", onRunAbort);
        invocationSignal?.removeEventListener("abort", onInvocationAbort);
      }
    })();
    this.tasks.add(running);
    void running.finally(() => this.tasks.delete(running)).catch(() => {});
    return running;
  }

  abort(reason = "Workflow was aborted") {
    if (!this.signal.aborted) this.abortController.abort(new Error(reason));
  }

  /** Seal the task registry and wait a bounded time for every task to settle. */
  async settle(options: { abort?: boolean; timeoutMs?: number } = {}) {
    this.sealed = true;
    if (options.abort) this.abort();
    const tasks = [...this.tasks];
    if (tasks.length === 0) {
      this.detachParent();
      return true;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(
        () => resolve(false),
        options.timeoutMs ?? RUN_SHUTDOWN_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    const settled = Promise.allSettled(tasks).then(() => true as const);
    const completed = await Promise.race([settled, timeout]);
    if (timer) clearTimeout(timer);
    this.detachParent();
    return completed;
  }

  private detachParent() {
    if (this.parentAbort) {
      this.parentSignal?.removeEventListener("abort", this.parentAbort);
    }
    this.parentAbort = undefined;
    this.parentSignal = undefined;
  }
}
