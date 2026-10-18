/**
 * Performance report for the brief:
 *  1. render time per frame (p50/p95/max) with 20 live agents
 *  2. resident memory after tailing a 50 MB events.jsonl incrementally
 *  3. CPU use while animating for 10 seconds
 * Run: npm run perf
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { mountHarness } from "../harness.ts";
import {
  tempDir,
  thinkingMessage,
  toolEnd,
  toolStart,
  writeEvents,
  writeStatus,
} from "../source/fixtures.ts";
import { LineTailer } from "../source/tail.ts";

const NOW = 1_800_000_000_000;
const WIDTH = 160;

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(fraction * (sorted.length - 1))),
  );
  return sorted[index];
}

function baseDir(name: string): string {
  // Every directory this tool creates is removed when the process exits: the
  // tail measurement alone writes a 50 MB events.jsonl.
  return tempDir(`agent-view-${name}-`);
}

/** One workflow with 20 running children of mixed roles. */
function buildTwentyAgents(root: string): string {
  const sessionFile = "/home/fixture/sessions/perf.jsonl";
  const workflowRunId = "cccccccc-0001-4000-8000-0000000000ff";
  const children = Array.from({ length: 20 }, (_, index) => {
    const roles = [
      "impl",
      "review",
      "fix",
      "research",
      "impl",
      "review",
      "fix",
      "scout",
    ];
    const role = roles[index % roles.length];
    return {
      childId: `${role}-P${index}`,
      runId: `dddddddd-${String(index).padStart(4, "0")}-4000-8000-000000000000`,
      agent:
        role === "review"
          ? "delegate"
          : role === "research"
            ? "researcher"
            : "worker",
      state: "running",
      role,
    };
  });
  fs.mkdirSync(root, { recursive: true });
  writeStatus(path.join(root, workflowRunId), {
    runId: workflowRunId,
    sessionId: sessionFile,
    mode: "workflow",
    state: "running",
    startedAt: NOW - 40 * 60_000,
    lastUpdate: NOW,
    cwd: "/home/fixture/perf",
    workflowChildren: {
      inventoryComplete: true,
      children: children.map(({ childId, state, runId, agent }) => ({
        childId,
        state,
        runId,
        agent,
      })),
    },
    plannedChildren: children.map((child) => child.childId),
  });
  for (const child of children) {
    const dir = path.join(root, child.runId);
    writeStatus(dir, {
      runId: child.runId,
      sessionId: sessionFile,
      mode: "single",
      state: "running",
      startedAt: NOW - (3 + (Number(child.runId.slice(9, 13)) % 12)) * 60_000,
      lastUpdate: NOW,
      parentWorkflowRunId: workflowRunId,
      workflowKey: child.childId,
      agent: child.agent,
      stepStatus: "running",
    });
    writeEvents(dir, [
      {
        type: "subagent.run.started",
        runId: child.runId,
        mode: "single",
        ts: NOW - 60_000,
      },
      thinkingMessage(
        `${child.childId}: re-reading the diff to find the crash window before I trust the fix.`,
        NOW - 8000,
      ),
      toolStart(
        "bash",
        { command: "go test -race ./internal/...".padEnd(40, "x") },
        NOW - 7000,
      ),
      toolEnd("bash", NOW - 6000),
      thinkingMessage(
        `${child.childId}: the counterexample lives in the loader; whitespace-only values are accepted.`,
        NOW - 2000,
      ),
    ]);
    fs.writeFileSync(
      path.join(dir, "output-0.log"),
      `${child.childId} output tail\n`.repeat(20),
      "utf8",
    );
  }
  return sessionFile;
}

async function measureFrames(): Promise<void> {
  const base = baseDir("perf-frames");
  const root = path.join(base, "async-subagent-runs");
  const sessionFile = buildTwentyAgents(root);
  const harness = await mountHarness({
    runsDir: root,
    historyDir: path.join(base, "history"),
    sessionFile,
    width: WIDTH,
    rows: 60,
    now: NOW,
  });

  const agents = harness.scanner.snapshot().runCount;
  const newEvents = path.join(
    root,
    "dddddddd-0010-4000-8000-000000000000",
    "events.jsonl",
  );

  // Warm up the caches (rasters, personas, template strings).
  for (let index = 0; index < 30; index += 1) {
    harness.advance(100);
    harness.tick();
    harness.component.render(WIDTH);
  }

  const renderTimes: number[] = [];
  const tickTimes: number[] = [];
  for (let index = 0; index < 300; index += 1) {
    harness.advance(100);
    // Keep the data moving so this is the real path: tail + snapshot + render.
    fs.appendFileSync(
      newEvents,
      `${JSON.stringify(thinkingMessage(`perf ${index}: still comparing the candidate fixes.`, NOW + index * 1000))}\n`,
    );
    const tickStart = performance.now();
    harness.tick();
    const renderStart = performance.now();
    harness.component.render(WIDTH);
    renderTimes.push(performance.now() - renderStart);
    tickTimes.push(performance.now() - tickStart);
  }
  harness.dispose();

  console.log(
    JSON.stringify(
      {
        section: "render",
        agents,
        frames: renderTimes.length,
        renderMs: {
          p50: percentile(renderTimes, 0.5),
          p95: percentile(renderTimes, 0.95),
          max: Math.max(...renderTimes),
        },
        tickMs: {
          p50: percentile(tickTimes, 0.5),
          p95: percentile(tickTimes, 0.95),
          max: Math.max(...tickTimes),
        },
        avatarRasters: harness.avatar?.rasterCount ?? 0,
      },
      null,
      1,
    ),
  );
}

async function measureTail(fileSizeMb: number): Promise<void> {
  const base = baseDir("perf-tail");
  const file = path.join(base, "events.jsonl");
  const chunk = Buffer.from(
    `${JSON.stringify({ type: "tool_execution_update", payload: "x".repeat(400) })}\n`,
  );
  const target = fileSizeMb * 1024 * 1024;
  let written = 0;
  const fd = fs.openSync(file, "w");
  try {
    while (written < target) {
      fs.writeSync(fd, chunk);
      written += chunk.length;
    }
  } finally {
    fs.closeSync(fd);
  }
  const before = process.memoryUsage();
  const tailer = new LineTailer(file);
  const firstPoll = tailer.poll();
  const afterOpen = process.memoryUsage();

  // Live growth: append and poll 2000 times, like a running child would.
  const append = `${JSON.stringify(thinkingMessage("one more appended line while the view is open", NOW))}\n`;
  for (let index = 0; index < 2000; index += 1) {
    fs.appendFileSync(file, append);
    tailer.poll();
  }
  const afterGrowth = process.memoryUsage();

  console.log(
    JSON.stringify(
      {
        section: "tail",
        fileSizeMb: Number((fs.statSync(file).size / (1024 * 1024)).toFixed(1)),
        firstPollLines: firstPoll.length,
        bytesReadByTailer: tailer.bytesRead,
        windowLines: tailer.recent().length,
        rssMb: {
          before: Number((before.rss / 1e6).toFixed(1)),
          afterOpen: Number((afterOpen.rss / 1e6).toFixed(1)),
          afterGrowth: Number((afterGrowth.rss / 1e6).toFixed(1)),
        },
        heapUsedMb: {
          before: Number((before.heapUsed / 1e6).toFixed(1)),
          afterGrowth: Number((afterGrowth.heapUsed / 1e6).toFixed(1)),
        },
      },
      null,
      1,
    ),
  );
}

async function measureCpu(seconds: number): Promise<void> {
  const base = baseDir("perf-cpu");
  const root = path.join(base, "async-subagent-runs");
  const sessionFile = buildTwentyAgents(root);
  const harness = await mountHarness({
    runsDir: root,
    historyDir: path.join(base, "history"),
    sessionFile,
    width: WIDTH,
    rows: 60,
    now: NOW,
  });
  let frames = 0;
  const requestRender = harness.tui.requestRender.bind(harness.tui);
  harness.tui.requestRender = () => {
    requestRender();
    harness.component.render(WIDTH);
    frames += 1;
  };
  harness.component.start();
  const cpuBefore = process.cpuUsage();
  const wallStart = Date.now();
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  const cpu = process.cpuUsage(cpuBefore);
  const wall = (Date.now() - wallStart) / 1000;
  harness.component.dispose();

  const cpuSeconds = (cpu.user + cpu.system) / 1e6;
  console.log(
    JSON.stringify(
      {
        section: "cpu",
        seconds: wall,
        frames,
        fps: Number((frames / wall).toFixed(1)),
        cpuSeconds: Number(cpuSeconds.toFixed(3)),
        percentOfOneCore: Number(((cpuSeconds / wall) * 100).toFixed(1)),
        clockPeriodMs: 100,
      },
      null,
      1,
    ),
  );
}

const mode = process.argv[2] ?? "all";
if (mode === "all" || mode === "render") await measureFrames();
if (mode === "all" || mode === "tail") await measureTail(50);
if (mode === "all" || mode === "cpu") await measureCpu(10);
