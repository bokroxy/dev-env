import type { ThemeColor } from "@earendil-works/pi-coding-agent";

/** Context categories, in bar order. Colors are theme tokens so the bar follows the active theme. */
export const CATEGORIES = [
  { key: "system", label: "System prompt", color: "syntaxKeyword" },
  { key: "contextFiles", label: "Context files", color: "syntaxVariable" },
  { key: "skills", label: "Skills", color: "warning" },
  { key: "tools", label: "Tools", color: "accent" },
  { key: "mcp", label: "MCP tools", color: "syntaxFunction" },
  { key: "messages", label: "Messages", color: "success" },
] as const satisfies readonly {
  key: string;
  label: string;
  color: ThemeColor;
}[];

export type CategoryKey = (typeof CATEGORIES)[number]["key"];

export type Breakdown = Record<CategoryKey, number> & {
  /** Model context window in tokens. */
  window: number;
  /** Tokens reserved before auto-compaction triggers (0 when compaction is off). */
  buffer: number;
  /** True when message tokens are a chars/4 estimate rather than provider-reported usage. */
  estimated: boolean;
};

/** Same chars/4 heuristic pi uses for its own token estimates. */
export function estimateTextTokens(text: string) {
  return Math.ceil(text.length / 4);
}

function sectionLength(prompt: string, tag: string, from = 0) {
  const open = `<${tag}>\n`;
  const close = `\n</${tag}>`;
  const start = prompt.indexOf(open, from);
  if (start === -1) return { length: 0, end: from };
  const stop = prompt.indexOf(close, start + open.length);
  if (stop === -1) return { length: 0, end: from };
  const end = stop + close.length;
  return { length: end - start, end };
}

/**
 * Split pi's rendered system prompt into the base prompt, the project context files
 * (AGENTS.md and friends, rendered as `<project_context>`) and the skills listing
 * (`<skills>`, which pi renders after project context).
 */
export function splitSystemPrompt(prompt: string) {
  const context = sectionLength(prompt, "project_context");
  const skills = sectionLength(prompt, "skills", context.end);
  const rest = Math.max(0, prompt.length - context.length - skills.length);
  return {
    system: Math.ceil(rest / 4),
    contextFiles: Math.ceil(context.length / 4),
    skills: Math.ceil(skills.length / 4),
  };
}

/**
 * Distribute `width` columns across `values` proportionally (largest remainder),
 * guaranteeing at least one column to every non-zero value while space allows.
 */
export function allocateColumns(values: readonly number[], width: number) {
  const cols = values.map(() => 0);
  const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
  if (total <= 0 || width <= 0) return cols;

  const exact = values.map((v) => (Math.max(0, v) / total) * width);
  exact.forEach((x, i) => (cols[i] = Math.floor(x)));
  let rest = width - cols.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((x, i) => ({ i, r: x - Math.floor(x) }))
    .sort((a, b) => b.r - a.r);
  for (const { i } of byRemainder) {
    if (rest <= 0) break;
    cols[i]++;
    rest--;
  }

  for (let i = 0; i < values.length; i++) {
    if (values[i] <= 0 || cols[i] > 0) continue;
    const donor = cols.indexOf(Math.max(...cols));
    if (cols[donor] <= 1) break;
    cols[donor]--;
    cols[i]++;
  }
  return cols;
}

export function usedTokens(b: Breakdown) {
  return CATEGORIES.reduce((sum, c) => sum + b[c.key], 0);
}
