/**
 * One-off (and repeatable) cleanup of `~/.pi/agent/agent-view/durations.json`.
 *
 * Before the P2 fix the duration book recorded every terminal run, including
 * failed ones: two 18-second rate-limited reviews poisoned the `review` median
 * (18 461 ms and 18 136 ms against a real median around 750 000 ms). This tool
 * walks the recorded run ids, drops the samples of any run that is not
 * `isDoneState`, backs the file up first and writes it back atomically.
 *
 *   npm run prune-durations [-- --history <dir> --runs <dir> --dry-run]
 *
 * Env: AGENT_VIEW_HOME / AGENT_VIEW_RUNS_DIR (same as the extension).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { detectRole } from "../persona.ts";
import { defaultHistoryDir } from "../source/history.ts";
import { defaultRunsDir } from "../source/runs.ts";
import { isDoneState } from "../source/types.ts";

interface DurationsFile {
  version: 1;
  roles: Record<string, number[]>;
  recorded: Record<string, number>;
  updatedAt: number;
}

interface StatusLike {
  runId?: string;
  mode?: string;
  state?: string;
  startedAt?: number;
  endedAt?: number;
  lastUpdate?: number;
  workflowKey?: string;
  steps?: {
    agent?: string;
    status?: string;
    label?: string;
    durationMs?: number;
  }[];
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const inline = process.argv.find((entry) => entry.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

/** One sample this run contributed, or nothing when it cannot be attributed. */
function samplesOf(
  runId: string,
  status: StatusLike | undefined,
): { role: string; durationMs: number }[] {
  if (!status) return [];
  const steps = status.steps ?? [];
  if (steps.length > 1) {
    const samples: { role: string; durationMs: number }[] = [];
    for (const step of steps) {
      if (step.durationMs === undefined || step.durationMs <= 0) continue;
      samples.push({
        role: detectRole(step.label ?? runId, step.agent ?? "delegate"),
        durationMs: step.durationMs,
      });
    }
    return samples;
  }
  const startedAt = status.startedAt;
  const endedAt = status.endedAt ?? status.lastUpdate;
  const durationMs =
    startedAt !== undefined && endedAt !== undefined
      ? endedAt - startedAt
      : (steps[0]?.durationMs ?? 0);
  if (durationMs <= 0) return [];
  return [
    {
      role: detectRole(
        status.workflowKey ?? runId,
        steps[0]?.agent ?? "delegate",
      ),
      durationMs,
    },
  ];
}

const historyDir =
  argument("--history") ?? process.env.AGENT_VIEW_HOME ?? defaultHistoryDir();
const runsDir =
  argument("--runs") ?? process.env.AGENT_VIEW_RUNS_DIR ?? defaultRunsDir();
const dryRun = process.argv.includes("--dry-run");
const file = path.join(historyDir, "durations.json");

let data: DurationsFile;
try {
  data = JSON.parse(fs.readFileSync(file, "utf8")) as DurationsFile;
} catch (cause) {
  process.stderr.write(
    `prune-durations: cannot read ${file}: ${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  process.exit(1);
}
if (data.version !== 1 || typeof data.roles !== "object") {
  process.stderr.write(`prune-durations: ${file} is not a v1 durations file\n`);
  process.exit(1);
}

const roles = new Map<string, number[]>(
  Object.entries(data.roles).map(([role, samples]) => [role, [...samples]]),
);
const recorded = new Map<string, number>(Object.entries(data.recorded ?? {}));

const removed: { runId: string; role: string; durationMs: number }[] = [];
let kept = 0;
let unknown = 0;
let dropped = 0;
for (const runId of [...recorded.keys()]) {
  let status: StatusLike | undefined;
  try {
    status = JSON.parse(
      fs.readFileSync(path.join(runsDir, runId, "status.json"), "utf8"),
    ) as StatusLike;
  } catch {
    status = undefined;
  }
  if (!status) {
    // The run dir is gone (retention): its samples cannot be attributed.
    unknown += 1;
    continue;
  }
  if (isDoneState(status.state ?? "")) {
    kept += 1;
    continue;
  }
  dropped += 1;
  for (const sample of samplesOf(runId, status)) {
    const samples = roles.get(sample.role);
    const index = samples?.indexOf(sample.durationMs) ?? -1;
    if (samples && index >= 0) {
      samples.splice(index, 1);
      removed.push({ runId, role: sample.role, durationMs: sample.durationMs });
    }
  }
  recorded.delete(runId);
}

for (const [role, samples] of roles) {
  if (samples.length === 0) roles.delete(role);
}

const before = Object.values(data.roles).reduce(
  (sum, samples) => sum + samples.length,
  0,
);
const after = [...roles.values()].reduce(
  (sum, samples) => sum + samples.length,
  0,
);
process.stdout.write(
  `prune-durations: ${file}\n` +
    `  samples ${before} -> ${after} (removed ${removed.length})\n` +
    `  recorded runs: kept ${kept}, dropped ${dropped}, unattributable ${unknown}\n` +
    removed
      .map(
        (entry) =>
          `  removed ${entry.role} ${entry.durationMs}ms from ${entry.runId}\n`,
      )
      .join(""),
);

if (dryRun) {
  process.stdout.write("prune-durations: dry run, nothing written\n");
  process.exit(0);
}

if (removed.length === 0) {
  process.stdout.write("prune-durations: nothing to prune, file left as is\n");
  process.exit(0);
}

try {
  const backup = `${file}.bak-${Date.now()}`;
  fs.copyFileSync(file, backup);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(
    tmp,
    `${JSON.stringify(
      {
        version: 1,
        roles: Object.fromEntries(
          [...roles.entries()].sort((left, right) =>
            left[0].localeCompare(right[0]),
          ),
        ),
        recorded: Object.fromEntries(recorded),
        updatedAt: Date.now(),
      } satisfies DurationsFile,
      null,
      1,
    )}\n`,
    "utf8",
  );
  fs.renameSync(tmp, file);
  process.stdout.write(`prune-durations: backup at ${backup}\n`);
} catch (cause) {
  process.stderr.write(
    `prune-durations: write failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  process.exit(1);
}
