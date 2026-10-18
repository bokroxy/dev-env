import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ClassifierContext } from "@earendil-works/pi-ai";
import { CLEF_MODELS, CLEF_PROVIDER, runJudge } from "./clef.ts";
import {
  createRestBackend,
  maskAccountId,
  resetKeyCommandCache,
  resolveCredentials,
  type Credentials,
} from "./clef-rest.ts";

const SECRET = "cf-secret-token-123456";
const creds: Credentials = {
  ok: true,
  apiKey: SECRET,
  accountId: "acct1234567890",
  source: "env",
};
const clefRef = { provider: CLEF_PROVIDER, id: CLEF_MODELS.clef };

const choiceContext: ClassifierContext = {
  state: { text: "hello" },
  questions: {
    decision: {
      type: "choice",
      instructions: "pick",
      criteria: { a: "A", b: "B" },
    },
  },
};

const answers = {
  decision: {
    type: "choice",
    choice: "a",
    probabilities: { a: 0.97, b: 0.03 },
    confidence: 0.5,
  },
};

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function scriptedFetch(...steps: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step.clone();
  };
  return { fetchFn, calls };
}

function authFile(content: unknown) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "clef-auth-"));
  const file = path.join(dir, "auth.json");
  writeFileSync(file, JSON.stringify(content));
  return file;
}

test("direct result envelope: request shape, answers and cost", async () => {
  const { fetchFn, calls } = scriptedFetch(
    json({
      success: true,
      errors: [],
      result: {
        model: "clef",
        answers,
        usage: { input_tokens: 1000, output_tokens: 3 },
      },
    }),
  );
  const backend = createRestBackend({ fetch: fetchFn, credentials: creds });
  const result = await backend.classify(clefRef, choiceContext);
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.answers.decision, {
    type: "choice",
    choice: "a",
    probabilities: { a: 0.97, b: 0.03 },
    confidence: 0.5,
  });
  assert.equal(result.usage?.input, 1000);
  assert.equal(result.usage?.output, 3);
  assert.equal(result.usage?.cost.total, 0.00024);

  assert.equal(
    calls[0].url,
    "https://api.cloudflare.com/client/v4/accounts/acct1234567890/ai/run/@cf/cloudflare/clef",
  );
  assert.equal(calls[0].init.method, "POST");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${SECRET}`);
  const sent = JSON.parse(String(calls[0].init.body));
  assert.equal(sent.model, "clef");
  assert.deepEqual(sent.state, { text: "hello" });
  assert.equal(sent.questions.decision.type, "choice");
});

test("model id mapping: flash uses clef-flash in body and path; other ids are rejected", async () => {
  const { fetchFn, calls } = scriptedFetch(
    json({ success: true, result: { answers } }),
  );
  const backend = createRestBackend({ fetch: fetchFn, credentials: creds });
  await backend.classify(
    { provider: CLEF_PROVIDER, id: CLEF_MODELS.flash },
    choiceContext,
  );
  assert.match(calls[0].url, /\/ai\/run\/@cf\/cloudflare\/clef-flash$/);
  assert.equal(JSON.parse(String(calls[0].init.body)).model, "clef-flash");

  const other = await backend.classify(
    { provider: CLEF_PROVIDER, id: "typesafe/jev" },
    choiceContext,
  );
  assert.equal(other.stopReason, "error");
  assert.match(String(other.errorMessage), /unsupported classifier/);
  const wrongProvider = await backend.classify(
    { provider: "openrouter", id: CLEF_MODELS.clef },
    choiceContext,
  );
  assert.equal(wrongProvider.stopReason, "error");
  assert.equal(calls.length, 1, "no request for unsupported models");
});

test("run-record envelope (state Completed) is unwrapped", async () => {
  const { fetchFn } = scriptedFetch(
    json({
      success: true,
      result: {
        state: "Completed",
        result: { answers, usage: { input_tokens: 10, output_tokens: 0 } },
      },
    }),
  );
  const result = await createRestBackend({
    fetch: fetchFn,
    credentials: creds,
  }).classify(clefRef, choiceContext);
  assert.equal(result.stopReason, "stop");
  assert.equal(result.answers.decision.type, "choice");

  const pending = scriptedFetch(
    json({ success: true, result: { state: "Running" } }),
  );
  const notDone = await createRestBackend({
    fetch: pending.fetchFn,
    credentials: creds,
  }).classify(clefRef, choiceContext);
  assert.equal(notDone.stopReason, "error");
  assert.match(
    String(notDone.errorMessage),
    /did not complete \(state: Running\)/,
  );
});

test("success:false surfaces the Cloudflare error messages", async () => {
  const { fetchFn } = scriptedFetch(
    json({
      success: false,
      errors: [{ code: 1, message: "bad state" }, { message: "worse" }],
      result: null,
    }),
  );
  const result = await createRestBackend({
    fetch: fetchFn,
    credentials: creds,
    maxRetries: 0,
  }).classify(clefRef, choiceContext);
  assert.equal(result.stopReason, "error");
  assert.match(String(result.errorMessage), /bad state; worse/);
});

test("answers without a wire type are inferred; bool maps to noul and back", async () => {
  const { fetchFn, calls } = scriptedFetch(
    json({
      success: true,
      result: {
        answers: {
          c: {
            choice: "x",
            probabilities: { x: 0.6, y: 0.4 },
            confidence: 0.2,
          },
          s: { score: 3.5, confidence: 0.8 },
          b: { noul: 0.75 },
        },
      },
    }),
  );
  const result = await createRestBackend({
    fetch: fetchFn,
    credentials: creds,
  }).classify(clefRef, {
    state: {},
    questions: {
      c: { type: "choice", instructions: "?", criteria: { x: "x", y: "y" } },
      s: { type: "score", instructions: "?", criteria: ["a", "b"] },
      b: {
        type: "bool",
        instructions: "?",
        criteria: { true: "t", false: "f" },
      },
    },
  });
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.answers.s, {
    type: "score",
    score: 3.5,
    confidence: 0.8,
  });
  assert.deepEqual(result.answers.b, { type: "bool", probability: 0.75 });
  assert.equal(JSON.parse(String(calls[0].init.body)).questions.b.type, "noul");
});

test("401 carries a token-permission hint and is not retried", async () => {
  const { fetchFn, calls } = scriptedFetch(
    json(
      {
        success: false,
        errors: [{ code: 10000, message: "Authentication error" }],
      },
      { status: 401 },
    ),
  );
  const result = await createRestBackend({
    fetch: fetchFn,
    credentials: creds,
  }).classify(clefRef, choiceContext);
  assert.equal(result.stopReason, "error");
  assert.match(String(result.errorMessage), /401/);
  assert.match(String(result.errorMessage), /Authentication error/);
  assert.match(String(result.errorMessage), /Workers AI permission/);
  assert.equal(calls.length, 1);
});

test("429 retries (honoring retry-after) and then succeeds", async () => {
  const { fetchFn, calls } = scriptedFetch(
    new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
    new Response("oops", { status: 503 }),
    json({ success: true, result: { answers } }),
  );
  const backend = createRestBackend({
    fetch: fetchFn,
    credentials: creds,
    retryDelayMs: 1,
  });
  const result = await backend.classify(clefRef, choiceContext);
  assert.equal(result.stopReason, "stop");
  assert.equal(calls.length, 3);

  const stuck = scriptedFetch(new Response("no", { status: 429 }));
  const exhausted = await createRestBackend({
    fetch: stuck.fetchFn,
    credentials: creds,
    retryDelayMs: 1,
    maxRetries: 2,
  }).classify(clefRef, choiceContext);
  assert.equal(exhausted.stopReason, "error");
  assert.match(String(exhausted.errorMessage), /429/);
  assert.equal(stuck.calls.length, 3);
});

test("network errors retry then fail with a clear message", async () => {
  const flaky = scriptedFetch(
    new TypeError("fetch failed"),
    json({ success: true, result: { answers } }),
  );
  const ok = await createRestBackend({
    fetch: flaky.fetchFn,
    credentials: creds,
    retryDelayMs: 1,
  }).classify(clefRef, choiceContext);
  assert.equal(ok.stopReason, "stop");

  const down = scriptedFetch(new TypeError("fetch failed"));
  const failed = await createRestBackend({
    fetch: down.fetchFn,
    credentials: creds,
    retryDelayMs: 1,
    maxRetries: 1,
  }).classify(clefRef, choiceContext);
  assert.equal(failed.stopReason, "error");
  assert.match(String(failed.errorMessage), /network error: fetch failed/);
  assert.equal(down.calls.length, 2);
});

test("an aborted signal stops without a request", async () => {
  const { fetchFn, calls } = scriptedFetch(
    json({ success: true, result: { answers } }),
  );
  const controller = new AbortController();
  controller.abort();
  const result = await createRestBackend({
    fetch: fetchFn,
    credentials: creds,
  }).classify(clefRef, choiceContext, {
    signal: controller.signal,
  });
  assert.equal(result.stopReason, "aborted");
  assert.equal(calls.length, 0);
});

test("missing credentials fail closed with the /login hint and no request", async () => {
  const { fetchFn, calls } = scriptedFetch(json({}));
  const missing = resolveCredentials({
    env: {},
    authFile: "/nonexistent/auth.json",
  });
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.deepEqual(missing.missing, [
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_ACCOUNT_ID",
  ]);
  assert.match(missing.hint, /\/login/);

  const result = await createRestBackend({
    fetch: fetchFn,
    credentials: missing,
  }).classify(clefRef, choiceContext);
  assert.equal(result.stopReason, "error");
  assert.match(String(result.errorMessage), /Cloudflare Workers AI/);
  assert.equal(calls.length, 0);

  const judged = await runJudge(
    createRestBackend({ fetch: fetchFn, credentials: missing }),
    "finding",
    {
      finding: "x",
    },
  );
  assert.equal(judged.judgment.ok, false);
  assert.equal(judged.judgment.action, "escalate");
});

test("credentials: env-only, token alias, per-field merge and auth.json precedence", () => {
  const envOnly = resolveCredentials({
    env: { CLOUDFLARE_API_KEY: "k1", CLOUDFLARE_ACCOUNT_ID: "a1" },
    authFile: "/nonexistent/auth.json",
  });
  assert.deepEqual(envOnly, {
    ok: true,
    apiKey: "k1",
    accountId: "a1",
    source: "env",
  });

  const alias = resolveCredentials({
    env: { CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "a1" },
    authFile: "/nonexistent/auth.json",
  });
  assert.equal(alias.ok && alias.apiKey, "tok");

  const file = authFile({
    [CLEF_PROVIDER]: {
      type: "api_key",
      key: "stored",
      env: { CLOUDFLARE_ACCOUNT_ID: "stored-acct" },
    },
  });
  const stored = resolveCredentials({
    env: { CLOUDFLARE_API_KEY: "envkey", CLOUDFLARE_ACCOUNT_ID: "envacct" },
    authFile: file,
  });
  assert.deepEqual(stored, {
    ok: true,
    apiKey: "stored",
    accountId: "stored-acct",
    source: "auth.json",
  });

  const merged = resolveCredentials({
    env: { CLOUDFLARE_ACCOUNT_ID: "envacct" },
    authFile: authFile({ [CLEF_PROVIDER]: { type: "api_key", key: "stored" } }),
  });
  assert.deepEqual(merged, {
    ok: true,
    apiKey: "stored",
    accountId: "envacct",
    source: "auth.json+env",
  });

  const partial = resolveCredentials({
    env: {},
    authFile: authFile({ [CLEF_PROVIDER]: { key: "only-key" } }),
  });
  assert.equal(partial.ok, false);
  assert.deepEqual(!partial.ok && partial.missing, ["CLOUDFLARE_ACCOUNT_ID"]);
});

test("credentials: a !command key runs through the shell once and is cached", () => {
  resetKeyCommandCache();
  const commands: string[] = [];
  const file = authFile({
    [CLEF_PROVIDER]: {
      type: "api_key",
      key: "!echo-key --flag",
      env: { CLOUDFLARE_ACCOUNT_ID: "acct" },
    },
  });
  const runCommand = (command: string) => {
    commands.push(command);
    return "  key-from-command\n";
  };
  const first = resolveCredentials({ env: {}, authFile: file, runCommand });
  const second = resolveCredentials({ env: {}, authFile: file, runCommand });
  assert.deepEqual(first, {
    ok: true,
    apiKey: "key-from-command",
    accountId: "acct",
    source: "auth.json",
  });
  assert.deepEqual(second, first);
  assert.deepEqual(commands, ["echo-key --flag"]);

  resetKeyCommandCache();
  const failing = resolveCredentials({
    env: {},
    authFile: file,
    runCommand: () => "",
  });
  assert.equal(failing.ok, false);
  assert.match(
    !failing.ok ? failing.hint : "",
    /key command produced no output/,
  );
  // A failed command stays unresolved for the process lifetime, like pi.
  const again = resolveCredentials({ env: {}, authFile: file, runCommand });
  assert.equal(again.ok, false);

  resetKeyCommandCache();
  const real = resolveCredentials({
    env: {},
    authFile: authFile({
      [CLEF_PROVIDER]: {
        key: "!printf real-shell-key",
        env: { CLOUDFLARE_ACCOUNT_ID: "acct" },
      },
    }),
  });
  assert.equal(real.ok && real.apiKey, "real-shell-key");
  resetKeyCommandCache();
});

test("the API key never appears in error text", async () => {
  const leaky = scriptedFetch(
    new Response(
      `upstream echoed Authorization: Bearer ${SECRET} and ${SECRET}`,
      { status: 400 },
    ),
  );
  const result = await createRestBackend({
    fetch: leaky.fetchFn,
    credentials: creds,
  }).classify(clefRef, choiceContext);
  assert.equal(result.stopReason, "error");
  assert.ok(
    !String(result.errorMessage).includes(SECRET),
    String(result.errorMessage),
  );

  const thrown = scriptedFetch(
    new TypeError(`connect failed for Bearer ${SECRET}`),
  );
  const network = await createRestBackend({
    fetch: thrown.fetchFn,
    credentials: creds,
    maxRetries: 0,
  }).classify(clefRef, choiceContext);
  assert.ok(
    !String(network.errorMessage).includes(SECRET),
    String(network.errorMessage),
  );
});

test("malformed answers fail the call but keep the billed usage", async () => {
  const { fetchFn } = scriptedFetch(
    json({
      success: true,
      result: { answers: {}, usage: { input_tokens: 500, output_tokens: 0 } },
    }),
  );
  const result = await createRestBackend({
    fetch: fetchFn,
    credentials: creds,
  }).classify(clefRef, choiceContext);
  assert.equal(result.stopReason, "error");
  assert.match(
    String(result.errorMessage),
    /did not return an answer for "decision"/,
  );
  assert.equal(result.usage?.input, 500);
});

test("question validation and account id masking", async () => {
  const { fetchFn, calls } = scriptedFetch(json({}));
  const backend = createRestBackend({ fetch: fetchFn, credentials: creds });
  const noQuestions = await backend.classify(clefRef, {
    state: {},
    questions: {},
  });
  assert.match(String(noQuestions.errorMessage), /1-64 questions/);
  const badId = await backend.classify(clefRef, {
    state: {},
    questions: {
      "bad id": { type: "choice", instructions: "?", criteria: { a: "a" } },
    },
  });
  assert.match(String(badId.errorMessage), /invalid question id/);
  assert.equal(calls.length, 0);
  assert.equal(maskAccountId("0123456789abcdef"), "0123…cdef");
  assert.equal(maskAccountId("short"), "****");
});

test("PASTE_ placeholders in auth.json count as unset, with env fallback per field", () => {
  const file = authFile({
    [CLEF_PROVIDER]: {
      type: "api_key",
      key: "PASTE_CLOUDFLARE_API_TOKEN_HERE",
      env: { CLOUDFLARE_ACCOUNT_ID: "PASTE_CLOUDFLARE_ACCOUNT_ID_HERE" },
    },
  });
  const none = resolveCredentials({ env: {}, authFile: file });
  assert.equal(none.ok, false);
  assert.ok(!none.ok && none.placeholder);
  assert.match(
    !none.ok ? none.hint : "",
    /Placeholder in auth\.json: replace the PASTE_/,
  );
  assert.deepEqual(!none.ok && none.missing, [
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_ACCOUNT_ID",
  ]);

  const fromEnv = resolveCredentials({
    env: { CLOUDFLARE_API_KEY: "envkey", CLOUDFLARE_ACCOUNT_ID: "envacct" },
    authFile: file,
  });
  assert.deepEqual(fromEnv, {
    ok: true,
    apiKey: "envkey",
    accountId: "envacct",
    source: "env",
  });

  const mixed = resolveCredentials({
    env: { CLOUDFLARE_ACCOUNT_ID: "envacct" },
    authFile: authFile({
      [CLEF_PROVIDER]: {
        key: "realkey",
        env: { CLOUDFLARE_ACCOUNT_ID: "PASTE_X" },
      },
    }),
  });
  assert.deepEqual(mixed, {
    ok: true,
    apiKey: "realkey",
    accountId: "envacct",
    source: "auth.json+env",
  });
});
