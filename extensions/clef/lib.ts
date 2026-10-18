/** Logic shared by the `clef` CLI and the pi extension. No pi runtime imports. */

import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { readDecisions } from "../shared/clef-log.ts";
import {
  CLEF_INPUT_PRICE_PER_MILLION,
  CLEF_SETUP_HINT,
  maskAccountId,
  resolveCredentials,
  type CredentialOptions,
} from "../shared/clef-rest.ts";
import {
  CLEF_MODELS,
  runRawClassify,
  type ClefBackend,
  type DecisionRecord,
} from "../shared/clef.ts";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  positional: string[];
  /** Value flags, repeatable. */
  values: Map<string, string[]>;
  /** Boolean flags that were present. */
  switches: Set<string>;
}

/**
 * `--name value`, `--name=value`, `-n value`. Names in `switches` take no value;
 * every other flag consumes the next argument.
 */
export function parseArgs(
  argv: string[],
  switches: readonly string[],
  shortAliases: Record<string, string> = {},
) {
  const parsed: ParsedArgs = {
    positional: [],
    values: new Map(),
    switches: new Set(),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let name: string | undefined;
    let inline: string | undefined;
    if (arg.startsWith("--") && arg.length > 2) {
      const eq = arg.indexOf("=");
      name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
      inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    } else if (/^-[a-zA-Z]$/.test(arg) && shortAliases[arg.slice(1)]) {
      name = shortAliases[arg.slice(1)];
    }
    if (name === undefined) {
      parsed.positional.push(arg);
      continue;
    }
    if (switches.includes(name)) {
      parsed.switches.add(name);
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    const list = parsed.values.get(name) ?? [];
    list.push(value);
    parsed.values.set(name, list);
  }
  return parsed;
}

export function lastValue(parsed: ParsedArgs, name: string) {
  return parsed.values.get(name)?.at(-1);
}

export function kebabToCamel(name: string) {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

export interface InputSources {
  cwd: string;
  readStdin: () => Promise<string>;
}

/** `@file` reads a file relative to cwd, `@-` reads stdin, `@@x` is the literal `@x`. */
export async function resolveValue(raw: string, sources: InputSources) {
  if (raw.startsWith("@@")) return raw.slice(1);
  if (!raw.startsWith("@")) return raw;
  if (raw === "@-") return sources.readStdin();
  const file = path.resolve(sources.cwd, raw.slice(1));
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(`cannot read ${raw} (${code ?? "error"}: ${file})`);
  }
}

/** Parse a JSON object from a `<json|@file|@->` value. */
export async function resolveJsonObject(
  raw: string,
  label: string,
  sources: InputSources,
) {
  const text = await resolveValue(raw, sources);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

/** stdin is a pipe or file, never a TTY prompt we would hang on. */
export async function readProcessStdin() {
  if (process.stdin.isTTY)
    throw new Error("expected input on stdin but stdin is a terminal");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

// ---------------------------------------------------------------------------
// status / test / log
// ---------------------------------------------------------------------------

export interface StatusOptions {
  agentDir: string;
  logFile: string;
  credentials?: CredentialOptions;
  env?: NodeJS.ProcessEnv;
}

function onPath(command: string, env: NodeJS.ProcessEnv) {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** Local state only: no network, never the key. */
export function collectStatus(options: StatusOptions) {
  const env = options.env ?? process.env;
  const credentials = resolveCredentials({
    env,
    authFile: path.join(options.agentDir, "auth.json"),
    ...options.credentials,
  });
  const decisions = readDecisions(options.logFile);
  return {
    credentials: credentials.ok
      ? {
          source: credentials.source,
          accountId: maskAccountId(credentials.accountId),
        }
      : {
          source: credentials.placeholder ? "placeholder" : "missing",
          missing: credentials.missing,
          hint: credentials.hint,
        },
    models: Object.entries(CLEF_MODELS).map(([alias, id]) => ({
      alias,
      id,
      inputUsdPerMillionTokens: CLEF_INPUT_PRICE_PER_MILLION[id],
    })),
    decisionLog: { path: options.logFile, count: decisions.length },
    agentFile: path.join(options.agentDir, "agents", "clef.md"),
    agentInstalled: existsSync(
      path.join(options.agentDir, "agents", "clef.md"),
    ),
    skillFile: path.join(options.agentDir, "skills", "clef", "SKILL.md"),
    skillInstalled: existsSync(
      path.join(options.agentDir, "skills", "clef", "SKILL.md"),
    ),
    launcher: onPath("clef", env) ?? null,
  };
}

export type ClefStatus = ReturnType<typeof collectStatus>;

export function formatStatus(status: ClefStatus) {
  const creds = status.credentials;
  const lines = [
    "credentials: " +
      (creds.source === "missing" || creds.source === "placeholder"
        ? `${creds.source === "placeholder" ? "PLACEHOLDER" : "MISSING"} (${creds.missing?.join(", ")}) — ${creds.hint}`
        : `${creds.source}, account ${creds.accountId}`),
    "models:",
    ...status.models.map(
      (model) =>
        `  ${model.alias.padEnd(5)} ${model.id} $${model.inputUsdPerMillionTokens}/1M input tokens (output free)`,
    ),
    `decision log: ${status.decisionLog.path} (${status.decisionLog.count} decision(s))`,
    `agent: ${status.agentInstalled ? "installed" : "NOT installed"} (${status.agentFile})`,
    `skill: ${status.skillInstalled ? "installed" : "NOT installed"} (${status.skillFile})`,
    `launcher: ${status.launcher ?? "not on PATH (expected ~/.local/bin/clef)"}`,
  ];
  return lines.join("\n");
}

export const SETUP_TEXT = [
  "Clef needs Cloudflare Workers AI credentials.",
  "1. In pi run /login and choose Cloudflare Workers AI; enter an API token with the Workers AI permission and your account id.",
  "   (stored in ~/.pi/agent/auth.json). Or export CLOUDFLARE_API_KEY and CLOUDFLARE_ACCOUNT_ID.",
  "2. Check with `clef status`, then make one tiny live call with `clef test`.",
  "",
  CLEF_SETUP_HINT,
].join("\n");

export interface TestOutcome {
  ok: boolean;
  text: string;
}

/** One tiny live call. Callers decide whether to run it (it costs a fraction of a cent). */
export async function runTestCall(
  backend: ClefBackend,
  model?: string,
): Promise<TestOutcome> {
  const result = await runRawClassify(
    backend,
    { text: "The build finished. All 42 tests passed with exit code 0." },
    {
      decision: {
        type: "choice",
        instructions: "Did the build succeed?",
        criteria: {
          success: "The build or tests succeeded",
          failure: "The build or tests failed",
        },
      },
    },
    { model },
  );
  const answer = result.answers?.decision;
  if (!result.ok || !answer || answer.type !== "choice")
    return {
      ok: false,
      text: `clef test failed: ${result.error ?? "no choice answer"}`,
    };
  const p = answer.probabilities[answer.choice] ?? 0;
  const cost =
    result.costUsd === undefined ? "n/a" : `$${result.costUsd.toFixed(6)}`;
  return {
    ok: answer.choice === "success",
    text:
      `clef test: ${answer.choice} (p=${p.toFixed(3)}) model=${result.model} ${result.ms}ms cost=${cost}` +
      (answer.choice === "success"
        ? ""
        : "\nunexpected label for a trivially successful build; check the model."),
  };
}

export function formatDecision(record: DecisionRecord) {
  const p = record.p === undefined ? "" : ` p=${record.p.toFixed(2)}`;
  const cost =
    record.costUsd === undefined ? "" : ` $${record.costUsd.toFixed(5)}`;
  const outcome = record.ok
    ? `${record.label}${p}`
    : `ERROR ${record.error ?? ""}`;
  const via = record.source === "rule" ? `rule:${record.rule}` : record.model;
  const caller =
    typeof record.context?.caller === "string"
      ? ` [${record.context.caller}]`
      : "";
  return `${record.ts} ${record.kind} → ${outcome} (${via}) ⇒ ${record.action}${cost}${caller}`;
}

export function selectDecisions(logFile: string, count: number, kind?: string) {
  const all = readDecisions(logFile).filter(
    (record) => !kind || record.kind === kind,
  );
  return all.slice(-count);
}
