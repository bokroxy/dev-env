/**
 * Job 6: mine historical failures from saved pi-subagents / legacy workflow runs,
 * classify them with Clef and write a report. Collection and fact extraction are
 * deterministic; only `runMine` calls a model.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  addToUsage,
  appendDecision,
  emptyClassifierUsage,
  formatUsage,
} from "./clef-log.ts";
import { CLEF_INPUT_PRICE_PER_MILLION } from "./clef-rest.ts";
import {
  CLEF_MODELS,
  runJudge,
  ruleLabelFor,
  shapeJudgeInput,
  toDecisionRecord,
  type ClefBackend,
  type Judgment,
} from "./clef.ts";

export type MineKind = "blocker" | "error";
export type MineSource =
  "subagent-artifacts" | "async-status" | "legacy-workflow";

export interface MineItem {
  kind: MineKind;
  source: MineSource;
  /** Where the item was found (file path). */
  origin: string;
  /** Epoch ms; used for ordering and `--since`. */
  ts: number;
  label: string;
  /** Normalized primary text used for dedupe. */
  text: string;
  /** Judge input for the preset of `kind`. */
  input: Record<string, unknown>;
  /** Occurrences folded into this item by dedupe. */
  count: number;
}

export interface Facts {
  tests: string[];
  files: string[];
  packages: string[];
}

export interface CollectOptions {
  agentDir: string;
  /** Directory holding `<id>/status.json` of async pi-subagents runs. */
  asyncRunsDir?: string;
  /** Extra project roots; `<root>/.pi/subagents/artifacts` is scanned. */
  roots?: string[];
  /** Epoch ms lower bound. */
  since?: number;
}

const TAIL_BYTES = 6000;
const MAX_TEXT_CHARS = 4000;

export function defaultAsyncRunsDir() {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const configuredRoot = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  const root = configuredRoot
    ? path.resolve(configuredRoot)
    : path.join(os.tmpdir(), `pi-subagents-uid-${uid}`);
  return path.join(root, "async-subagent-runs");
}

// ---------------------------------------------------------------------------
// Deterministic extraction
// ---------------------------------------------------------------------------

export function extractFacts(text: string): Facts {
  const tests = [...new Set(text.match(/\bTest[A-Z][A-Za-z0-9_]*/g) ?? [])];
  const files = [...new Set(text.match(/[\w./-]+\.go:\d+/g) ?? [])];
  const packages = new Set<string>();
  for (const file of files) {
    const dir = path.posix.dirname(file.replace(/:\d+$/, ""));
    if (dir !== ".") packages.add(dir);
  }
  for (const match of text.matchAll(
    /^(?:FAIL|---\s*FAIL:?)\s+(?:ok\s+)?([\w./-]+\/[\w./-]+)/gm,
  )) {
    packages.add(match[1]);
  }
  return { tests, files, packages: [...packages] };
}

export function normalizeForDedupe(text: string) {
  return text
    .toLowerCase()
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      "<id>",
    )
    .replace(/\b[0-9a-f]{7,40}\b/g, "<hex>")
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, "<ts>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function textHash(kind: MineKind, text: string) {
  return createHash("sha1")
    .update(`${kind}:${normalizeForDedupe(text)}`)
    .digest("hex");
}

/** Newest first; identical normalized text folds into the newest item. */
export function dedupeItems(items: MineItem[]) {
  const sorted = [...items].sort((a, b) => b.ts - a.ts);
  const seen = new Map<string, MineItem>();
  for (const item of sorted) {
    const key = textHash(item.kind, item.text);
    const existing = seen.get(key);
    if (existing) existing.count += item.count;
    else seen.set(key, { ...item });
  }
  return [...seen.values()];
}

/** Failing tests ranked by how many raw items mention them. */
export function rankTests(items: MineItem[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const test of extractFacts(item.text).tests)
      counts.set(test, (counts.get(test) ?? 0) + item.count);
  }
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Parsed JSON object, or `{}` when the file is missing, torn or not an object. */
function readJsonObject(file: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return {};
  }
}

function str(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function toMs(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value))
    return value < 1e11 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

function readTail(file: string) {
  try {
    const size = statSync(file).size;
    const length = Math.min(size, TAIL_BYTES);
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function listDir(dir: string) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function mtime(file: string) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function clip(text: string) {
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
}

function blockerItem(
  source: MineSource,
  origin: string,
  ts: number,
  label: string,
  text: string,
  gateLog?: string,
): MineItem {
  const blocker = clip(text);
  const facts = extractFacts(`${blocker}\n${gateLog ?? ""}`);
  return {
    kind: "blocker",
    source,
    origin,
    ts,
    label,
    text: blocker,
    count: 1,
    input: {
      stage: label,
      blocker,
      ...(facts.tests.length ? { failingTests: facts.tests.slice(0, 20) } : {}),
      ...(gateLog ? { gateLog } : {}),
    },
  };
}

function errorItem(
  source: MineSource,
  origin: string,
  ts: number,
  label: string,
  text: string,
  provider?: string,
): MineItem {
  const error = clip(text);
  return {
    kind: "error",
    source,
    origin,
    ts,
    label,
    text: error,
    count: 1,
    input: { error, ...(provider ? { provider } : {}), context: label },
  };
}

function collectSubagentArtifacts(dir: string, items: MineItem[]) {
  for (const name of listDir(dir)) {
    if (!name.endsWith("_meta.json")) continue;
    const file = path.join(dir, name);
    const meta = readJsonObject(file);
    const ts = toMs(meta.timestamp, mtime(file));
    const agent = str(meta.agent) ?? "agent";
    const model = str(meta.model);
    const label = `${agent}:${str(meta.runId)?.slice(0, 8) ?? name.slice(0, 8)}`;

    const acceptance = asRecord(meta.acceptance);
    if (acceptance.status === "rejected") {
      const reasons: string[] = [];
      for (const check of Array.isArray(acceptance.runtimeChecks)
        ? acceptance.runtimeChecks
        : []) {
        const record = asRecord(check);
        if (record.status === "failed" && str(record.message))
          reasons.push(String(record.message));
      }
      for (const run of Array.isArray(acceptance.verifyRuns)
        ? acceptance.verifyRuns
        : []) {
        const record = asRecord(run);
        if (record.status === "failed" && str(record.command))
          reasons.push(`verify command failed: ${String(record.command)}`);
      }
      const parseError = str(acceptance.childReportParseError);
      if (parseError && !reasons.includes(parseError)) reasons.push(parseError);
      const gateLog = readTail(file.replace(/_meta\.json$/, "_output.md"));
      items.push(
        blockerItem(
          "subagent-artifacts",
          file,
          ts,
          label,
          reasons.length ? reasons.join("\n") : "acceptance rejected",
          gateLog,
        ),
      );
    }
    const error = str(meta.error);
    if (error)
      items.push(
        errorItem("subagent-artifacts", file, ts, label, error, model),
      );
  }
}

function collectAsyncStatus(dir: string, items: MineItem[]) {
  for (const id of listDir(dir)) {
    const file = path.join(dir, id, "status.json");
    const status = readJsonObject(file);
    if (!Object.keys(status).length) continue;
    const ts = toMs(status.lastUpdate ?? status.startedAt, mtime(file));
    const label = `async:${id.slice(0, 8)}`;
    const errors: string[] = [];
    const top = str(status.error);
    if (top) errors.push(top);
    for (const step of Array.isArray(status.steps) ? status.steps : []) {
      const record = asRecord(step);
      const message = str(record.error);
      if (message) errors.push(message);
    }
    for (const message of new Set(errors))
      items.push(errorItem("async-status", file, ts, label, message));
  }
}

function collectLegacyWorkflows(dir: string, items: MineItem[]) {
  for (const id of listDir(dir)) {
    if (!id.startsWith("wf_")) continue;
    const base = path.join(dir, id);
    const workflowFile = path.join(base, "workflow.json");
    const workflow = readJsonObject(workflowFile);
    const ts = toMs(workflow.startedAt, mtime(workflowFile) || mtime(base));
    const name = str(workflow.name) ?? id;
    const label = `${id}:${name}`;

    const resultFile = path.join(base, "result.json");
    const result = readJsonObject(resultFile);
    for (const entry of Array.isArray(result.results) ? result.results : []) {
      const record = asRecord(entry);
      if (!record.stopped && !record.blockers) continue;
      const stage = `${str(record.id) ?? "stage"}@${label}`;
      const blockers = Array.isArray(record.blockers)
        ? record.blockers.filter(str)
        : [];
      const texts = blockers.length ? blockers : [str(record.why)].filter(str);
      for (const text of texts)
        items.push(
          blockerItem("legacy-workflow", resultFile, ts, stage, String(text)),
        );
    }
    for (const trail of Array.isArray(result.providerTrail)
      ? result.providerTrail
      : []) {
      const record = asRecord(trail);
      const message = str(record.error);
      if (record.ok === false && message)
        items.push(
          errorItem(
            "legacy-workflow",
            resultFile,
            ts,
            label,
            message,
            str(record.provider),
          ),
        );
    }

    const status = str(workflow.status);
    const workflowError = str(workflow.error);
    if (workflowError && status !== "aborted")
      items.push(
        errorItem("legacy-workflow", workflowFile, ts, label, workflowError),
      );
    for (const agent of Array.isArray(workflow.agents) ? workflow.agents : []) {
      const record = asRecord(agent);
      const message = str(record.error);
      // "Workflow stopped" is the user/controller stopping a worker, not a failure to triage.
      if (message && message !== "Workflow stopped")
        items.push(
          errorItem(
            "legacy-workflow",
            workflowFile,
            ts,
            `${label}/${str(record.label) ?? "agent"}`,
            message,
            str(record.model),
          ),
        );
    }
  }
}

/** All failure items from the known sources, newest first, not yet deduped. */
export function collectItems(options: CollectOptions) {
  const items: MineItem[] = [];
  const sessions = path.join(options.agentDir, "sessions");
  for (const slug of listDir(sessions))
    collectSubagentArtifacts(
      path.join(sessions, slug, "subagent-artifacts"),
      items,
    );
  for (const root of options.roots ?? [])
    collectSubagentArtifacts(
      path.join(root, ".pi", "subagents", "artifacts"),
      items,
    );
  collectAsyncStatus(options.asyncRunsDir ?? defaultAsyncRunsDir(), items);
  collectLegacyWorkflows(path.join(options.agentDir, "workflows"), items);
  const since = options.since ?? 0;
  return items.filter((item) => item.ts >= since).sort((a, b) => b.ts - a.ts);
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

const PROMPT_OVERHEAD_CHARS = 1200;

export interface DryRunSummary {
  rawItems: number;
  uniqueItems: number;
  selected: number;
  bySourceKind: Record<string, number>;
  ruleDecided: number;
  classifierCalls: number;
  estimatedTokens: number;
  costUsd: Record<"clef" | "flash", number>;
  samples: {
    kind: MineKind;
    source: MineSource;
    label: string;
    text: string;
  }[];
  topTests: [string, number][];
}

export function summarizeDryRun(
  raw: MineItem[],
  unique: MineItem[],
  selected: MineItem[],
): DryRunSummary {
  const bySourceKind: Record<string, number> = {};
  for (const item of selected) {
    const key = `${item.source}/${item.kind}`;
    bySourceKind[key] = (bySourceKind[key] ?? 0) + 1;
  }
  let ruleDecided = 0;
  let chars = 0;
  for (const item of selected) {
    if (ruleLabelFor(item.kind, item.input)) {
      ruleDecided++;
      continue;
    }
    const { state } = shapeJudgeInput(item.kind, item.input);
    chars += JSON.stringify(state).length + PROMPT_OVERHEAD_CHARS;
  }
  const estimatedTokens = Math.ceil(chars / 4);
  const price = (id: string) =>
    (estimatedTokens * (CLEF_INPUT_PRICE_PER_MILLION[id] ?? 0)) / 1_000_000;
  return {
    rawItems: raw.length,
    uniqueItems: unique.length,
    selected: selected.length,
    bySourceKind,
    ruleDecided,
    classifierCalls: selected.length - ruleDecided,
    estimatedTokens,
    costUsd: { clef: price(CLEF_MODELS.clef), flash: price(CLEF_MODELS.flash) },
    samples: selected.slice(0, 5).map((item) => ({
      kind: item.kind,
      source: item.source,
      label: item.label,
      text: item.text.replace(/\s+/g, " ").slice(0, 160),
    })),
    topTests: rankTests(raw).slice(0, 5),
  };
}

export function formatDryRun(summary: DryRunSummary) {
  const lines = [
    `clef mine --dry: ${summary.rawItems} raw item(s), ${summary.uniqueItems} unique, ${summary.selected} selected`,
    ...Object.entries(summary.bySourceKind).map(([key, n]) => `  ${key}: ${n}`),
    `rules decide ${summary.ruleDecided}; classifier calls ${summary.classifierCalls} (~${summary.estimatedTokens} input tokens)`,
    `estimated cost: clef $${summary.costUsd.clef.toFixed(4)} · clef-flash $${summary.costUsd.flash.toFixed(4)} (kind defaults: blocker→clef, error→flash)`,
  ];
  if (summary.topTests.length)
    lines.push(
      "recurring tests:",
      ...summary.topTests.map(([name, n]) => `  ${n}× ${name}`),
    );
  if (summary.samples.length)
    lines.push(
      "samples:",
      ...summary.samples.map(
        (sample) => `  [${sample.kind}] ${sample.label}: ${sample.text}`,
      ),
    );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Full run
// ---------------------------------------------------------------------------

export interface MineRunOptions extends CollectOptions {
  limit?: number;
  /** Report path; the `.jsonl` sibling is derived from it. Default: `<agent dir>/clef/reports/mine-<ISO>.md`. */
  out?: string;
  /** Decision log to append to; omit to skip logging. */
  logFile?: string;
  signal?: AbortSignal;
}

export interface MineResult {
  reportPath: string;
  jsonlPath: string;
  summary: string;
  classified: number;
}

export function selectItems(options: CollectOptions & { limit?: number }) {
  const raw = collectItems(options);
  const unique = dedupeItems(raw);
  return { raw, unique, selected: unique.slice(0, options.limit ?? 40) };
}

function fence(text: string) {
  return text.replace(/\s+/g, " ").slice(0, 200);
}

export async function runMine(
  backend: ClefBackend,
  options: MineRunOptions,
): Promise<MineResult> {
  const { raw, unique, selected } = selectItems(options);
  const judged = await Promise.all(
    selected.map(async (item) => {
      const { judgment, state } = await runJudge(
        backend,
        item.kind,
        item.input,
        { signal: options.signal },
      );
      if (options.logFile)
        appendDecision(
          options.logFile,
          toDecisionRecord(judgment, state, {
            caller: "mine",
            origin: item.origin,
            label: item.label,
          }),
        );
      return { item, judgment };
    }),
  );

  const usage = emptyClassifierUsage();
  const byLabel = new Map<string, number>();
  const escalations: { item: MineItem; judgment: Judgment }[] = [];
  for (const { item, judgment } of judged) {
    addToUsage(usage, judgment);
    const key = `${item.kind} → ${judgment.ok ? judgment.label : "classification failed"}`;
    byLabel.set(key, (byLabel.get(key) ?? 0) + 1);
    if (judgment.action === "escalate") escalations.push({ item, judgment });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath =
    options.out ??
    path.join(options.agentDir, "clef", "reports", `mine-${stamp}.md`);
  const jsonlPath = reportPath.replace(/\.md$/, "") + ".jsonl";
  mkdirSync(path.dirname(reportPath), { recursive: true, mode: 0o700 });

  const md: string[] = [
    `# Clef mine report (${new Date().toISOString()})`,
    "",
    `${raw.length} raw item(s), ${unique.length} unique, ${selected.length} classified. ${formatUsage(usage)}.`,
    "",
    "A classification routes work; it never approves anything. Escalated items need a human.",
    "",
    "## Summary by kind and label",
    "",
    ...[...byLabel.entries()].sort().map(([key, n]) => `- ${key}: ${n}`),
    "",
    "## Recurring failing tests",
    "",
    ...rankTests(raw)
      .slice(0, 15)
      .map(([name, n]) => `- ${n}× ${name}`),
    "",
    "## Escalations",
    "",
    ...(escalations.length
      ? escalations.map(
          ({ item, judgment }) =>
            `- [${item.kind}] ${item.label} (${judgment.ok ? `${judgment.label} p=${judgment.p?.toFixed(2)}` : `failed: ${judgment.error}`}): ${fence(item.text)}`,
        )
      : ["- none"]),
    "",
    "## Cost",
    "",
    `${formatUsage(usage)}`,
    "",
  ];
  writeFileSync(reportPath, md.join("\n"), { mode: 0o600 });
  writeFileSync(
    jsonlPath,
    judged
      .map(({ item, judgment }) =>
        JSON.stringify({
          kind: item.kind,
          source: item.source,
          origin: item.origin,
          label: item.label,
          count: item.count,
          ts: new Date(item.ts).toISOString(),
          text: fence(item.text),
          judgment,
        }),
      )
      .join("\n") + (judged.length ? "\n" : ""),
    { mode: 0o600 },
  );

  const summary = [
    `mined ${selected.length} of ${unique.length} unique failure(s) (${raw.length} raw)`,
    ...[...byLabel.entries()].sort().map(([key, n]) => `  ${key}: ${n}`),
    `${escalations.length} escalated · ${formatUsage(usage)}`,
  ].join("\n");
  return { reportPath, jsonlPath, summary, classified: selected.length };
}

export function sinceToMs(value: string) {
  const ms = Date.parse(
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value,
  );
  if (Number.isNaN(ms))
    throw new Error(`--since expects YYYY-MM-DD, got "${value}"`);
  return ms;
}

export function hasArtifacts(agentDir: string) {
  return (
    existsSync(path.join(agentDir, "sessions")) ||
    existsSync(path.join(agentDir, "workflows"))
  );
}
