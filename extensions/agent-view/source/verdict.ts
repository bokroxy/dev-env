/**
 * Clef verdict extraction. A clef child writes one JSON object per run
 * (`output-0.log`), e.g.
 * `{"ok":true,"kind":"blocker","label":"stage_regression","p":0.8924,
 *   "confident":false,"action":"escalate","probabilities":{...}}`.
 * We scan for the last parseable object that carries a label and a probability,
 * so prose around the JSON (or several verdicts in one file) still works.
 */

import { VERDICT_GATE } from "../anim/scripts.ts";
import type { Verdict } from "./types.ts";

const MAX_OBJECT_CHARS = 8192;
const MAX_ATTEMPTS = 400;

function matchBraceEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  const limit = Math.min(text.length, start + MAX_OBJECT_CHARS);
  for (let index = start; index < limit; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function toVerdict(value: unknown): Verdict | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  let label = typeof record.label === "string" ? record.label : undefined;
  let p = typeof record.p === "number" ? record.p : undefined;

  const probabilities = asRecord(record.probabilities);
  if (label === undefined || p === undefined) {
    if (probabilities) {
      let bestLabel: string | undefined;
      let bestP: number | undefined;
      for (const [key, raw] of Object.entries(probabilities)) {
        if (typeof raw !== "number") continue;
        if (bestP === undefined || raw > bestP) {
          bestP = raw;
          bestLabel = key;
        }
      }
      label ??= bestLabel;
      p ??= bestP;
    }
  }
  if (label === undefined || p === undefined || !Number.isFinite(p))
    return undefined;

  const probabilitiesOut: Record<string, number> = {};
  for (const [key, raw] of Object.entries(probabilities ?? {})) {
    if (typeof raw === "number" && Number.isFinite(raw))
      probabilitiesOut[key] = raw;
  }

  return {
    label,
    p: Math.min(1, Math.max(0, p)),
    ...(typeof record.action === "string" ? { action: record.action } : {}),
    ...(typeof record.kind === "string" ? { kind: record.kind } : {}),
    // The gate is what the bubble colour is keyed on, so `confident` follows p
    // alone: a classifier's own `confident: true` must not colour a p < 0.9
    // verdict green.
    confident: Math.min(1, Math.max(0, p)) >= VERDICT_GATE,
    ...(Object.keys(probabilitiesOut).length > 0
      ? { probabilities: probabilitiesOut }
      : {}),
  };
}

/** Last parseable verdict object in `text`, or undefined. */
export function parseVerdict(text: string): Verdict | undefined {
  let attempts = 0;
  for (
    let index = text.length - 1;
    index >= 0 && attempts < MAX_ATTEMPTS;
    index -= 1
  ) {
    if (text[index] !== "{") continue;
    attempts += 1;
    const end = matchBraceEnd(text, index);
    if (end < 0) continue;
    const candidate = text.slice(index, end + 1);
    if (
      !candidate.includes('"label"') &&
      !candidate.includes('"probabilities"')
    )
      continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const verdict = toVerdict(parsed);
    if (verdict) return verdict;
  }
  return undefined;
}

/** Where a clef run keeps its verdict text. */
export function clefOutputPaths(
  runDir: string,
  runId: string,
  stepIndex = 0,
): string[] {
  const paths = [`${runDir}/output-${stepIndex}.log`, `${runDir}/output-0.log`];
  paths.push(`${runDir}/subagent-log-${runId}.md`);
  return [...new Set(paths)];
}
