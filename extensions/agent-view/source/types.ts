/**
 * Data shapes shared by the run scanner and the overlay. Everything here is
 * derived from pi-subagents' lifecycle artifacts (status.json,
 * workflow-children.jsonl, events.jsonl) — see BRIEF-IMPL.md.
 */

export interface TokenTotals {
  input: number;
  output: number;
  total: number;
  window?: number;
}

export interface ToolUse {
  id: string;
  /** Display-only tool family; never contains invocation arguments. */
  label: string;
  name: string;
  startedAt?: number;
  finishedAt?: number;
  failed: boolean;
}

/** What a child is doing right now, derived from its events.jsonl. */
export interface Activity {
  /** The last eight invocations, oldest first; displayed outside the bubble. */
  recentTools?: ToolUse[];
  /** Latest reasoning text (last 1-2 sentences), when the provider exposes it. */
  thought?: string;
  /** Observed time of `thought`, so a later tool call can outrank it. */
  thoughtAt?: number;
  /** Latest assistant text, when there is no thinking block. */
  text?: string;
  /** Current tool as a short line, e.g. `read: /tmp/x`. */
  tool?: string;
  toolName?: string;
  toolStartedAt?: number;
  /** pi-subagents reported the child as active but long-running. */
  longRunning?: boolean;
  /** The provider dropped or redacted the thinking text. */
  thinkingDropped?: boolean;
  error?: string;
  /**
   * Observed time of the last non-thought activity: a tool start, a tool end or
   * assistant text. A thought older than this is stale and must not come back.
   */
  lastActivityAt?: number;
  updatedAt?: number;
}

export interface Verdict {
  label: string;
  p: number;
  action?: string;
  kind?: string;
  confident: boolean;
  probabilities?: Record<string, number>;
}

export interface ChildSnapshot {
  /** Stable identity within the view: a step key or a run id. */
  key: string;
  /**
   * Globally unique row identity: `${rootRunId}/${key}`. Child keys repeat
   * across workflows (two workflows both have `review-AF4-0`), so selection,
   * rank state and Enter must key on this, never on `key`.
   */
  rowKey: string;
  runId: string;
  /** Agent name as recorded, e.g. `worker`, `delegate`, `clef`. */
  agent: string;
  /** Role key into the role thesaurus, e.g. `impl`, `review`, `clef`. */
  roleKey: string;
  model: string;
  effort: string;
  state: string;
  /** In flight right now: state `running` and the liveness check passed. */
  active: boolean;
  /**
   * Claims to be running but failed the liveness check (no
   * `.active-runs/<runId>` marker, dead pid, stale activity or past deadline).
   * Never counted, never live, no ETA, no shimmer.
   */
  stale: boolean;
  /** Declared but not started yet. */
  queued: boolean;
  failed: boolean;
  startedAt?: number;
  endedAt?: number;
  elapsedMs: number;
  turns?: number;
  tools?: number;
  tokens?: TokenTotals;
  /** `status.totalCost.costUsd` when the run published one. */
  costUsd?: number;
  /** First line of the run's top-level `status.error`. */
  error?: string;
  outputPath?: string;
  isClef: boolean;
  activity: Activity;
  verdict?: Verdict;
  /** Estimated progress 0..1. */
  progress: number;
  /** Progress came from elapsed time against a median, not from a published total. */
  estimated: boolean;
}

export interface WorkflowSnapshot {
  runId: string;
  shortId: string;
  /**
   * Human identity: `steps[0].sessionName` for a single run, `<cwd basename> ·
   * <startAt>→<stopAfter>` (or `args.title`) for a workflow, plus a short
   * args digest when two titles collide.
   */
  title: string;
  mode: string;
  state: string;
  /** cwd basename; shown dimmed next to a session-name title. */
  cwdName?: string;
  /** `steps[0].sessionName`, when the run published one. */
  sessionName?: string;
  cwd?: string;
  tint: number;
  otherSession: boolean;
  /** The root is actually running: state running + liveness check passed. */
  live: boolean;
  /** Claims running but failed the liveness check. */
  stale: boolean;
  /** First line of the root's top-level `status.error`. */
  error?: string;
  /** `totalTokens.total`, or the sum over the children when the root has none. */
  tokens?: number;
  /** `totalCost.costUsd`, or the sum over the children when the root has none. */
  costUsd?: number;
  startedAt: number;
  elapsedMs: number;
  /** `endedAt ?? lastUpdate` — the age reference for a finished root. */
  finishedAt?: number;
  children: ChildSnapshot[];
  activeCount: number;
  doneCount: number;
  seenCount: number;
  knownTotal: number;
  inventoryComplete: boolean;
  /** Mean of per-child progress. */
  progress: number;
  /** Estimated remaining milliseconds for the known children. */
  etaMs: number;
  /**
   * Expected duration of the longest active child: the number behind `etaMs`,
   * shown as `typical <dur>` once a run overruns it.
   */
  expectedMs: number;
}

export interface ViewSnapshot {
  workflows: WorkflowSnapshot[];
  /** Workflows hidden because only the newest terminal ones are kept. */
  hiddenWorkflows: number;
  runCount: number;
  runningCount: number;
  doneCount: number;
  error?: string;
  scannedAt: number;
  generation: number;
}

// pi-subagents' own terminal-run-index lists exactly these: complete, failed,
// partial, paused, stopped, rejected. `detached` and the rest are defensive.
const TERMINAL = new Set([
  "complete",
  "completed",
  "failed",
  "error",
  "partial",
  "detached",
  "stopped",
  "paused",
  "cancelled",
  "canceled",
  "aborted",
  "rejected",
  "killed",
  "timedout",
  "timeout",
  "expired",
]);

const FAILED = new Set([
  "failed",
  "error",
  "rejected",
  "killed",
  "timedout",
  "timeout",
]);

const QUEUED = new Set(["queued", "pending"]);

/** A running agent's displayed estimate never reaches 100 %. */
export const MAX_RUNNING_PROGRESS = 0.99;

/** Unknown states stay visible (treated as active) rather than being silently dropped. */
export function isTerminalState(state: string): boolean {
  if (!state) return false;
  const normalized = state.toLowerCase().replace(/[_\s-]/g, "");
  if (TERMINAL.has(normalized)) return true;
  // `complete`-like compounds such as `completedWithWarnings`.
  return normalized.startsWith("complete") || normalized.startsWith("done");
}

export function isFailedState(state: string): boolean {
  const normalized = state.toLowerCase().replace(/[_\s-]/g, "");
  return FAILED.has(normalized) || normalized.startsWith("fail");
}

export function isQueuedState(state: string): boolean {
  return QUEUED.has(state.toLowerCase().replace(/[\s-]/g, ""));
}

/**
 * In flight *now*: state `running` only. pi-subagents also has `queued`, but it is never persisted to a root
 * `status.json`; here only `running` is active. A state we
 * do not recognise (`partial`, `detached`, anything new) is never running.
 */
export function isActiveState(state: string): boolean {
  return normalizeState(state) === "running";
}

/** pi-subagents' notion of "not finished": queued or running. */
export function isLiveState(state: string): boolean {
  return isActiveState(state) || isQueuedState(state);
}

export function isStoppedState(state: string): boolean {
  return normalizeState(state) === "stopped";
}

/**
 * A run that finished successfully. `partial`, `paused`, `detached`, `expired`
 * and the rest are terminal but not done: they must not count as 100 %, must
 * not rank a child up and must not feed the duration medians.
 */
export function isDoneState(state: string): boolean {
  if (isFailedState(state) || isStoppedState(state)) return false;
  const normalized = normalizeState(state);
  return normalized.startsWith("complete") || normalized.startsWith("done");
}

function normalizeState(state: string): string {
  return state.toLowerCase().replace(/[\s_-]/g, "");
}

/** How a state renders: `? <state>` for anything we do not model. */
export type StateKind =
  "running" | "queued" | "done" | "failed" | "stopped" | "unrecognised";

export function stateKind(state: string): StateKind {
  if (isActiveState(state)) return "running";
  if (isQueuedState(state)) return "queued";
  if (isFailedState(state)) return "failed";
  if (isStoppedState(state)) return "stopped";
  if (isDoneState(state)) return "done";
  return "unrecognised";
}

export function isClefAgent(
  agent: string,
  key: string,
  roleKey: string,
): boolean {
  return (
    roleKey === "clef" ||
    agent.toLowerCase() === "clef" ||
    key.toLowerCase().startsWith("clef")
  );
}
/** A curated tint set so every workflow reads as its own faint colour. */
const TINTS = [67, 96, 102, 139, 109, 138, 144, 175, 108, 66, 103, 137];

export function tintFor(seed: string): number {
  let h = 2166136261;
  for (const char of seed) {
    h ^= char.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return TINTS[(h >>> 0) % TINTS.length];
}
