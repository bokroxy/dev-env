/**
 * `clef` command line: judge | gate | agent | classify | status | test | log | mine | help.
 * Must not import pi runtime packages (it runs standalone under plain Node).
 */

import { realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentDir as defaultAgentDir,
  appendDecision,
} from "../shared/clef-log.ts";
import {
  formatDryRun,
  runMine,
  selectItems,
  sinceToMs,
  summarizeDryRun,
} from "../shared/clef-mine.ts";
import { createRestBackend, resolveCredentials } from "../shared/clef-rest.ts";
import {
  DEFAULT_THRESHOLD,
  JUDGE_KINDS,
  PRESETS,
  formatJudgment,
  runJudge,
  runRawClassify,
  toDecisionRecord,
  type ClefBackend,
  type JudgeKind,
  type Judgment,
} from "../shared/clef.ts";
import { helpText } from "./help.ts";
import {
  collectStatus,
  formatDecision,
  formatStatus,
  kebabToCamel,
  lastValue,
  parseArgs,
  readProcessStdin,
  resolveJsonObject,
  resolveValue,
  runTestCall,
  selectDecisions,
  type InputSources,
} from "./lib.ts";

export interface CliDeps {
  backend?: ClefBackend;
  readStdin?: () => Promise<string>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Defaults to PI_CODING_AGENT_DIR or ~/.pi/agent. */
  agentDir?: string;
  /** Defaults to `<agentDir>/clef/decisions.jsonl`. */
  logFile?: string;
  /** Where async pi-subagents runs live (tests). */
  asyncRunsDir?: string;
}

type Caller = "cli" | "gate" | "agent" | "tool" | "mine";

const EXIT_OK = 0;
const EXIT_FAILURE = 2;
const EXIT_MATCHED = 3;

const JUDGE_SWITCHES = [
  "no-rules",
  "fail-unless-confident",
  "no-log",
  "pretty",
] as const;
const JUDGE_OPTION_NAMES = new Set([
  "input",
  "model",
  "threshold",
  "fail-on",
  ...JUDGE_SWITCHES,
]);

function isJudgeKind(value: string): value is JudgeKind {
  return (JUDGE_KINDS as readonly string[]).includes(value);
}

function failedJudgment(kind: string, error: string): Judgment {
  return {
    ok: false,
    kind: isJudgeKind(kind) ? kind : "raw",
    confident: false,
    action: "escalate",
    model: "none",
    source: "classifier",
    ms: 0,
    error,
  };
}

interface Context {
  deps: CliDeps;
  env: NodeJS.ProcessEnv;
  cwd: string;
  agentDir: string;
  logFile: string;
  sources: InputSources;
  out: (text: string) => void;
  err: (text: string) => void;
  backend: () => ClefBackend;
}

function createContext(deps: CliDeps): Context {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const agentDir = deps.agentDir ?? defaultAgentDir();
  const rawStdin = deps.readStdin ?? readProcessStdin;
  // stdin can only be consumed once; later `@-` reads see the same text.
  let stdinText: Promise<string> | undefined;
  const readStdin = () => (stdinText ??= rawStdin());
  let backend: ClefBackend | undefined;
  return {
    deps,
    env,
    cwd,
    agentDir,
    logFile: deps.logFile ?? path.join(agentDir, "clef", "decisions.jsonl"),
    sources: { cwd, readStdin },
    out: deps.stdout ?? ((text) => process.stdout.write(text)),
    err: deps.stderr ?? ((text) => process.stderr.write(text)),
    backend: () => (backend ??= deps.backend ?? createRestBackend()),
  };
}

function logEnabled(ctx: Context, noLog: boolean) {
  return !noLog && ctx.env.CLEF_LOG !== "0";
}

function print(ctx: Context, value: unknown, pretty = false) {
  ctx.out(`${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`);
}

function warn(ctx: Context, judgment: Judgment) {
  if (!judgment.ok) ctx.err(`clef: ${judgment.error}\n`);
  else if (!judgment.confident) ctx.err(`clef: ${formatJudgment(judgment)}\n`);
}

function parseThreshold(raw: string | undefined) {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new Error(`--threshold must be between 0 and 1, got "${raw}"`);
  return value;
}

interface JudgeRequest {
  kind: string;
  input: Record<string, unknown>;
  model?: string;
  threshold?: number;
  noRules: boolean;
}

/** Runs one judgment, logs it, and returns the judgment (never throws). */
async function execute(
  ctx: Context,
  request: JudgeRequest,
  caller: Caller,
  noLog: boolean,
) {
  if (!isJudgeKind(request.kind))
    return failedJudgment(
      request.kind,
      `unknown judge kind "${request.kind}" (use ${JUDGE_KINDS.join("|")})`,
    );
  const { judgment, state } = await runJudge(
    ctx.backend(),
    request.kind,
    request.input,
    {
      model: request.model,
      threshold: request.threshold,
      noRules: request.noRules,
    },
  );
  if (logEnabled(ctx, noLog))
    appendDecision(
      ctx.logFile,
      toDecisionRecord(judgment, state, { caller, cwd: ctx.cwd }),
    );
  return judgment;
}

// ---------------------------------------------------------------------------
// judge / gate
// ---------------------------------------------------------------------------

async function commandJudge(
  ctx: Context,
  argv: string[],
  caller: "cli" | "gate",
) {
  let parsed;
  try {
    parsed = parseArgs(argv, JUDGE_SWITCHES);
  } catch (error) {
    return fail(ctx, "raw", error);
  }
  const kind = parsed.positional[0];
  if (!kind || !isJudgeKind(kind))
    return fail(
      ctx,
      "raw",
      new Error(`judge needs a kind: ${JUDGE_KINDS.join("|")}`),
    );
  const pretty = parsed.switches.has("pretty");
  try {
    const accepted = new Set(PRESETS[kind].fields.map((field) => field.key));
    const input: Record<string, unknown> = {};
    const inputArg = lastValue(parsed, "input");
    if (inputArg !== undefined)
      Object.assign(
        input,
        await resolveJsonObject(inputArg, "--input", ctx.sources),
      );
    for (const [name, values] of parsed.values) {
      if (JUDGE_OPTION_NAMES.has(name)) continue;
      const key = accepted.has(name) ? name : kebabToCamel(name);
      if (!accepted.has(key))
        throw new Error(
          `unknown --${name} for ${kind}; accepted: ${[...accepted].map((k) => `--${k}`).join(" ")}`,
        );
      input[key] = await resolveValue(values.at(-1) ?? "", ctx.sources);
    }
    const judgment = await execute(
      ctx,
      {
        kind,
        input,
        model: lastValue(parsed, "model"),
        threshold: parseThreshold(lastValue(parsed, "threshold")),
        noRules: parsed.switches.has("no-rules"),
      },
      caller,
      parsed.switches.has("no-log"),
    );
    print(ctx, judgment, pretty);
    warn(ctx, judgment);
    if (!judgment.ok) return EXIT_FAILURE;
    const failOn = (lastValue(parsed, "fail-on") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (
      failOn.length &&
      (failOn.includes(judgment.label ?? "") ||
        failOn.includes(judgment.action))
    )
      return EXIT_MATCHED;
    if (parsed.switches.has("fail-unless-confident") && !judgment.confident)
      return EXIT_MATCHED;
    return EXIT_OK;
  } catch (error) {
    return fail(ctx, kind, error, pretty);
  }
}

/** Prints an ok:false JSON judgment plus a stderr hint and returns exit 2. */
function fail(ctx: Context, kind: string, error: unknown, pretty = false) {
  const message = error instanceof Error ? error.message : String(error);
  print(ctx, failedJudgment(kind, message), pretty);
  ctx.err(`clef: ${message}\n`);
  return EXIT_FAILURE;
}

// ---------------------------------------------------------------------------
// agent (pi-subagents command runner)
// ---------------------------------------------------------------------------

const TASK_MARKER = "\n<Task>\n";
/** pi-subagents appends this block after the task text (default acceptance level "attested"). */
const APPENDED_CONTRACT = /\n\n## Acceptance Contract\b[\s\S]*$/;

export function extractRunnerTask(prompt: string) {
  const at = prompt.lastIndexOf(TASK_MARKER);
  const bare = "<Task>\n";
  const task =
    at >= 0
      ? prompt.slice(at + TASK_MARKER.length)
      : prompt.startsWith(bare)
        ? prompt.slice(bare.length)
        : prompt;
  return task.replace(APPENDED_CONTRACT, "").trim();
}

/** First balanced top-level JSON object in `text`; tolerates text a runner appends after it. */
export function firstJsonObject(text: string) {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        const value: unknown = JSON.parse(text.slice(start, i + 1));
        return typeof value === "object" &&
          value !== null &&
          !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

async function commandAgent(ctx: Context, argv: string[]) {
  let kindFlag: string | undefined;
  try {
    kindFlag = lastValue(parseArgs(argv, []), "kind");
  } catch (error) {
    return fail(ctx, "raw", error);
  }
  let task: string;
  try {
    task = extractRunnerTask(await ctx.sources.readStdin());
  } catch (error) {
    return fail(ctx, kindFlag ?? "raw", error);
  }

  let body: Record<string, unknown> | undefined;
  try {
    const value: unknown = JSON.parse(task);
    if (typeof value === "object" && value !== null && !Array.isArray(value))
      body = value as Record<string, unknown>;
  } catch {
    // Text after the JSON (a runner-appended section) breaks a whole-string parse.
    body = task.startsWith("{") ? firstJsonObject(task) : undefined;
  }

  let kind = typeof body?.kind === "string" ? body.kind : kindFlag;
  let input: Record<string, unknown>;
  if (
    body &&
    typeof body.input === "object" &&
    body.input !== null &&
    !Array.isArray(body.input)
  ) {
    input = body.input as Record<string, unknown>;
  } else if (body && kind && kind !== "raw" && body.kind === undefined) {
    input = body; // a bare input object with --kind
  } else if (!body && kindFlag && isJudgeKind(kindFlag)) {
    const first = PRESETS[kindFlag].fields.find((field) => field.required);
    if (!first)
      return fail(
        ctx,
        kindFlag,
        new Error(`kind ${kindFlag} has no required field`),
      );
    input = { [first.key]: task };
    kind = kindFlag;
  } else if (kind === "raw") {
    input = {};
  } else {
    return fail(
      ctx,
      kind ?? "raw",
      new Error(
        "task is not a JSON object with a kind (and no --kind to map plain text to)",
      ),
    );
  }
  if (!kind) return fail(ctx, "raw", new Error('task JSON has no "kind"'));

  const options =
    typeof body?.options === "object" && body.options !== null
      ? (body.options as Record<string, unknown>)
      : {};
  const model = typeof options.model === "string" ? options.model : undefined;

  if (kind === "raw") {
    const state = body?.state;
    const questions = body?.questions;
    if (
      typeof state !== "object" ||
      state === null ||
      typeof questions !== "object" ||
      questions === null
    )
      return fail(
        ctx,
        "raw",
        new Error(
          'raw tasks need {"kind":"raw","state":{...},"questions":{...}}',
        ),
      );
    const result = await runRawClassify(
      ctx.backend(),
      state as Record<string, unknown>,
      questions as Parameters<typeof runRawClassify>[2],
      { model },
    );
    print(ctx, { kind: "raw", ...result });
    if (!result.ok) ctx.err(`clef: ${result.error}\n`);
    return EXIT_OK;
  }

  const judgment = await execute(
    ctx,
    {
      kind,
      input,
      model,
      threshold:
        typeof options.threshold === "number" ? options.threshold : undefined,
      noRules: options.noRules === true,
    },
    "agent",
    false,
  );
  print(ctx, judgment);
  warn(ctx, judgment);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// classify / status / test / log / mine
// ---------------------------------------------------------------------------

async function commandClassify(ctx: Context, argv: string[]) {
  try {
    const parsed = parseArgs(argv, []);
    const stateArg = lastValue(parsed, "state");
    const questionsArg = lastValue(parsed, "questions");
    if (!stateArg || !questionsArg)
      throw new Error("classify needs --state and --questions");
    const state = await resolveJsonObject(stateArg, "--state", ctx.sources);
    const questions = await resolveJsonObject(
      questionsArg,
      "--questions",
      ctx.sources,
    );
    const result = await runRawClassify(
      ctx.backend(),
      state,
      questions as Parameters<typeof runRawClassify>[2],
      { model: lastValue(parsed, "model") },
    );
    print(ctx, result);
    if (!result.ok) ctx.err(`clef: ${result.error}\n`);
    return result.ok ? EXIT_OK : EXIT_FAILURE;
  } catch (error) {
    return fail(ctx, "raw", error);
  }
}

function commandStatus(ctx: Context, argv: string[]) {
  const parsed = parseArgs(argv, ["json"]);
  const status = collectStatus({
    agentDir: ctx.agentDir,
    logFile: ctx.logFile,
    env: ctx.env,
  });
  if (parsed.switches.has("json")) print(ctx, status, true);
  else ctx.out(`${formatStatus(status)}\n`);
  return EXIT_OK;
}

async function commandTest(ctx: Context, argv: string[]) {
  const parsed = parseArgs(argv, []);
  if (!ctx.deps.backend) {
    const credentials = resolveCredentials({
      env: ctx.env,
      authFile: path.join(ctx.agentDir, "auth.json"),
    });
    if (!credentials.ok) {
      ctx.err(`clef test: ${credentials.hint}\n`);
      return EXIT_FAILURE;
    }
  }
  const outcome = await runTestCall(ctx.backend(), lastValue(parsed, "model"));
  (outcome.ok ? ctx.out : ctx.err)(`${outcome.text}\n`);
  return outcome.ok ? EXIT_OK : EXIT_FAILURE;
}

function commandLog(ctx: Context, argv: string[]) {
  const parsed = parseArgs(argv, ["json"], { n: "n" });
  const count = Number(lastValue(parsed, "n") ?? 20);
  if (!Number.isInteger(count) || count < 1) {
    ctx.err("clef log: -n expects a positive integer\n");
    return EXIT_FAILURE;
  }
  const records = selectDecisions(
    ctx.logFile,
    count,
    lastValue(parsed, "kind"),
  );
  if (parsed.switches.has("json"))
    for (const record of records) ctx.out(`${JSON.stringify(record)}\n`);
  else if (!records.length) ctx.out(`no decisions yet in ${ctx.logFile}\n`);
  else ctx.out(`${records.map(formatDecision).join("\n")}\n`);
  return EXIT_OK;
}

async function commandMine(ctx: Context, argv: string[]) {
  try {
    const parsed = parseArgs(argv, ["dry"]);
    const limit = Number(lastValue(parsed, "limit") ?? 40);
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error("--limit expects a positive integer");
    const sinceArg = lastValue(parsed, "since");
    const collect = {
      agentDir: ctx.agentDir,
      asyncRunsDir: ctx.deps.asyncRunsDir,
      roots: (parsed.values.get("root") ?? []).map((root) =>
        path.resolve(ctx.cwd, root),
      ),
      since: sinceArg ? sinceToMs(sinceArg) : undefined,
      limit,
    };
    if (parsed.switches.has("dry")) {
      const { raw, unique, selected } = selectItems(collect);
      ctx.out(`${formatDryRun(summarizeDryRun(raw, unique, selected))}\n`);
      return EXIT_OK;
    }
    const out = lastValue(parsed, "out");
    const result = await runMine(ctx.backend(), {
      ...collect,
      out: out ? path.resolve(ctx.cwd, out) : undefined,
      logFile: logEnabled(ctx, false) ? ctx.logFile : undefined,
    });
    ctx.out(
      `${result.summary}\nreport: ${result.reportPath}\ndata:   ${result.jsonlPath}\n`,
    );
    return EXIT_OK;
  } catch (error) {
    ctx.err(
      `clef mine: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT_FAILURE;
  }
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

/** Returns the process exit code. */
export async function main(argv: string[], deps: CliDeps = {}) {
  const ctx = createContext(deps);
  const [command, ...rest] = argv;
  switch (command) {
    case "judge":
      return commandJudge(ctx, rest, "cli");
    case "gate":
      return commandJudge(ctx, rest, "gate");
    case "agent":
      return commandAgent(ctx, rest);
    case "classify":
      return commandClassify(ctx, rest);
    case "status":
      return commandStatus(ctx, rest);
    case "test":
      return commandTest(ctx, rest);
    case "log":
      return commandLog(ctx, rest);
    case "mine":
      return commandMine(ctx, rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      ctx.out(`${helpText(rest[0])}\n`);
      return EXIT_OK;
    default:
      ctx.err(`clef: unknown command "${command}"\n${helpText()}\n`);
      return EXIT_FAILURE;
  }
}

function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `clef: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = EXIT_FAILURE;
    },
  );
}

export { DEFAULT_THRESHOLD };
