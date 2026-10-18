/**
 * Cloudflare Workers AI credentials and a REST backend for Clef.
 *
 * pi 1.0.2's built-in Clef transport posts to `.../ai/run` with `{ model, input }`,
 * which does not match the documented Clef endpoint, so we call
 * `POST /accounts/{id}/ai/run/@cf/cloudflare/clef[-flash]` ourselves with
 * `{ model, state, questions }`.
 *
 * Credential semantics mirror pi: the `cloudflare-workers-ai` entry of auth.json
 * (`key`, `env.CLOUDFLARE_ACCOUNT_ID`) wins per field over the process
 * environment. A key starting with `!` is a shell command whose stdout is the key.
 *
 * Never put the API key in an error, a log line or a return value other than
 * `Credentials.apiKey`.
 */

import type {
  ClassifierAnswer,
  ClassifierContext,
  ClassifierQuestion,
  ClassifierResult,
  Usage,
} from "@earendil-works/pi-ai";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { agentDir } from "./clef-log.ts";
import {
  CLEF_MODELS,
  CLEF_PROVIDER,
  type ClefBackend,
  type ClefModelRef,
} from "./clef.ts";

export type CredentialSource = "auth.json" | "env" | "auth.json+env";

export type Credentials =
  | { ok: true; apiKey: string; accountId: string; source: CredentialSource }
  | { ok: false; missing: string[]; hint: string; placeholder?: true };

export const CLEF_SETUP_HINT =
  "Run /login in pi and choose Cloudflare Workers AI (stores the key and account id in auth.json), " +
  "or set CLOUDFLARE_API_KEY (alias CLOUDFLARE_API_TOKEN) and CLOUDFLARE_ACCOUNT_ID. " +
  "The token needs the Workers AI permission.";

/** USD per 1M input tokens (output is free). */
export const CLEF_INPUT_PRICE_PER_MILLION: Record<string, number> = {
  [CLEF_MODELS.clef]: 0.24,
  [CLEF_MODELS.flash]: 0.09,
};

const API_ROOT = "https://api.cloudflare.com/client/v4/accounts";
const KEY_COMMAND_TIMEOUT_MS = 10_000;
const MAX_QUESTIONS = 64;
const QUESTION_ID = /^[A-Za-z0-9_.-]{1,100}$/;
const MAX_RETRY_DELAY_MS = 30_000;

export function maskAccountId(accountId: string) {
  return accountId.length > 8
    ? `${accountId.slice(0, 4)}…${accountId.slice(-4)}`
    : "****";
}

export function inputCostUsd(modelId: string, inputTokens: number) {
  return (
    (inputTokens * (CLEF_INPUT_PRICE_PER_MILLION[modelId] ?? 0)) / 1_000_000
  );
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface CredentialOptions {
  env?: NodeJS.ProcessEnv;
  /** Defaults to `<agent dir>/auth.json`. */
  authFile?: string;
  /** Runs a `!command` key; defaults to the platform shell with a 10 s timeout. Returns stdout or undefined. */
  runCommand?: (command: string) => string | undefined;
}

const keyCommandCache = new Map<string, string | undefined>();

export function resetKeyCommandCache() {
  keyCommandCache.clear();
}

function runShell(command: string) {
  try {
    // Platform shell: sh -c on POSIX, cmd.exe /d /s /c on Windows.
    return execFileSync(command, {
      shell: true,
      encoding: "utf8",
      timeout: KEY_COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

function resolveKeyCommand(
  command: string,
  runCommand: (command: string) => string | undefined,
) {
  if (keyCommandCache.has(command)) return keyCommandCache.get(command);
  const output = runCommand(command)?.trim();
  const key = output ? output : undefined;
  keyCommandCache.set(command, key);
  return key;
}

function nonEmpty(value: unknown) {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

/** Scaffold values such as PASTE_CLOUDFLARE_API_TOKEN_HERE count as unset. */
function isPlaceholder(value: string | undefined) {
  return value !== undefined && value.startsWith("PASTE_");
}

function readStoredCredential(authFile: string) {
  try {
    const auth: unknown = JSON.parse(readFileSync(authFile, "utf8"));
    if (typeof auth !== "object" || auth === null) return undefined;
    const entry: unknown = (auth as Record<string, unknown>)[CLEF_PROVIDER];
    if (typeof entry !== "object" || entry === null) return undefined;
    const { key, env } = entry as { key?: unknown; env?: unknown };
    const accountId =
      typeof env === "object" && env !== null
        ? nonEmpty((env as Record<string, unknown>).CLOUDFLARE_ACCOUNT_ID)
        : undefined;
    return { key: nonEmpty(key), accountId };
  } catch {
    return undefined;
  }
}

export function resolveCredentials(
  options: CredentialOptions = {},
): Credentials {
  const env = options.env ?? process.env;
  const authFile = options.authFile ?? path.join(agentDir(), "auth.json");
  const rawStored = readStoredCredential(authFile);
  const placeholderFound =
    isPlaceholder(rawStored?.key) || isPlaceholder(rawStored?.accountId);
  const stored = rawStored && {
    key: isPlaceholder(rawStored.key) ? undefined : rawStored.key,
    accountId: isPlaceholder(rawStored.accountId)
      ? undefined
      : rawStored.accountId,
  };

  let storedKey = stored?.key;
  let keyCommandFailed = false;
  if (storedKey?.startsWith("!")) {
    storedKey = resolveKeyCommand(
      storedKey.slice(1),
      options.runCommand ?? runShell,
    );
    keyCommandFailed = storedKey === undefined;
  }
  const envKey =
    nonEmpty(env.CLOUDFLARE_API_KEY) ?? nonEmpty(env.CLOUDFLARE_API_TOKEN);
  const envAccount = nonEmpty(env.CLOUDFLARE_ACCOUNT_ID);

  const apiKey = storedKey ?? envKey;
  const accountId = stored?.accountId ?? envAccount;
  if (apiKey && accountId) {
    const authCount = (storedKey ? 1 : 0) + (stored?.accountId ? 1 : 0);
    const source: CredentialSource =
      authCount === 2 ? "auth.json" : authCount === 0 ? "env" : "auth.json+env";
    return { ok: true, apiKey, accountId, source };
  }

  const missing: string[] = [];
  if (!apiKey) missing.push("CLOUDFLARE_API_KEY");
  if (!accountId) missing.push("CLOUDFLARE_ACCOUNT_ID");
  const commandNote = keyCommandFailed
    ? " The auth.json key command produced no output, timed out or exited non-zero."
    : "";
  if (placeholderFound)
    return {
      ok: false,
      missing,
      placeholder: true,
      hint:
        `Placeholder in auth.json: replace the PASTE_… values for cloudflare-workers-ai ` +
        `(or run /login → Cloudflare Workers AI, or set ${missing.join(" and ")}).`,
    };
  return {
    ok: false,
    missing,
    hint: `Missing ${missing.join(" and ")}.${commandNote} ${CLEF_SETUP_HINT}`,
  };
}

// ---------------------------------------------------------------------------
// REST backend
// ---------------------------------------------------------------------------

export interface RestBackendOptions {
  fetch?: typeof fetch;
  /** Fixed credentials; default resolves them from auth.json/env on every call. */
  credentials?: Credentials;
  timeoutMs?: number;
  /** Retries after the first attempt, for 429/5xx/network failures. */
  maxRetries?: number;
  /** Base for exponential backoff when no `retry-after` header is sent. */
  retryDelayMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function redactSecrets(text: string, apiKey?: string) {
  let out = text.replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [redacted]");
  if (apiKey) out = out.split(apiKey).join("[redacted]");
  return out;
}

function cloudflareErrors(body: unknown) {
  if (!isRecord(body) || !Array.isArray(body.errors)) return undefined;
  const messages = body.errors
    .map((error) =>
      isRecord(error) && typeof error.message === "string"
        ? error.message
        : undefined,
    )
    .filter((message) => message !== undefined);
  return messages.length ? messages.join("; ") : undefined;
}

function statusHint(status: number) {
  if (status === 401 || status === 403)
    return " Hint: the API token is invalid or lacks the Workers AI permission, or the account id belongs to another account.";
  if (status === 404)
    return " Hint: check CLOUDFLARE_ACCOUNT_ID and that the model is available to this account.";
  return "";
}

function wireQuestion(question: ClassifierQuestion) {
  return question.type === "bool" ? { ...question, type: "noul" } : question;
}

function probabilityMap(value: unknown, id: string) {
  if (!isRecord(value))
    throw new Error(`Clef returned invalid probabilities for "${id}"`);
  const out: Record<string, number> = {};
  for (const [label, p] of Object.entries(value)) {
    const n = numberField(p);
    if (n === undefined)
      throw new Error(
        `Clef returned a non-numeric probability for "${id}.${label}"`,
      );
    out[label] = n;
  }
  return out;
}

function parseAnswer(
  question: ClassifierQuestion,
  raw: unknown,
  id: string,
): ClassifierAnswer {
  if (!isRecord(raw))
    throw new Error(`Clef did not return an answer for "${id}"`);
  // `type` may be missing on the wire; the question type decides.
  if (question.type === "choice") {
    if (typeof raw.choice !== "string")
      throw new Error(`Clef did not return a choice for "${id}"`);
    const probabilities = probabilityMap(raw.probabilities, id);
    return {
      type: "choice",
      choice: raw.choice,
      probabilities,
      confidence: numberField(raw.confidence) ?? probabilities[raw.choice] ?? 0,
    };
  }
  if (question.type === "score") {
    const score = numberField(raw.score);
    if (score === undefined)
      throw new Error(`Clef did not return a score for "${id}"`);
    return {
      type: "score",
      score,
      confidence: numberField(raw.confidence) ?? 0,
    };
  }
  const probability = numberField(raw.noul) ?? numberField(raw.probability);
  if (probability === undefined)
    throw new Error(`Clef did not return a yes/no probability for "${id}"`);
  return { type: "bool", probability };
}

/** Unwraps the Cloudflare envelope (`{ success, errors, result }`) to `{ answers, usage }`. */
export function normalizeBody(body: unknown) {
  if (!isRecord(body))
    throw new Error("Cloudflare Workers AI returned an unexpected response");
  if (body.success === false)
    throw new Error(
      `Cloudflare Workers AI error: ${cloudflareErrors(body) ?? "request failed"}`,
    );
  const result = "result" in body ? body.result : body;
  if (!isRecord(result))
    throw new Error("Cloudflare Workers AI returned an unexpected response");
  if ("answers" in result) return result;
  if (result.state === "Completed" && isRecord(result.result))
    return result.result;
  if ("state" in result)
    throw new Error(
      `Cloudflare Workers AI run did not complete (state: ${String(result.state)})`,
    );
  throw new Error("Cloudflare Workers AI returned an unexpected response");
}

function usageFrom(value: unknown, modelId: string): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const input = numberField(value.input_tokens);
  const output = numberField(value.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  const inputTokens = Math.max(0, input ?? 0);
  const outputTokens = Math.max(0, output ?? 0);
  const cost = inputCostUsd(modelId, inputTokens);
  return {
    input: inputTokens,
    output: outputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: inputTokens + outputTokens,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function modelAlias(modelId: string) {
  if (modelId === CLEF_MODELS.clef) return "clef";
  if (modelId === CLEF_MODELS.flash) return "clef-flash";
  return undefined;
}

function retryDelay(
  response: Response | undefined,
  attempt: number,
  baseMs: number,
) {
  const header = response?.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    const date = Date.parse(header);
    if (!Number.isNaN(date))
      return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_DELAY_MS);
  }
  return Math.min(baseMs * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function createRestBackend(
  options: RestBackendOptions = {},
): ClefBackend {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRetries = options.maxRetries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 500;

  async function classify(
    model: ClefModelRef,
    context: ClassifierContext,
    callOptions: { signal?: AbortSignal } = {},
  ): Promise<ClassifierResult> {
    const signal = callOptions.signal;
    const result: ClassifierResult = {
      api: "cloudflare-workers-ai-system-one",
      provider: model.provider,
      model: model.id,
      answers: {},
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const credentials = options.credentials ?? resolveCredentials();
    const apiKey = credentials.ok ? credentials.apiKey : undefined;
    const fail = (message: string, aborted = false): ClassifierResult => ({
      ...result,
      stopReason: aborted ? "aborted" : "error",
      errorMessage: redactSecrets(message, apiKey),
    });

    const alias = modelAlias(model.id);
    if (model.provider !== CLEF_PROVIDER || !alias)
      return fail(
        `unsupported classifier ${model.provider}/${model.id}: only ${CLEF_PROVIDER} with ${CLEF_MODELS.clef} or ${CLEF_MODELS.flash} is supported`,
      );
    if (!credentials.ok)
      return fail(`no Cloudflare credentials. ${credentials.hint}`);

    const questionIds = Object.keys(context.questions);
    if (questionIds.length < 1 || questionIds.length > MAX_QUESTIONS)
      return fail(
        `Clef takes 1-${MAX_QUESTIONS} questions, got ${questionIds.length}`,
      );
    const badId = questionIds.find((id) => !QUESTION_ID.test(id));
    if (badId)
      return fail(
        `invalid question id "${badId}" (letters, digits, _ . - up to 100 chars)`,
      );

    const url = `${API_ROOT}/${encodeURIComponent(credentials.accountId)}/ai/run/${model.id}`;
    const body = JSON.stringify({
      model: alias,
      state: context.state,
      questions: Object.fromEntries(
        Object.entries(context.questions).map(([id, question]) => [
          id,
          wireQuestion(question),
        ]),
      ),
    });

    let lastError = "request failed";
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) return fail("aborted", true);
      const timeout = AbortSignal.timeout(timeoutMs);
      let response: Response | undefined;
      let retryable = false;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${credentials.apiKey}`,
            "content-type": "application/json",
          },
          body,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        if (signal?.aborted) return fail("aborted", true);
        const reason = timeout.aborted
          ? `timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
        lastError = `network error: ${reason}`;
        retryable = true;
      }

      if (response) {
        const text = await response.text().catch(() => "");
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        if (response.ok) {
          try {
            const normalized = normalizeBody(json);
            const usage = usageFrom(normalized.usage, model.id);
            if (usage) result.usage = usage;
            const answers = isRecord(normalized.answers)
              ? normalized.answers
              : {};
            for (const [id, question] of Object.entries(context.questions))
              result.answers[id] = parseAnswer(question, answers[id], id);
            return result;
          } catch (error) {
            // A response with malformed answers was still billed.
            const failed = fail(
              error instanceof Error ? error.message : String(error),
            );
            const billed =
              isRecord(json) && isRecord(json.result)
                ? json.result.usage
                : undefined;
            const usage = usageFrom(billed, model.id);
            return usage ? { ...failed, usage } : failed;
          }
        }
        const detail =
          cloudflareErrors(json) ??
          (text.trim().slice(0, 300) || response.statusText);
        lastError = `Cloudflare Workers AI returned ${response.status}: ${detail}.${statusHint(response.status)}`;
        retryable = response.status === 429 || response.status >= 500;
      }

      if (!retryable || attempt === maxRetries) return fail(lastError);
      await sleep(retryDelay(response, attempt, retryDelayMs), signal);
    }
    return fail(lastError);
  }

  return { classify };
}
