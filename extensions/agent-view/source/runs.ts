/**
 * Discovery and incremental parsing of pi-subagents' lifecycle artifacts.
 *
 * Root: /tmp/pi-subagents-uid-<uid>/async-subagent-runs/<runId>/ for the current
 * uid. Each run has its own status.json, events.jsonl and output-<n>.log; a
 * workflow parent additionally has workflow-children.jsonl, which is the source
 * of truth for its child list (status.json.workflowChildren is bounded and
 * partial while running).
 *
 * The scanner never re-reads a file that did not change (status.json is keyed by
 * mtime+size) and only tails events.jsonl for children that are still running
 * (plus once for one that just finished). Run dirs that disappear (retention)
 * are dropped without throwing.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyEvent,
  applyEventLine,
  emptyActivity,
  eventStepIndex,
  parseEventLine,
} from "./derive.ts";
import { DurationBook } from "./history.ts";
import { redact } from "./redact.ts";
import { LineTailer } from "./tail.ts";
import {
  isActiveState,
  isClefAgent,
  isDoneState,
  isFailedState,
  isQueuedState,
  isTerminalState,
  MAX_RUNNING_PROGRESS,
  tintFor,
  type Activity,
  type ChildSnapshot,
  type TokenTotals,
  type ViewSnapshot,
  type Verdict,
  type WorkflowSnapshot,
} from "./types.ts";
import { clefOutputPaths, parseVerdict } from "./verdict.ts";
import { detectRole } from "../persona.ts";

/** Conservative fallbacks (ms) before any history exists for a role. */
export const DEFAULT_EXPECTED_MS: Record<string, number> = {
  impl: 20 * 60_000,
  worker: 20 * 60_000,
  fix: 15 * 60_000,
  review: 15 * 60_000,
  research: 12 * 60_000,
  scout: 8 * 60_000,
  oracle: 10 * 60_000,
  clef: 20_000,
  delegate: 15 * 60_000,
};

const MAX_STATUS_BYTES = 4 * 1024 * 1024;
const MAX_TERMINAL_WORKFLOWS = 12;
const CLEF_TAIL_BYTES = 8 * 1024;
/**
 * How far a median may undercut the conservative per-role default. Without
 * this floor one lucky short run makes the next run look finished.
 */
const MIN_EXPECTED_FRACTION = 0.25;
/** pi-subagents' liveness marker index: `<runs>/.active-runs/<runId>`. */
export const ACTIVE_MARKER_DIR = ".active-runs";
/** A running run with no marker and no activity for this long is stale. */
export const STALE_ACTIVITY_MS = 10 * 60_000;

/**
 * Root-run liveness. `running` alone is not enough: a finished `partial` run
 * (and a crashed one whose status.json was never rewritten) claims running
 * forever. Live requires the `.active-runs/<runId>` marker, or — when the
 * marker is missing — a live pid AND activity within `STALE_ACTIVITY_MS` AND
 * an unexpired deadline. Everything else is `stale`: warning colour, no ETA,
 * no shimmer, not counted, not live.
 */
export interface Liveness {
  live: boolean;
  stale: boolean;
}

export function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isFinite(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means the process exists but belongs to another user.
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function livenessFor(
  status: {
    runId: string;
    state: string;
    pid?: number;
    lastActivityAt?: number;
    lastUpdate?: number;
    deadlineAt?: number;
  },
  markers: ReadonlySet<string>,
  now: number,
): Liveness {
  if (!isActiveState(status.state)) return { live: false, stale: false };
  if (markers.has(status.runId)) return { live: true, stale: false };
  const lastSeen = status.lastActivityAt ?? status.lastUpdate;
  const fresh = lastSeen !== undefined && now - lastSeen < STALE_ACTIVITY_MS;
  const beforeDeadline =
    status.deadlineAt === undefined || now < status.deadlineAt;
  if (isProcessAlive(status.pid) && fresh && beforeDeadline)
    return { live: true, stale: false };
  return { live: false, stale: true };
}

export function defaultRunsDir(
  uid = typeof process.getuid === "function" ? process.getuid() : 0,
): string {
  const configuredRoot = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  const root = configuredRoot
    ? path.resolve(configuredRoot)
    : path.join(os.tmpdir(), `pi-subagents-uid-${uid}`);
  return path.join(root, "async-subagent-runs");
}

interface StepInfo {
  index: number;
  agent: string;
  status: string;
  label?: string;
  runId?: string;
  startedAt?: number;
  durationMs?: number;
  model?: string;
  thinking?: string;
  sessionName?: string;
  tokens?: TokenTotals;
  costUsd?: number;
  toolCount?: number;
  turnCount?: number;
}

interface WorkflowChildInfo {
  childId: string;
  runId: string;
  agent: string;
  state: string;
}

interface ParsedStatus {
  runId: string;
  sessionId?: string;
  mode: string;
  state: string;
  startedAt?: number;
  endedAt?: number;
  lastUpdate?: number;
  lastActivityAt?: number;
  /** `steps[0].sessionName`: the human line pi-subagents shows in its own list. */
  sessionName?: string;
  pid?: number;
  deadlineAt?: number;
  cwd?: string;
  steps: StepInfo[];
  model?: string;
  thinking?: string;
  turnCount?: number;
  toolCount?: number;
  totalTokens?: TokenTotals;
  costUsd?: number;
  error?: string;
  parentWorkflowRunId?: string;
  workflowKey?: string;
  workflowChildren?: {
    inventoryComplete: boolean;
    children: WorkflowChildInfo[];
  };
  plannedChildren?: string[];
  workflowTitle?: string;
  startAt?: string;
  stopAfter?: string;
  argsDigest?: string;
  outputFile?: string;
}

interface RunEntry {
  runId: string;
  dir: string;
  mtimeMs: number;
  size: number;
  status?: ParsedStatus;
  statusText?: string;
  /** One tailer for events.jsonl; events are routed by `subagentStepIndex`. */
  eventTailer?: LineTailer;
  /** One tailer for workflow-children.jsonl on workflow parents. */
  childTailer?: LineTailer;
  activities: Map<number, Activity>;
  finishedTailed: boolean;
  verdict?: Verdict;
  verdictFingerprint?: string;
  childIndex?: Map<string, string>;
  childOrder?: string[];
  /** The one extra child-index pass after the root turned terminal. */
  childIndexFinal?: boolean;
}

export interface ScannerOptions {
  runsDir?: string;
  sessionFile?: string;
  includeOtherSessions?: boolean;
  historyDir?: string;
  now?: () => number;
  maxTerminalWorkflows?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseTokens(value: unknown): TokenTotals | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const input = num(record.input) ?? 0;
  const output = num(record.output) ?? 0;
  const total = num(record.total) ?? input + output;
  const window = num(record.window);
  return { input, output, total, ...(window !== undefined ? { window } : {}) };
}

/** `status.totalCost.costUsd` — present on some runs, absent on most. */
function parseCost(value: unknown): number | undefined {
  const record = asRecord(value);
  const cost = num(record?.costUsd);
  return cost !== undefined && cost >= 0 ? cost : undefined;
}

/** First line of a run's top-level `status.error`, for failed rows. */
function firstLine(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const line = value.split("\n")[0]?.trim();
  return line ? line : undefined;
}

function parseStatusText(text: string): ParsedStatus | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const record = asRecord(raw);
  if (!record) return undefined;
  const runId = str(record.runId);
  if (!runId) return undefined;

  const steps: StepInfo[] = [];
  const rawSteps = Array.isArray(record.steps) ? record.steps : [];
  rawSteps.forEach((entry, index) => {
    const step = asRecord(entry);
    if (!step) return;
    steps.push({
      index,
      agent: str(step.agent) ?? "delegate",
      status: str(step.status) ?? "pending",
      ...(str(step.label) ? { label: str(step.label) } : {}),
      ...(str(step.runId) ? { runId: str(step.runId) } : {}),
      ...(num(step.startedAt) !== undefined
        ? { startedAt: num(step.startedAt) }
        : {}),
      ...(num(step.durationMs) !== undefined
        ? { durationMs: num(step.durationMs) }
        : {}),
      ...(str(step.model) ? { model: str(step.model) } : {}),
      ...(str(step.thinking) ? { thinking: str(step.thinking) } : {}),
      ...(str(step.sessionName) ? { sessionName: str(step.sessionName) } : {}),
      ...(parseTokens(step.tokens) ? { tokens: parseTokens(step.tokens) } : {}),
      ...(parseCost(step.totalCost) !== undefined
        ? { costUsd: parseCost(step.totalCost) }
        : {}),
      ...(num(step.toolCount) !== undefined
        ? { toolCount: num(step.toolCount) }
        : {}),
      ...(num(step.turnCount) !== undefined
        ? { turnCount: num(step.turnCount) }
        : {}),
    });
  });

  let workflowChildren: ParsedStatus["workflowChildren"];
  const childrenRecord = asRecord(record.workflowChildren);
  if (childrenRecord) {
    const children: WorkflowChildInfo[] = [];
    for (const entry of Array.isArray(childrenRecord.children)
      ? childrenRecord.children
      : []) {
      const child = asRecord(entry);
      const runIdValue = str(child?.runId);
      if (!child || !runIdValue) continue;
      children.push({
        childId: str(child.childId) ?? runIdValue,
        runId: runIdValue,
        agent: str(child.agent) ?? "delegate",
        state: str(child.state) ?? "unknown",
      });
    }
    workflowChildren = {
      inventoryComplete: childrenRecord.inventoryComplete === true,
      children,
    };
  }

  let plannedChildren: string[] | undefined;
  const workflow = asRecord(record.workflow);
  const args = asRecord(workflow?.args);
  const planned = args?.plannedChildren;
  if (Array.isArray(planned)) {
    const list = planned.filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (list.length > 0) plannedChildren = list;
  }

  const firstStep = steps[0];
  // A title is `steps[0].sessionName`, which pi-subagents fills from the task
  // prompt, and `error` quotes run output: both go through redact() like every
  // other string the view prints.
  const sessionName = redact(str(firstStep?.sessionName) ?? "");
  const errorLine = firstLine(str(record.error));
  return {
    runId,
    ...(str(record.sessionId) ? { sessionId: str(record.sessionId) } : {}),
    mode: str(record.mode) ?? "single",
    state: str(record.state) ?? "unknown",
    ...(num(record.startedAt) !== undefined
      ? { startedAt: num(record.startedAt) }
      : {}),
    ...(num(record.endedAt) !== undefined
      ? { endedAt: num(record.endedAt) }
      : {}),
    ...(num(record.lastUpdate) !== undefined
      ? { lastUpdate: num(record.lastUpdate) }
      : {}),
    ...(num(record.lastActivityAt) !== undefined
      ? { lastActivityAt: num(record.lastActivityAt) }
      : {}),
    ...(num(record.pid) !== undefined ? { pid: num(record.pid) } : {}),
    ...(num(record.deadlineAt) !== undefined
      ? { deadlineAt: num(record.deadlineAt) }
      : {}),
    ...(str(record.cwd) ? { cwd: str(record.cwd) } : {}),
    steps,
    ...(firstStep?.model ? { model: firstStep.model } : {}),
    ...(firstStep?.thinking ? { thinking: firstStep.thinking } : {}),
    ...(sessionName ? { sessionName } : {}),
    ...(num(record.turnCount) !== undefined
      ? { turnCount: num(record.turnCount) }
      : {}),
    ...(num(record.toolCount) !== undefined
      ? { toolCount: num(record.toolCount) }
      : {}),
    ...(parseTokens(record.totalTokens)
      ? { totalTokens: parseTokens(record.totalTokens) }
      : {}),
    ...(parseCost(record.totalCost) !== undefined
      ? { costUsd: parseCost(record.totalCost) }
      : {}),
    ...(errorLine ? { error: redact(errorLine) } : {}),
    ...(str(record.parentWorkflowRunId)
      ? { parentWorkflowRunId: str(record.parentWorkflowRunId) }
      : {}),
    ...(str(record.workflowKey)
      ? { workflowKey: str(record.workflowKey) }
      : {}),
    ...(workflowChildren ? { workflowChildren } : {}),
    ...(plannedChildren ? { plannedChildren } : {}),
    ...(str(args?.title) ? { workflowTitle: str(args?.title) } : {}),
    ...(str(args?.startAt) ? { startAt: str(args?.startAt) } : {}),
    ...(str(args?.stopAfter) ? { stopAfter: str(args?.stopAfter) } : {}),
    ...(str(workflow?.argsDigest)
      ? { argsDigest: str(workflow?.argsDigest) }
      : {}),
    ...(str(record.outputFile) ? { outputFile: str(record.outputFile) } : {}),
  };
}

function parseChildLine(
  line: string,
): { key: string; runId: string } | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = asRecord(raw);
  if (!record) return undefined;
  const key = str(record.key);
  const runId = str(record.runId);
  if (!key || !runId) return undefined;
  if (record.type !== undefined && record.type !== "start") return undefined;
  return { key, runId };
}

function readCleftVerdict(
  runDir: string,
  runId: string,
  fingerprint: string,
  cache: { fingerprint?: string; verdict?: Verdict },
): Verdict | undefined {
  if (cache.fingerprint === fingerprint) return cache.verdict;
  cache.fingerprint = fingerprint;
  cache.verdict = undefined;
  for (const candidate of clefOutputPaths(runDir, runId)) {
    let text = "";
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile() || stat.size === 0) continue;
      const length = Math.min(stat.size, CLEF_TAIL_BYTES);
      const buffer = Buffer.allocUnsafe(length);
      const fd = fs.openSync(candidate, "r");
      let read = 0;
      try {
        read = fs.readSync(fd, buffer, 0, length, stat.size - length);
      } finally {
        fs.closeSync(fd);
      }
      text = buffer.subarray(0, read).toString("utf8");
    } catch {
      continue;
    }
    const verdict = parseVerdict(text);
    if (verdict) {
      cache.verdict = verdict;
      return verdict;
    }
  }
  return undefined;
}

export class RunScanner {
  readonly runsDir: string;
  private readonly now: () => number;
  private readonly maxTerminalWorkflows: number;
  private readonly durations: DurationBook;
  private sessionFile: string | undefined;
  private includeOtherSessions: boolean;
  private readonly runs = new Map<string, RunEntry>();
  private activeRuns = new Set<string>();
  private markerFingerprint = "";
  private generation = 0;
  private cachedSnapshot?: ViewSnapshot;
  private cachedAt = 0;
  private cachedNow = -1;
  private error?: string;

  constructor(options: ScannerOptions = {}) {
    this.runsDir = options.runsDir ?? defaultRunsDir();
    this.now = options.now ?? (() => Date.now());
    this.sessionFile = options.sessionFile;
    this.includeOtherSessions = options.includeOtherSessions === true;
    this.maxTerminalWorkflows =
      options.maxTerminalWorkflows ?? MAX_TERMINAL_WORKFLOWS;
    const historyDir =
      options.historyDir ??
      path.join(
        process.env.PI_CODING_AGENT_DIR ||
          path.join(os.homedir(), ".pi", "agent"),
        "agent-view",
      );
    this.durations = new DurationBook(
      path.join(historyDir, "durations.json"),
      this.now,
    );
  }

  setSessionFile(sessionFile: string | undefined): void {
    this.sessionFile = sessionFile;
    this.invalidate();
  }

  setIncludeOtherSessions(value: boolean): void {
    this.includeOtherSessions = value;
    this.invalidate();
  }

  get includesOtherSessions(): boolean {
    return this.includeOtherSessions;
  }

  get durationBook(): DurationBook {
    return this.durations;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  private invalidate(): void {
    this.generation += 1;
    this.cachedSnapshot = undefined;
  }

  /** Re-stat everything, parse what changed, tail what is running. */
  poll(): boolean {
    let changed = this.refreshActiveMarkers();
    let names: string[];
    try {
      names = fs
        .readdirSync(this.runsDir, { withFileTypes: true })
        // `.active-runs`, `.terminal-runs` and friends are indexes, not runs.
        .filter(
          (entry) =>
            !entry.name.startsWith(".") &&
            (entry.isDirectory() || entry.isSymbolicLink()),
        )
        .map((entry) => entry.name);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      const hadRuns = this.runs.size > 0;
      if (hadRuns) this.runs.clear();
      // A missing runs directory is not an error: it means no runs on disk yet
      // (a fresh boot, before pi-subagents created it, or after retention).
      if (code === "ENOENT") {
        if (this.error !== undefined) {
          this.error = undefined;
          this.invalidate();
          return true;
        }
        return hadRuns;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      if (this.error !== message) {
        this.error = message;
        this.invalidate();
        return true;
      }
      return hadRuns;
    }
    if (this.error) {
      this.error = undefined;
      this.invalidate();
      changed = true;
    }

    const seen = new Set(names);
    for (const runId of [...this.runs.keys()]) {
      if (!seen.has(runId)) {
        this.runs.delete(runId);
        changed = true;
      }
    }

    for (const runId of names) {
      const entry = this.entryFor(runId);
      if (this.refreshEntry(entry)) changed = true;
    }
    if (changed) this.invalidate();
    return changed;
  }

  /**
   * pi-subagents writes one empty file per in-flight run into
   * `<runs>/.active-runs/`; one readdir per poll keeps the liveness check cheap
   * and, because it is part of the change detection, makes a marker appear or
   * disappear redraw the view even in static mode.
   */
  private refreshActiveMarkers(): boolean {
    let names: string[] = [];
    try {
      names = fs
        .readdirSync(path.join(this.runsDir, ACTIVE_MARKER_DIR), {
          withFileTypes: true,
        })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch {
      names = [];
    }
    const fingerprint = [...names].sort().join("\n");
    if (fingerprint === this.markerFingerprint) return false;
    this.markerFingerprint = fingerprint;
    this.activeRuns = new Set(names);
    return true;
  }

  private entryFor(runId: string): RunEntry {
    const existing = this.runs.get(runId);
    if (existing) return existing;
    const dir = path.join(this.runsDir, runId);
    const entry: RunEntry = {
      runId,
      dir,
      mtimeMs: -1,
      size: -1,
      activities: new Map(),
      finishedTailed: false,
    };
    this.runs.set(runId, entry);
    return entry;
  }

  /** Returns true when the entry changed in a way the view should see. */
  private refreshEntry(entry: RunEntry): boolean {
    let changed = false;
    const statusFile = path.join(entry.dir, "status.json");
    let mtimeMs: number;
    let size: number;
    try {
      const stat = fs.statSync(statusFile);
      mtimeMs = stat.mtimeMs;
      size = stat.size;
    } catch {
      // status.json gone (retention) — drop the parsed state but keep the dir out of the view
      if (entry.status !== undefined) {
        entry.status = undefined;
        changed = true;
      }
      return changed;
    }

    if (mtimeMs !== entry.mtimeMs || size !== entry.size) {
      entry.mtimeMs = mtimeMs;
      entry.size = size;
      let text: string | undefined;
      try {
        if (size > 0 && size <= MAX_STATUS_BYTES)
          text = fs.readFileSync(statusFile, "utf8");
      } catch {
        text = undefined;
      }
      if (text !== undefined && text !== entry.statusText) {
        const parsed = parseStatusText(text);
        entry.statusText = text;
        if (parsed) {
          entry.status = parsed;
          changed = true;
        }
      }
    }

    const status = entry.status;
    if (!status) return changed;

    if (status.mode === "workflow" && !isTerminalState(status.state)) {
      if (this.refreshChildrenIndex(entry)) changed = true;
    } else if (!entry.childIndexFinal) {
      // One last pass on the transition to terminal: a child whose `start` line
      // was appended between the last running poll and the terminal status is
      // indexed here and never again.
      if (this.refreshChildrenIndex(entry)) changed = true;
      entry.childIndexFinal = true;
    }

    if (this.tailActivities(entry)) changed = true;
    if (this.refreshVerdict(entry)) changed = true;
    this.recordDurations(entry);
    return changed;
  }

  private refreshChildrenIndex(entry: RunEntry): boolean {
    const file = path.join(entry.dir, "workflow-children.jsonl");
    if (!entry.childTailer) {
      entry.childTailer = new LineTailer(file, {
        maxLine: 64 * 1024,
        windowSize: 64,
      });
    }
    const lines = entry.childTailer.poll();
    let changed = false;
    if (lines.length > 0) changed = true;
    if (!entry.childIndex) entry.childIndex = new Map();
    if (!entry.childOrder) entry.childOrder = [];
    for (const line of lines) {
      const child = parseChildLine(line);
      if (!child || entry.childIndex.has(child.key)) continue;
      entry.childIndex.set(child.key, child.runId);
      entry.childOrder.push(child.key);
      changed = true;
    }
    const fromStatus = entry.status?.workflowChildren?.children ?? [];
    for (const child of fromStatus) {
      if (entry.childIndex.has(child.childId)) continue;
      entry.childIndex.set(child.childId, child.runId);
      entry.childOrder.push(child.childId);
      changed = true;
    }
    for (const planned of entry.status?.plannedChildren ?? []) {
      if (entry.childIndex.has(planned)) continue;
      entry.childIndex.set(planned, "");
      entry.childOrder.push(planned);
      changed = true;
    }
    return changed;
  }

  private activityFor(entry: RunEntry, stepIndex: number): Activity {
    const existing = entry.activities.get(stepIndex);
    if (existing) return existing;
    const activity = emptyActivity();
    entry.activities.set(stepIndex, activity);
    return activity;
  }

  private tailActivities(entry: RunEntry): boolean {
    const status = entry.status;
    if (!status) return false;
    const active = !isTerminalState(status.state);
    if (!active && entry.finishedTailed) return false;

    const file = path.join(entry.dir, "events.jsonl");
    // A run first seen in a terminal state is read once: from the beginning,
    // or from the last chunk for a file larger than the tailer's chunk cap. A
    // running one is only ever read incrementally from where we left off.
    if (!entry.eventTailer) entry.eventTailer = new LineTailer(file);
    const lines = entry.eventTailer.poll();
    let changed = false;
    for (const line of lines) {
      const event = parseEventLine(line);
      if (!event) continue;
      applyEvent(this.activityFor(entry, eventStepIndex(event)), event);
      changed = true;
    }
    if (!active) entry.finishedTailed = true;
    return changed;
  }

  private refreshVerdict(entry: RunEntry): boolean {
    const status = entry.status;
    if (!status) return false;
    const agent = status.steps[0]?.agent ?? "";
    const key = status.workflowKey ?? status.runId;
    if (!isClefAgent(agent, key, detectRole(key, agent))) return false;
    const outputPath =
      status.outputFile ?? path.join(entry.dir, "output-0.log");
    let fingerprint = "missing";
    try {
      const stat = fs.statSync(outputPath);
      fingerprint = `${stat.size}:${stat.mtimeMs}`;
    } catch {
      fingerprint = "missing";
    }
    const cache = {
      fingerprint: entry.verdictFingerprint,
      verdict: entry.verdict,
    };
    const verdict = readCleftVerdict(
      entry.dir,
      entry.runId,
      fingerprint,
      cache,
    );
    entry.verdictFingerprint = cache.fingerprint;
    if (verdict !== entry.verdict) {
      entry.verdict = verdict;
      return true;
    }
    return false;
  }

  /** Feed the duration history the first time a finished child is seen. */
  private recordDurations(entry: RunEntry): void {
    const status = entry.status;
    if (!status || !isDoneState(status.state) || status.mode === "workflow")
      return;
    const started = status.startedAt;
    const ended = status.endedAt ?? status.lastUpdate;
    const duration =
      started !== undefined && ended !== undefined
        ? ended - started
        : status.steps[0]?.durationMs;
    const agent = status.steps[0]?.agent ?? "delegate";
    const key = status.workflowKey ?? status.runId;

    // One sample per child, under the role the view will use for its estimate:
    // the child key for a single run, each step's own label for a chain.
    if (status.steps.length > 1) {
      for (const step of status.steps) {
        if (!isDoneState(step.status)) continue;
        const stepRole = detectRole(step.label ?? status.runId, step.agent);
        if (step.durationMs === undefined || step.durationMs <= 0) continue;
        if (
          this.durations.record(
            stepRole,
            `${entry.runId}:${step.index}`,
            step.durationMs,
          )
        ) {
          this.durations.save();
        }
      }
      return;
    }
    if (duration === undefined || duration <= 0) return;
    if (this.durations.record(detectRole(key, agent), entry.runId, duration))
      this.durations.save();
  }

  private expectedMs(roleKey: string): number {
    const fallback =
      DEFAULT_EXPECTED_MS[roleKey] ?? DEFAULT_EXPECTED_MS.delegate;
    const median = this.durations.medianMs(roleKey);
    if (median === undefined) return fallback;
    return Math.max(median, fallback * MIN_EXPECTED_FRACTION);
  }

  /**
   * Which session a root belongs to. Without a session file (the standalone
   * watcher, or `pi --no-session`) nothing can be attributed to "this
   * session", so a run that names one belongs to that session instead.
   */
  private matchesSession(status: ParsedStatus): boolean {
    if (!this.sessionFile) return status.sessionId === undefined;
    if (!status.sessionId) return false;
    return status.sessionId === this.sessionFile;
  }

  /**
   * One card row. `live`/`stale` come from the liveness check (`livenessFor`)
   * and are never derived from the raw state alone. For a chain or a parallel
   * run the row is one step, and that step owns its model, effort, start time,
   * counters and output file.
   */
  private buildChild(params: {
    rootRunId: string;
    key: string;
    runId: string;
    agent: string;
    state: string;
    live: boolean;
    stale: boolean;
    now: number;
    step?: StepInfo;
  }): ChildSnapshot {
    const { rootRunId, key, runId, state, live, stale, now } = params;
    const entry = runId ? this.runs.get(runId) : undefined;
    const status = entry?.status;
    const step = params.step ?? status?.steps[0];
    const agent = params.agent || step?.agent || "delegate";
    const roleKey = detectRole(key, agent);
    const startedAt = step?.startedAt ?? status?.startedAt;
    const stepDuration = step?.durationMs;
    // A finished step knows its own duration; the run's end belongs to the run's
    // last step, not to every row of the chain.
    const endedAt =
      stepDuration !== undefined && step?.startedAt !== undefined
        ? step.startedAt + stepDuration
        : (status?.endedAt ??
          (isTerminalState(state) ? status?.lastUpdate : undefined));
    const elapsedMs =
      stepDuration !== undefined
        ? Math.max(0, stepDuration)
        : startedAt !== undefined
          ? Math.max(0, (endedAt ?? now) - startedAt)
          : 0;
    const tokens = step?.tokens ?? status?.totalTokens;
    const costUsd = step?.costUsd ?? status?.costUsd;
    const isClef = isClefAgent(agent, key, roleKey);
    const model = formatModel(
      step?.model ?? status?.model,
      step?.thinking ?? status?.thinking,
    );
    const stepIndex = step?.index ?? 0;
    return {
      key,
      // A single run's key already is its run id; everything else (workflow
      // children, chain steps) gets the root run id as a namespace so child
      // keys may repeat across workflows without breaking selection.
      rowKey: key === rootRunId ? key : `${rootRunId}/${key}`,
      runId,
      agent,
      roleKey,
      model: model.name,
      effort: model.effort,
      state,
      active: live,
      stale,
      queued: isQueuedState(state),
      failed: isFailedState(state),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
      elapsedMs,
      ...(step?.turnCount !== undefined
        ? { turns: step.turnCount }
        : status?.turnCount !== undefined
          ? { turns: status.turnCount }
          : {}),
      ...(step?.toolCount !== undefined
        ? { tools: step.toolCount }
        : status?.toolCount !== undefined
          ? { tools: status.toolCount }
          : {}),
      ...(tokens ? { tokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(status?.error ? { error: status.error } : {}),
      ...(runId
        ? {
            outputPath: path.join(
              this.runsDir,
              runId,
              `output-${stepIndex}.log`,
            ),
          }
        : {}),
      isClef,
      // A chain/parallel row reads only its own step's events. A single run
      // (no step passed) keeps the `get(0)` fallback for runs whose events carry
      // no `subagentStepIndex` at all.
      activity:
        entry?.activities.get(stepIndex) ??
        (params.step === undefined ? entry?.activities.get(0) : undefined) ??
        emptyActivity(),
      ...(isClef && entry?.verdict ? { verdict: entry.verdict } : {}),
      progress: progressFor(state, elapsedMs, this.expectedMs(roleKey)),
      estimated: isActiveState(state),
    };
  }

  snapshot(): ViewSnapshot {
    const now = this.now();
    // The snapshot carries derived times (elapsed, progress), so it is keyed by
    // the clock as well as the data generation: several calls in one tick reuse
    // it, the next tick rebuilds it even when no file changed.
    if (
      this.cachedSnapshot &&
      this.cachedAt === this.generation &&
      this.cachedNow === now
    ) {
      return this.cachedSnapshot;
    }

    const workflows: WorkflowSnapshot[] = [];
    let hidden = 0;
    let runningCount = 0;
    let doneCount = 0;

    const roots: { entry: RunEntry; liveness: Liveness }[] = [];
    for (const entry of this.runs.values()) {
      const status = entry.status;
      if (!status) continue;
      if (status.parentWorkflowRunId) continue;
      const liveness = livenessFor(status, this.activeRuns, now);
      if (!this.matchesSession(status)) {
        // Live runs from other sessions are welcome when asked for. Finished
        // ones are not, unless runs cannot be attributed at all (no session
        // file): the standalone watcher has no session and shows every
        // session's history.
        const attributable = this.sessionFile !== undefined;
        if (!this.includeOtherSessions || (!liveness.live && attributable))
          continue;
      }
      roots.push({ entry, liveness });
    }

    // Now: actually live roots (liveness passed), oldest first. Recent: every
    // other root — a stale one included — newest finish first.
    const nowRoots = roots
      .filter((root) => root.liveness.live)
      .sort(
        (left, right) =>
          (left.entry.status?.startedAt ?? 0) -
          (right.entry.status?.startedAt ?? 0),
      );
    const recentRoots = roots
      .filter((root) => !root.liveness.live)
      .sort(
        (left, right) =>
          finishedAtOf(right.entry.status) - finishedAtOf(left.entry.status),
      );
    if (recentRoots.length > this.maxTerminalWorkflows) {
      hidden = recentRoots.length - this.maxTerminalWorkflows;
      recentRoots.length = this.maxTerminalWorkflows;
    }

    // Two workflows from the same cwd with the same stage range would render an
    // identical title, so colliding titles carry a short args digest.
    const titles = new Map<string, string>();
    const titleCounts = new Map<string, number>();
    for (const root of [...nowRoots, ...recentRoots]) {
      const status = root.entry.status;
      if (!status) continue;
      const title = this.titleFor(status);
      titles.set(status.runId, title);
      titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
    }
    for (const root of [...nowRoots, ...recentRoots]) {
      const status = root.entry.status;
      if (!status) continue;
      const title = titles.get(status.runId) ?? status.runId;
      if ((titleCounts.get(title) ?? 0) < 2) continue;
      const digest = status.argsDigest?.slice(0, 6) ?? status.runId.slice(0, 8);
      titles.set(status.runId, `${title} · ${digest}`);
    }

    for (const root of [...nowRoots, ...recentRoots]) {
      const status = root.entry.status;
      if (!status) continue;
      const workflow = this.buildWorkflow(
        root,
        titles.get(status.runId) ?? this.titleFor(status),
        now,
      );
      if (!workflow) continue;
      runningCount += workflow.activeCount;
      doneCount += workflow.doneCount;
      workflows.push(workflow);
    }

    this.cachedAt = this.generation;
    this.cachedNow = now;
    this.cachedSnapshot = {
      workflows,
      hiddenWorkflows: hidden,
      runCount: workflows.reduce(
        (sum, workflow) => sum + workflow.children.length,
        0,
      ),
      runningCount,
      doneCount,
      ...(this.error ? { error: this.error } : {}),
      scannedAt: now,
      generation: this.generation,
    };
    return this.cachedSnapshot;
  }

  /**
   * Identity: a single run is its session name (cwd basename next to it), a
   * workflow is `<cwd basename> · <startAt>→<stopAfter>` unless the script
   * published `args.title`.
   */
  private titleFor(status: ParsedStatus): string {
    const cwdName = basename(status.cwd ?? "");
    const fallback = cwdName || status.mode;
    if (status.mode === "single") return status.sessionName ?? fallback;
    if (status.mode === "workflow") {
      if (status.workflowTitle) return status.workflowTitle;
      const range =
        status.startAt || status.stopAfter
          ? ` · ${status.startAt ?? "?"}→${status.stopAfter ?? "?"}`
          : "";
      return `${fallback}${range}`;
    }
    // chain/parallel: the cwd and the mode are the only stable identity there.
    return `${fallback} · ${status.mode}`;
  }

  private buildWorkflow(
    root: { entry: RunEntry; liveness: Liveness },
    title: string,
    now: number,
  ): WorkflowSnapshot | undefined {
    const status = root.entry.status;
    if (!status) return undefined;
    const children = this.childrenFor(root.entry, root.liveness, now);
    if (children.length === 0) return undefined;
    const done = children.filter((child) => isDoneState(child.state)).length;
    const running = children.filter((child) => child.active).length;
    const progress =
      children.reduce((sum, child) => sum + child.progress, 0) /
      children.length;
    // Parallel children run at the same time, so the remaining time is the
    // longest one, not their sum; the same longest expectation is what an
    // overrunning bar calls "typical".
    const etaMs = children.reduce((longest, child) => {
      if (!child.active) return longest;
      const expected = this.expectedMs(child.roleKey);
      return Math.max(longest, Math.max(0, expected - child.elapsedMs));
    }, 0);
    const expectedMs = children.reduce(
      (longest, child) =>
        child.active
          ? Math.max(longest, this.expectedMs(child.roleKey))
          : longest,
      0,
    );
    const startedAt = status.startedAt ?? now;
    const endedAt =
      status.endedAt ??
      (isTerminalState(status.state) ? status.lastUpdate : undefined);
    const finishedAt = finishedAtOf(status);
    const inventoryComplete =
      status.mode === "workflow"
        ? status.workflowChildren?.inventoryComplete === true
        : true;
    const cwdName = basename(status.cwd ?? "");
    const tokens = status.totalTokens?.total ?? sumTokens(children);
    const costUsd = status.costUsd ?? sumCost(children);
    return {
      runId: status.runId,
      shortId: status.runId.slice(0, 8),
      title,
      mode: status.mode,
      state: status.state,
      ...(cwdName ? { cwdName } : {}),
      ...(status.sessionName ? { sessionName: status.sessionName } : {}),
      ...(status.cwd ? { cwd: status.cwd } : {}),
      tint: tintFor(status.runId),
      otherSession:
        this.sessionFile !== undefined && !this.matchesSession(status),
      live: root.liveness.live,
      stale: root.liveness.stale,
      ...(status.error ? { error: status.error } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      startedAt,
      elapsedMs: Math.max(0, (endedAt ?? now) - startedAt),
      ...(finishedAt !== undefined ? { finishedAt } : {}),
      children,
      activeCount: running,
      doneCount: done,
      seenCount: children.length,
      knownTotal: children.length,
      inventoryComplete,
      progress,
      etaMs,
      expectedMs,
    };
  }

  private childrenFor(
    entry: RunEntry,
    rootLiveness: Liveness,
    now: number,
  ): ChildSnapshot[] {
    const status = entry.status;
    if (!status) return [];
    if (status.mode === "workflow") {
      const index = entry.childIndex ?? new Map();
      const order = entry.childOrder ?? [];
      const byRun = new Map<string, { agent: string; state: string }>();
      for (const child of status.workflowChildren?.children ?? []) {
        byRun.set(child.childId, { agent: child.agent, state: child.state });
      }
      const children: ChildSnapshot[] = [];
      for (const key of order) {
        const runId = index.get(key) ?? "";
        const record = byRun.get(key);
        const fallback = record ?? {
          agent: "delegate",
          state: runId ? "unknown" : "queued",
        };
        const childEntry = runId ? this.runs.get(runId) : undefined;
        const childStatus = childEntry?.status;
        let state: string;
        let live = false;
        let stale = false;
        if (!rootLiveness.live) {
          // A child of a concluded workflow is never active: its own
          // status.json can still claim `running` (or `partial`) after the
          // parent has settled it. The parent's workflowChildren record wins.
          state = record?.state ?? childStatus?.state ?? fallback.state;
          stale = isActiveState(state);
          live = false;
        } else if (childStatus) {
          const own = livenessFor(childStatus, this.activeRuns, now);
          state = childStatus.state;
          live = own.live;
          stale = own.stale;
        } else {
          state = fallback.state;
        }
        children.push(
          this.buildChild({
            rootRunId: status.runId,
            key,
            runId,
            agent: childStatus?.steps[0]?.agent ?? fallback.agent,
            state,
            live,
            stale,
            now,
          }),
        );
      }
      return children;
    }

    const steps = status.steps;
    if (steps.length <= 1) {
      return [
        this.buildChild({
          rootRunId: status.runId,
          key: status.runId,
          runId: status.runId,
          agent: steps[0]?.agent ?? "delegate",
          state: status.state,
          live: rootLiveness.live,
          stale: rootLiveness.stale,
          now,
        }),
      ];
    }
    const children: ChildSnapshot[] = [];
    for (const step of steps) {
      // A chain/parallel step is identified by its label when it has one; the run
      // id alone would make every step row share one key.
      const key = step.label ?? `${status.runId}:${step.index}`;
      children.push(
        this.buildChild({
          rootRunId: status.runId,
          key,
          runId: status.runId,
          agent: step.agent,
          state: step.status,
          step,
          // A step is live only while its own run is: the run's pid is the one
          // that would be alive.
          live: rootLiveness.live && isActiveState(step.status),
          stale: !rootLiveness.live && isActiveState(step.status),
          now,
        }),
      );
    }
    return children;
  }
}

function progressFor(
  state: string,
  elapsedMs: number,
  expectedMs: number,
): number {
  // Only a done run is at 100 %. A failed or stopped one is not "complete", and
  // a failed child must not rank up either: it contributes no progress.
  if (isDoneState(state)) return 1;
  if (!isActiveState(state)) return 0;
  const ratio = expectedMs > 0 ? elapsedMs / expectedMs : 0;
  return Math.min(MAX_RUNNING_PROGRESS, Math.max(0, ratio));
}

/** Newest known timestamp of a root, used to order the Recent list. */
function finishedAtOf(status: ParsedStatus | undefined): number {
  if (!status) return 0;
  return (
    status.endedAt ??
    status.lastUpdate ??
    status.lastActivityAt ??
    status.startedAt ??
    0
  );
}

function sumTokens(children: ChildSnapshot[]): number | undefined {
  let total: number | undefined;
  for (const child of children) {
    if (child.tokens === undefined) continue;
    total = (total ?? 0) + child.tokens.total;
  }
  return total;
}

function sumCost(children: ChildSnapshot[]): number | undefined {
  let total: number | undefined;
  for (const child of children) {
    if (child.costUsd === undefined) continue;
    total = (total ?? 0) + child.costUsd;
  }
  return total;
}

function basename(value: string): string {
  if (!value) return "";
  const parts = value.split("/").filter(Boolean);
  return parts.at(-1) ?? "";
}

export function formatModel(
  model: string | undefined,
  thinking: string | undefined,
): { name: string; effort: string } {
  if (!model)
    return { name: thinking ? `default · ${thinking}` : "default", effort: "" };
  const withoutProvider = model.includes("/")
    ? model.slice(model.indexOf("/") + 1)
    : model;
  // Short ids (`cf/clef`) keep their provider: the bare name would say less.
  const base = withoutProvider.length > 4 ? withoutProvider : model;
  const [name, embedded] = base.split(":");
  const effort = embedded ?? thinking ?? "";
  return { name, effort };
}
