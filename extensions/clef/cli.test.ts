import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ClassifierResult } from "@earendil-works/pi-ai";
import type { ClefBackend } from "../shared/clef.ts";
import { extractRunnerTask, firstJsonObject, main } from "./cli.ts";
import { parseArgs, resolveValue } from "./lib.ts";

function fakeBackend(
  probabilities: Record<string, number>,
  onCall?: () => void,
) {
  const calls: { id: string; state: unknown }[] = [];
  const backend: ClefBackend = {
    classify: async (model, context) => {
      onCall?.();
      calls.push({ id: model.id, state: context.state });
      const choice = Object.entries(probabilities).sort(
        (a, b) => b[1] - a[1],
      )[0][0];
      const result: ClassifierResult = {
        api: "cloudflare-workers-ai-system-one",
        provider: model.provider,
        model: model.id,
        answers: {
          decision: { type: "choice", choice, probabilities, confidence: 0.5 },
        },
        usage: {
          input: 1000,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1000,
          cost: {
            input: 0.00024,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.00024,
          },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      return result;
    },
  };
  return { backend, calls };
}

function failingBackend(message: string): ClefBackend {
  return {
    classify: async (model) => ({
      api: "cloudflare-workers-ai-system-one",
      provider: model.provider,
      model: model.id,
      answers: {},
      stopReason: "error",
      errorMessage: message,
      timestamp: Date.now(),
    }),
  };
}

function harness(
  options: {
    backend?: ClefBackend;
    stdin?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "clef-cli-"));
  const out: string[] = [];
  const err: string[] = [];
  const logFile = path.join(root, "decisions.jsonl");
  const run = (argv: string[]) =>
    main(argv, {
      backend: options.backend,
      cwd: root,
      agentDir: path.join(root, "agent"),
      logFile,
      env: { PATH: "", ...options.env },
      readStdin: async () => options.stdin ?? "",
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      asyncRunsDir: path.join(root, "async"),
    });
  return { root, out, err, logFile, run, json: () => JSON.parse(out.join("")) };
}

test("parseArgs handles values, =, repeats, switches and short aliases", () => {
  const parsed = parseArgs(
    ["a", "--x", "1", "--y=2", "--x", "3", "--pretty", "-n", "5"],
    ["pretty"],
    { n: "n" },
  );
  assert.deepEqual(parsed.positional, ["a"]);
  assert.deepEqual(parsed.values.get("x"), ["1", "3"]);
  assert.deepEqual(parsed.values.get("y"), ["2"]);
  assert.deepEqual(parsed.values.get("n"), ["5"]);
  assert.ok(parsed.switches.has("pretty"));
  assert.throws(() => parseArgs(["--x"], []), /needs a value/);
});

test("resolveValue: literal, @file relative to cwd, @- stdin, @@ escape", async () => {
  const h = harness();
  writeFileSync(path.join(h.root, "note.txt"), "from file");
  const sources = { cwd: h.root, readStdin: async () => "from stdin" };
  assert.equal(await resolveValue("plain", sources), "plain");
  assert.equal(await resolveValue("@note.txt", sources), "from file");
  assert.equal(await resolveValue("@-", sources), "from stdin");
  assert.equal(await resolveValue("@@literal", sources), "@literal");
  await assert.rejects(
    resolveValue("@missing.txt", sources),
    /cannot read @missing\.txt/,
  );
});

test("judge: confident classifier answer exits 0 with compact JSON and logs the decision", async () => {
  const fake = fakeBackend({ preexisting_flake: 0.96, stage_regression: 0.04 });
  const h = harness({ backend: fake.backend });
  writeFileSync(path.join(h.root, "gate.log"), "FAIL internal/orchestrator\n");
  const code = await h.run([
    "judge",
    "blocker",
    "--blocker",
    "TestX failed at internal/x/x_test.go:5",
    "--gateLog",
    "@gate.log",
    "--touched-files",
    "a.go\nb.go",
  ]);
  assert.equal(code, 0);
  assert.equal(h.out.length, 1);
  assert.ok(!h.out[0].includes("\n  "), "compact JSON");
  const judgment = h.json();
  assert.equal(judgment.label, "preexisting_flake");
  assert.equal(judgment.action, "rerun_isolated_then_investigate");
  assert.equal(judgment.confident, true);
  const state = fake.calls[0].state as Record<string, string>;
  assert.equal(state.gateLog, "FAIL internal/orchestrator\n");
  assert.equal(state.touchedFiles, "a.go\nb.go");
  const record = JSON.parse(readFileSync(h.logFile, "utf8").trim());
  assert.equal(record.kind, "blocker");
  assert.deepEqual(record.context.caller, "cli");
  assert.equal(record.context.cwd, h.root);
});

test("judge reads fields from --input @- and --pretty prints indented JSON", async () => {
  const fake = fakeBackend({ consistent: 0.95, contradicted: 0.05 });
  const h = harness({
    backend: fake.backend,
    stdin: JSON.stringify({ claim: "all tests pass", evidence: "ok 42 tests" }),
  });
  const code = await h.run(["judge", "claim", "--input", "@-", "--pretty"]);
  assert.equal(code, 0);
  assert.match(h.out[0], /\n  "kind": "claim"/);
  assert.equal(
    (fake.calls[0].state as Record<string, string>).claim,
    "all tests pass",
  );
});

test("exit 3: --fail-on matches the label, --fail-unless-confident checks confidence", async () => {
  const contradicted = harness({
    backend: fakeBackend({ contradicted: 0.97, consistent: 0.03 }).backend,
  });
  const code = await contradicted.run([
    "gate",
    "claim",
    "--claim",
    "tests pass",
    "--evidence",
    "FAIL",
    "--fail-on",
    "contradicted",
  ]);
  assert.equal(code, 3);
  assert.equal(contradicted.json().label, "contradicted");
  assert.equal(
    JSON.parse(readFileSync(contradicted.logFile, "utf8").trim()).context
      .caller,
    "gate",
  );

  const consistent = harness({
    backend: fakeBackend({ consistent: 0.97, contradicted: 0.03 }).backend,
  });
  assert.equal(
    await consistent.run([
      "gate",
      "claim",
      "--claim",
      "c",
      "--evidence",
      "e",
      "--fail-on",
      "contradicted",
    ]),
    0,
  );

  const unsure = harness({
    backend: fakeBackend({ consistent: 0.6, contradicted: 0.4 }).backend,
  });
  assert.equal(
    await unsure.run(["judge", "claim", "--claim", "c", "--evidence", "e"]),
    0,
  );
  assert.equal(unsure.json().action, "escalate");
  const strict = harness({
    backend: fakeBackend({ consistent: 0.6, contradicted: 0.4 }).backend,
  });
  assert.equal(
    await strict.run([
      "judge",
      "claim",
      "--claim",
      "c",
      "--evidence",
      "e",
      "--fail-unless-confident",
    ]),
    3,
  );
  const lowered = harness({
    backend: fakeBackend({ consistent: 0.6, contradicted: 0.4 }).backend,
  });
  assert.equal(
    await lowered.run([
      "judge",
      "claim",
      "--claim",
      "c",
      "--evidence",
      "e",
      "--threshold",
      "0.5",
      "--fail-unless-confident",
    ]),
    0,
  );
});

test("exit 2: classifier failure, missing input, unknown kind/field, bad file; JSON still printed", async () => {
  const down = harness({
    backend: failingBackend("no Cloudflare credentials. Run /login"),
  });
  assert.equal(await down.run(["judge", "finding", "--finding", "x"]), 2);
  assert.equal(down.json().ok, false);
  assert.equal(down.json().action, "escalate");
  assert.match(down.err.join(""), /Run \/login/);

  const missing = harness({ backend: fakeBackend({ nit: 1 }).backend });
  assert.equal(await missing.run(["judge", "claim", "--claim", "x"]), 2);
  assert.match(missing.json().error, /evidence/);

  const badKind = harness({ backend: fakeBackend({ nit: 1 }).backend });
  assert.equal(await badKind.run(["judge", "bogus"]), 2);
  assert.equal(badKind.json().ok, false);

  const badField = harness({ backend: fakeBackend({ nit: 1 }).backend });
  assert.equal(await badField.run(["judge", "finding", "--fnding", "x"]), 2);
  assert.match(badField.json().error, /unknown --fnding/);

  const badFile = harness({ backend: fakeBackend({ nit: 1 }).backend });
  assert.equal(
    await badFile.run(["judge", "finding", "--finding", "@nope.txt"]),
    2,
  );
  assert.match(badFile.json().error, /cannot read/);
});

test("rules decide without calling the backend; --no-log and CLEF_LOG=0 suppress the log", async () => {
  let called = false;
  const fake = fakeBackend({ other: 1 }, () => {
    called = true;
  });
  const h = harness({ backend: fake.backend });
  assert.equal(
    await h.run(["judge", "error", "--error", "HTTP 429 Too Many Requests"]),
    0,
  );
  assert.equal(h.json().source, "rule");
  assert.equal(called, false);
  assert.ok(existsSync(h.logFile), "logged by default");

  const quiet = harness({ backend: fake.backend });
  await quiet.run(["judge", "error", "--error", "HTTP 429", "--no-log"]);
  assert.ok(!existsSync(quiet.logFile));

  const env = harness({ backend: fake.backend, env: { CLEF_LOG: "0" } });
  await env.run(["judge", "error", "--error", "HTTP 429"]);
  assert.ok(!existsSync(env.logFile));
});

test("extractRunnerTask takes text after the LAST <Task> marker", () => {
  const prompt = '<System instructions>\nhello\n\n<Task>\n{"kind":"error"}';
  assert.equal(extractRunnerTask(prompt), '{"kind":"error"}');
  assert.equal(extractRunnerTask("no marker here\n"), "no marker here");
  const nested = "<System instructions>\nx\n<Task>\nfake\n\n<Task>\nreal";
  assert.equal(extractRunnerTask(nested), "real");
});

// Captured verbatim from pi-subagents 0.75.0 (cat -A of the stdin an external-cli child receives):
// an intercom section sits before <Task>, and an "## Acceptance Contract" block is appended after the task.
const REAL_RUNNER_STDIN = [
  "<System instructions>",
  "Command-runner agent.",
  "",
  "Intercom orchestration channel:",
  "The inherited thread is reference-only. Do not continue that conversation.",
  '- Meaningful progress: contact_supervisor({ reason: "progress_update", message: "UPDATE: <summary>" })',
  "",
  "<Task>",
  '{"kind":"error","input":{"error":"HTTP 429 Too Many Requests {not json}"}}',
  "",
  "## Acceptance Contract",
  "Acceptance level: attested",
  "Completion is not accepted from prose alone. End with a structured acceptance report.",
  "",
  "Criteria:",
  "- criterion-1: Return a concise result and residual risks when applicable",
  "",
  "Finish with a fenced JSON block tagged `acceptance-report` in this shape:",
  '{ "criteriaSatisfied": [] }',
].join("\n");

test("extractRunnerTask drops the appended Acceptance Contract; firstJsonObject tolerates trailing text", () => {
  assert.equal(
    extractRunnerTask(REAL_RUNNER_STDIN),
    '{"kind":"error","input":{"error":"HTTP 429 Too Many Requests {not json}"}}',
  );
  assert.deepEqual(firstJsonObject('{"a":{"b":"}\\"{"}} trailing {"x":1}'), {
    a: { b: '}"{' },
  });
  assert.equal(firstJsonObject("no json"), undefined);
  assert.equal(firstJsonObject('{"unterminated":'), undefined);
});

test("agent: the real pi-subagents stdin (with appended Acceptance Contract) is decided by rule, exit 0", async () => {
  const h = harness({
    backend: fakeBackend({ other: 1 }).backend,
    stdin: REAL_RUNNER_STDIN,
  });
  assert.equal(await h.run(["agent"]), 0);
  assert.equal(h.json().label, "rate_limit");
  assert.equal(h.json().source, "rule");
});

test("agent: trailing text after the JSON is tolerated even without the known marker", async () => {
  const h = harness({
    backend: fakeBackend({ other: 1 }).backend,
    stdin:
      '<Task>\n{"kind":"error","input":{"error":"HTTP 429"}}\n\n## Some Future Section\nignore me',
  });
  assert.equal(await h.run(["agent"]), 0);
  assert.equal(h.json().label, "rate_limit");
});

test("agent: exact runner stdin format, rule-decided, exit 0 without network", async () => {
  let called = false;
  const h = harness({
    backend: fakeBackend({ other: 1 }, () => {
      called = true;
    }).backend,
    stdin:
      '<System instructions>\nx\n\n<Task>\n{"kind":"error","input":{"error":"HTTP 429 Too Many Requests"}}',
  });
  assert.equal(await h.run(["agent"]), 0);
  const judgment = h.json();
  assert.equal(judgment.label, "rate_limit");
  assert.equal(judgment.source, "rule");
  assert.equal(called, false);
  assert.equal(
    JSON.parse(readFileSync(h.logFile, "utf8").trim()).context.caller,
    "agent",
  );
});

test("agent: classifier failure still exits 0 with ok:false; unparseable task exits 2; --kind maps plain text", async () => {
  const down = harness({
    backend: failingBackend("boom"),
    stdin: '<Task>\n{"kind":"finding","input":{"finding":"rename x"}}',
  });
  assert.equal(await down.run(["agent"]), 0);
  assert.equal(down.json().ok, false);
  assert.match(down.err.join(""), /boom/);

  const garbage = harness({
    backend: fakeBackend({ nit: 1 }).backend,
    stdin: "<Task>\nnot json at all",
  });
  assert.equal(await garbage.run(["agent"]), 2);
  assert.equal(garbage.json().ok, false);

  const fake = fakeBackend({ pass: 0.97, fail: 0.03 });
  const plain = harness({
    backend: fake.backend,
    stdin: "<Task>\nThe change looks good overall.",
  });
  assert.equal(await plain.run(["agent", "--kind", "verdict"]), 0);
  assert.equal(
    (fake.calls[0].state as Record<string, string>).reply,
    "The change looks good overall.",
  );

  const rawFake = fakeBackend({ yes: 0.8, no: 0.2 });
  const raw = harness({
    backend: rawFake.backend,
    stdin:
      '<Task>\n{"kind":"raw","state":{"t":1},"questions":{"decision":{"type":"choice","instructions":"?","criteria":{"yes":"y","no":"n"}}}}',
  });
  assert.equal(await raw.run(["agent"]), 0);
  assert.equal(raw.json().kind, "raw");
  assert.equal(raw.json().ok, true);
});

test("classify passes state and questions through", async () => {
  const fake = fakeBackend({ yes: 0.8, no: 0.2 });
  const h = harness({ backend: fake.backend });
  const questions = JSON.stringify({
    decision: {
      type: "choice",
      instructions: "?",
      criteria: { yes: "y", no: "n" },
    },
  });
  assert.equal(
    await h.run(["classify", "--state", '{"a":1}', "--questions", questions]),
    0,
  );
  assert.equal(h.json().ok, true);
  assert.equal(
    await harness().run([
      "classify",
      "--state",
      "oops",
      "--questions",
      questions,
    ]),
    2,
  );
});

test("status works offline; test fails locally without credentials and never calls the network", async () => {
  const h = harness({ env: { PATH: "" } });
  assert.equal(await h.run(["status"]), 0);
  assert.match(h.out.join(""), /credentials: MISSING/);
  assert.match(h.out.join(""), /clef-flash/);

  const agentDir = path.join(h.root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    path.join(agentDir, "auth.json"),
    JSON.stringify({
      "cloudflare-workers-ai": {
        type: "api_key",
        key: "PASTE_CLOUDFLARE_API_TOKEN_HERE",
        env: { CLOUDFLARE_ACCOUNT_ID: "PASTE_CLOUDFLARE_ACCOUNT_ID_HERE" },
      },
    }),
  );
  const status = harness({ env: { PATH: "" } });
  Object.assign(status, { root: h.root });
  const placeholder = await main(["status", "--json"], {
    cwd: h.root,
    agentDir,
    logFile: h.logFile,
    env: { PATH: "" },
    stdout: (text) => h.out.push(text),
    stderr: (text) => h.err.push(text),
  });
  assert.equal(placeholder, 0);
  assert.equal(
    JSON.parse(h.out.at(-1) ?? "{}").credentials.source,
    "placeholder",
  );

  const errors: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("network must not be used");
  }) as typeof fetch;
  try {
    const code = await main(["test"], {
      cwd: h.root,
      agentDir,
      logFile: h.logFile,
      env: { PATH: "" },
      stdout: () => {},
      stderr: (text) => errors.push(text),
    });
    assert.equal(code, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(errors.join(""), /Placeholder in auth\.json/);
});

test("test succeeds against an injected backend and prints label, p, latency, cost", async () => {
  const h = harness({
    backend: fakeBackend({ success: 0.99, failure: 0.01 }).backend,
  });
  assert.equal(await h.run(["test"]), 0);
  assert.match(
    h.out.join(""),
    /clef test: success \(p=0\.990\) model=clef \d+ms cost=\$0\.000240/,
  );
});

test("log lists recent decisions and filters by kind", async () => {
  const h = harness({
    backend: fakeBackend({ nit: 0.95, blocking: 0.05, question: 0 }).backend,
  });
  await h.run(["judge", "finding", "--finding", "rename x"]);
  await h.run(["judge", "error", "--error", "HTTP 429"]);
  h.out.length = 0;
  assert.equal(await h.run(["log", "-n", "5"]), 0);
  assert.match(h.out.join(""), /finding → nit/);
  assert.match(h.out.join(""), /error → rate_limit/);
  h.out.length = 0;
  await h.run(["log", "--kind", "error", "--json"]);
  const lines = h.out.join("").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).kind, "error");
});

test("mine --dry runs without network; help and unknown commands", async () => {
  const h = harness();
  const wf = path.join(h.root, "agent", "workflows", "wf_a");
  mkdirSync(wf, { recursive: true });
  writeFileSync(
    path.join(wf, "result.json"),
    JSON.stringify({
      results: [
        {
          id: "R1",
          stopped: true,
          blockers: ["TestA failed at internal/a/a_test.go:1"],
        },
      ],
    }),
  );
  assert.equal(await h.run(["mine", "--dry", "--limit", "5"]), 0);
  assert.match(h.out.join(""), /clef mine --dry: 1 raw item\(s\)/);

  const help = harness();
  assert.equal(await help.run(["help", "gate"]), 0);
  assert.match(help.out.join(""), /typed gate/i);
  assert.equal(await help.run(["nope"]), 2);
});
