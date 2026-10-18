/**
 * Clef decision models for the main pi session: the `clef_judge` tool and the
 * `/clef` command. Uses our own Cloudflare REST client (see ../shared/clef-rest.ts),
 * not pi's classifier transport. A judgment routes work; it never approves it.
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  agentDir,
  appendDecision,
  globalDecisionLog,
} from "../shared/clef-log.ts";
import { createRestBackend } from "../shared/clef-rest.ts";
import {
  JUDGE_KINDS,
  formatJudgment,
  presetInputDoc,
  runJudge,
  runRawClassify,
  toDecisionRecord,
  type JudgeKind,
} from "../shared/clef.ts";
import { main } from "./cli.ts";
import { SETUP_TEXT } from "./lib.ts";

const ClefJudgeParams = Type.Object({
  kind: Type.Union(
    [...JUDGE_KINDS.map((kind) => Type.Literal(kind)), Type.Literal("raw")],
    {
      description: "Which judgment to make",
    },
  ),
  input: Type.Record(Type.String(), Type.Unknown(), {
    description:
      "Preset fields as an object (see the tool description), or the raw `state` object when kind is raw",
  }),
  questions: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "kind=raw only: classifier questions {id: {type: choice|score|bool, instructions, criteria}}",
    }),
  ),
  model: Type.Optional(
    Type.Union([Type.Literal("clef"), Type.Literal("flash")]),
  ),
  threshold: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      description: "Confidence gate on the top probability; default 0.9",
    }),
  ),
});

function usageOf(
  costUsd: number | undefined,
  tokens: number | undefined,
): Usage | undefined {
  if (costUsd === undefined) return undefined;
  const input = tokens ?? 0;
  return {
    input,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input,
    cost: {
      input: costUsd,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: costUsd,
    },
  };
}

export default function clef(pi: ExtensionAPI) {
  const backend = createRestBackend();

  pi.registerTool({
    name: "clef_judge",
    label: "Clef judge",
    description:
      "Classify a decision with Cloudflare Clef (fast, cheap, calibrated). Returns a label, its probability and a suggested routing action; " +
      'below the confidence threshold the action is always "escalate". It routes work, it never approves it.\n' +
      presetInputDoc() +
      "\nkind=raw: input is the state object and `questions` the classifier questions.",
    promptSnippet:
      "clef_judge: calibrated triage (blocker, verdict, error, finding, claim) with an escalate-below-threshold action",
    promptGuidelines: [
      "Use clef_judge to recover a verifier's verdict, check a 'done' claim against gate logs and exit codes, and triage saved run outputs, review findings and provider errors.",
      'clef_judge only routes work; treat action "escalate" (or ok:false) as a stop for a human and never as approval.',
      "Put facts (test names, exit codes, log lines, file lists) into clef_judge input, not the author's opinion; never pass secrets or API keys.",
    ],
    parameters: ClefJudgeParams,
    async execute(_toolCallId, params, signal) {
      const cwd = process.cwd();
      if (params.kind === "raw") {
        const result = await runRawClassify(
          backend,
          params.input,
          (params.questions ?? {}) as Parameters<typeof runRawClassify>[2],
          { model: params.model, signal },
        );
        const text = result.ok
          ? JSON.stringify(result.answers)
          : `ERROR: ${result.error}`;
        return {
          content: [{ type: "text", text }],
          details: result,
          usage: usageOf(result.costUsd, result.tokens),
        };
      }
      const { judgment, state } = await runJudge(
        backend,
        params.kind as JudgeKind,
        params.input,
        {
          model: params.model,
          threshold: params.threshold,
          signal,
        },
      );
      appendDecision(
        globalDecisionLog(),
        toDecisionRecord(judgment, state, { caller: "tool", cwd }),
      );
      return {
        content: [
          {
            type: "text",
            text: `${formatJudgment(judgment)}\n${JSON.stringify(judgment)}`,
          },
        ],
        details: judgment,
        usage: usageOf(judgment.costUsd, judgment.tokens),
      };
    },
  });

  pi.registerCommand("clef", {
    description:
      "Clef decision models: /clef status | test | log | mine [--dry] | setup | help",
    handler: async (rawArgs, ctx) => {
      const args = rawArgs.trim().split(/\s+/).filter(Boolean);
      const sub = args[0] ?? "status";
      if (sub === "setup") {
        ctx.ui.notify(SETUP_TEXT, "info");
        return;
      }
      if (!["status", "test", "log", "mine", "help"].includes(sub)) {
        ctx.ui.notify(
          `Unknown /clef subcommand "${sub}". Try /clef help.`,
          "error",
        );
        return;
      }
      let out = "";
      let err = "";
      const code = await main(
        sub === "help"
          ? ["help", ...args.slice(1)]
          : args.length
            ? args
            : ["status"],
        {
          backend,
          cwd: ctx.cwd,
          agentDir: agentDir(),
          stdout: (text) => {
            out += text;
          },
          stderr: (text) => {
            err += text;
          },
          // stdin is never available inside the session
          readStdin: async () => "",
        },
      );
      const text =
        [out.trim(), err.trim()].filter(Boolean).join("\n") || "(no output)";
      ctx.ui.notify(text, code === 0 ? "info" : "error");
    },
  });
}
