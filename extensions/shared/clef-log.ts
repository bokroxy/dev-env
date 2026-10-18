/** Append-only JSONL decision logs (owner-only permissions) and summaries. */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DecisionRecord } from "./clef.ts";

export function agentDir() {
  return (
    process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")
  );
}

/** Session-level log used by the clef extension (tool + /clef). */
export function globalDecisionLog() {
  return path.join(agentDir(), "clef", "decisions.jsonl");
}

export function appendDecision(file: string, record: DecisionRecord) {
  try {
    const fresh = !existsSync(file);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    if (fresh) chmodSync(file, 0o600);
  } catch {
    // Logging must never break a decision.
  }
}

export function readDecisions(file: string, limit = Infinity) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const records: DecisionRecord[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      records.push(JSON.parse(line) as DecisionRecord);
    } catch {
      // Skip a torn line.
    }
  }
  return records;
}

export interface ClassifierUsageSummary {
  calls: number;
  ruleDecided: number;
  escalated: number;
  failed: number;
  costUsd: number;
}

export function emptyClassifierUsage(): ClassifierUsageSummary {
  return { calls: 0, ruleDecided: 0, escalated: 0, failed: 0, costUsd: 0 };
}

export function addToUsage(
  usage: ClassifierUsageSummary,
  outcome: { ok: boolean; source?: string; action?: string; costUsd?: number },
) {
  usage.calls++;
  if (outcome.source === "rule") usage.ruleDecided++;
  if (!outcome.ok) usage.failed++;
  else if (outcome.action === "escalate") usage.escalated++;
  usage.costUsd += outcome.costUsd ?? 0;
}

export function formatUsage(usage: ClassifierUsageSummary) {
  return (
    `${usage.calls} classifier call(s)` +
    (usage.ruleDecided ? `, ${usage.ruleDecided} by rule` : "") +
    (usage.escalated ? `, ${usage.escalated} escalated` : "") +
    (usage.failed ? `, ${usage.failed} failed` : "") +
    `, $${usage.costUsd.toFixed(4)}`
  );
}
