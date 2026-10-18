import { JUDGE_KINDS, PRESETS } from "../shared/clef.ts";

const OVERVIEW = `clef — Cloudflare Clef decision models for triage. A judgment ROUTES work; it never approves it.
Below the confidence threshold (default 0.9 on the top probability) the action is always "escalate".

Usage: clef <command> [options]

Commands:
  judge <kind>   one typed judgment as compact JSON (blocker|verdict|error|finding|claim)
  gate <kind>    same as judge; for pi-subagents typed gates (see "clef help gate")
  agent          command-runner mode for the pi-subagents "clef" agent (reads the runner prompt on stdin)
  classify       raw passthrough: --state <json|@file> --questions <json|@file>
  status         credentials source, models, prices, log and install state (no network)
  test           one tiny live call to verify credentials
  log            recent decisions from ~/.pi/agent/clef/decisions.jsonl
  mine           classify historical failures from saved runs into a report
  help [cmd]     this help

Credentials: pi /login → Cloudflare Workers AI, or CLOUDFLARE_API_KEY (alias CLOUDFLARE_API_TOKEN) + CLOUDFLARE_ACCOUNT_ID.
Exit codes: 0 judgment produced · 2 classifier/credential/input failure (fail closed) · 3 --fail-on matched or --fail-unless-confident not met.

Run "clef help judge", "clef help gate", "clef help agent", "clef help mine" for examples of the six jobs.`;

function judgeKinds() {
  return JUDGE_KINDS.map((kind) => {
    const preset = PRESETS[kind];
    const fields = preset.fields
      .map((field) => `--${field.key}${field.required ? "*" : ""}`)
      .join(" ");
    return `  ${kind.padEnd(8)} ${fields}  →  ${Object.keys(preset.question.criteria).join("|")}`;
  }).join("\n");
}

const TOPICS: Record<string, () => string> = {
  judge:
    () => `clef judge <kind> [--<field> <value|@file|@->]... [--input @file|-] [--model clef|flash|@cf/...]
                [--threshold 0.9] [--no-rules] [--fail-on a,b] [--fail-unless-confident] [--no-log] [--pretty]

Fields (* required). @file reads a file relative to cwd, @- reads stdin, @@x is a literal "@x".
${judgeKinds()}
Array-like fields (touchedFiles, failingTests) take newline-separated text.

Examples (the six jobs):
1 blocker triage
  clef judge blocker --blocker "Full race gate exited 1: TestFoo at internal/x/x_test.go:52" \\
      --gateLog @gate.log --touchedFiles @files.txt --stage R2
2 verdict recovery
  clef judge verdict --reply @verifier-reply.md
3 provider-error triage (rules decide 429/5xx/network instantly)
  clef judge error --error "HTTP 429 Too Many Requests"
4 review-finding triage
  clef judge finding --finding @finding.txt --rules @AGENTS.md
5 "done" claim honesty check
  clef judge claim --claim @report.md --evidence @gate.log --exitCodes "go test: 1" --fail-on contradicted
6 mining past runs
  clef mine --dry        # counts and estimated cost, no network
  clef mine --limit 40`,

  gate: () => `clef gate <kind> ...   (identical to judge)

Use as a pi-subagents typed gate. The command runs after the child's output file is saved, in the child's cwd:
  runs.run("verify", { agent: "verifier", task, output: "reports/verify.md", outputMode: "file-only",
    gate: { command: "clef gate verdict --reply @reports/verify.md", output: "json" } })
  // then branch on r.structuredOutput.action ("accept_pass" | "treat_as_fail" | "escalate")

Exit codes matter: stdout JSON is only parsed when the exit code is 0. A non-zero exit (2 failure, 3 --fail-on /
--fail-unless-confident) fails the gate and the run's acceptance becomes "rejected" with no structuredOutput.
A gate also marks the child's acceptance level "verified". When the gate should truly accept or reject, add
--fail-on (for example "clef gate claim --claim @report.md --evidence @gate.log --fail-on contradicted").`,

  agent: () => `clef agent [--kind <kind>]

Command-runner mode for ~/.pi/agent/agents/clef.md. Reads the whole runner prompt on stdin, takes the text after the
last "\\n<Task>\\n" and parses it as JSON:
  {"kind":"blocker","input":{"blocker":"...","gateLog":"..."},"options":{"model":"flash","threshold":0.9}}
  {"kind":"raw","state":{...},"questions":{...}}
If the task is not JSON and --kind is given, the text becomes that kind's first required field.
Prints the judgment JSON; exits 0 whenever a judgment was produced (ok:false included), 2 for an unparseable task.

In a pi-subagents workflow:
  const r = await runs.run("triage", { agent: "clef", task: JSON.stringify({ kind: "error", input: { error: failed.error } }) });
  const j = JSON.parse(r.output);   // j.action`,

  classify:
    () => `clef classify --state <json|@file> --questions <json|@file> [--model clef|flash]
Raw passthrough with pi classifier questions (choice | score | bool). Prints {ok, answers, ...} JSON.`,

  status: () =>
    "clef status [--json]   credentials source, masked account id, models, prices, log path/count, install state. No network.",
  test: () =>
    "clef test [--model clef|flash]   one tiny live call; prints label, p, latency, cost. Exits 2 with a hint on failure.",
  log: () =>
    "clef log [-n 20] [--json] [--kind blocker|verdict|error|finding|claim|raw]",
  mine: () => `clef mine [--limit 40] [--dry] [--since YYYY-MM-DD] [--root <dir>]... [--out <file>]
Sources: pi-subagents artifacts (~/.pi/agent/sessions/*/subagent-artifacts and <root>/.pi/subagents/artifacts),
async run status (/tmp/pi-subagents-uid-*/async-subagent-runs), legacy ~/.pi/agent/workflows/wf_*.
--dry prints counts, samples and estimated cost without network. Otherwise writes
~/.pi/agent/clef/reports/mine-<ISO>.md and .jsonl.`,
};

export function helpText(topic?: string) {
  if (!topic) return OVERVIEW;
  const body = TOPICS[topic];
  return body ? body() : `${OVERVIEW}\n\nunknown help topic "${topic}"`;
}
