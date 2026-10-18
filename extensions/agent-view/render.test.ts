/**
 * Render harness: mounts AgentViewComponent with a fake TUI, a fake theme, a
 * fixture runs directory and a fake clock, then snapshots the plain-text frames.
 * Golden files for the avatar-less widths live in snapshots/ and are rewritten
 * with UPDATE_SNAPSHOTS=1.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mountHarness, stripAnsiLines, type Harness } from "./harness.ts";
import {
  addRun,
  appendEvents,
  buildFixtureWorld,
  tempDir,
  thinkingMessage,
  toolStart,
  writeChildLine,
  writeEvents,
  writeStatus,
  type FixtureWorld,
} from "./source/fixtures.ts";

const NOW = 1_800_000_000_000;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const SNAPSHOT_DIR = path.join(HERE, "snapshots");
const ARTIFACT_DIR = path.join(HERE, "test-artifacts");

interface Mounted {
  base: string;
  fixture: FixtureWorld;
  harness: Harness;
}

async function mount(
  options: {
    width?: number;
    rows?: number;
    noColor?: boolean;
    reducedMotion?: boolean;
    withAvatar?: boolean;
    empty?: boolean;
    world?: FixtureWorld;
  } = {},
): Promise<Mounted> {
  const base = tempDir("agent-view-render-");
  const root = path.join(base, "async-subagent-runs");
  const fixture = options.world ?? buildFixtureWorld(root, NOW);
  const harness = await mountHarness({
    runsDir: root,
    historyDir: path.join(base, "history"),
    sessionFile: fixture.sessionFile,
    width: options.width ?? 120,
    rows: options.rows ?? 36,
    now: NOW,
    ...(options.noColor !== undefined ? { noColor: options.noColor } : {}),
    ...(options.reducedMotion !== undefined
      ? { reducedMotion: options.reducedMotion }
      : {}),
    ...(options.withAvatar !== undefined
      ? { withAvatar: options.withAvatar }
      : {}),
  });
  return { base, fixture, harness };
}

function writeArtifact(name: string, lines: string[]): void {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, name),
    `${lines.join("\n")}\n`,
    "utf8",
  );
}

async function snapshot(width: number, name: string): Promise<string[]> {
  const { harness } = await mount({ width, rows: 40 });
  // One frame to seed the typewriter, then let it finish, so the golden shows a
  // settled frame instead of a bubble that has not been typed yet.
  harness.frame(width);
  harness.advance(4000);
  harness.tick();
  const lines = harness.frameText(width);
  writeArtifact(name, lines);
  const golden = path.join(SNAPSHOT_DIR, name);
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(golden, `${lines.join("\n")}\n`, "utf8");
    return lines;
  }
  if (!fs.existsSync(golden)) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(golden, `${lines.join("\n")}\n`, "utf8");
    return lines;
  }
  const expected = fs
    .readFileSync(golden, "utf8")
    .replace(/\n$/, "")
    .split("\n");
  assert.deepEqual(
    lines,
    expected,
    `snapshot ${name} changed (UPDATE_SNAPSHOTS=1 to accept)`,
  );
  return lines;
}

test("frames fit every width tier and carry no escape sequence beyond the line", async () => {
  for (const width of [60, 80, 120, 160]) {
    const { harness } = await mount({ width });
    const lines = harness.frame(width);
    assert.ok(lines.length > 0);
    for (const [index, line] of lines.entries()) {
      assert.ok(
        visibleWidth(line) <= width,
        `width ${width} line ${index}: ${visibleWidth(line)} cols`,
      );
    }
    // The plain-text snapshot must not contain stray SGR leftovers either: a
    // styled string sliced by visible characters leaves a bare `[38;5;67m`.
    for (const line of stripAnsiLines(lines)) {
      assert.equal(line.includes("\x1b"), false);
      assert.doesNotMatch(line, /\[\d+(;\d+)*m/, line);
    }
  }
});

test("snapshots at 60 and 80 columns (small avatar tier, one-line bubbles)", async () => {
  const narrow = await snapshot(60, "frame-60.txt");
  const medium = await snapshot(80, "frame-80.txt");
  assert.ok(narrow.join("\n").includes("Agents"), "header present");
  assert.equal(
    medium.some((line) => line.includes("╶┬")),
    true,
    "a workflow tree header is visible",
  );
  // The 60-99 tier keeps an 8 px avatar and never a two-line bubble.
  for (const line of [...narrow, ...medium]) {
    for (const block of line.match(/[▀▄]+/g) ?? [])
      assert.ok(block.length <= 8, `avatar run ${block.length} > 8`);
  }
});

test("wide frames draw half-block avatars and the workflow progress bar", async () => {
  const { harness } = await mount({ width: 140 });
  const lines = harness.frameText(140);
  writeArtifact("frame-140.txt", lines);
  const flat = lines.join("\n");
  assert.ok(
    flat.includes("▀") || flat.includes("▄"),
    "half-block avatar pixels",
  );
  assert.ok(flat.includes("▕"), "progress bar");
  assert.ok(flat.includes("left") || flat.includes("complete"), "eta label");
  assert.ok(/~\d+%/.test(flat), "estimated percentage");
});

test("the two-column grid activates at 140 columns", async () => {
  const { harness } = await mount({ width: 139 });
  const single = harness.frameText(139);
  const wide = await mount({ width: 160 });
  const grid = wide.harness.frameText(160);
  // In the grid the two workflow headers of one row sit on the same line.
  const gridHeader = grid.find(
    (line) => (line.match(/╶┬/g) ?? []).length === 2,
  );
  assert.ok(gridHeader, "two workflows on one row");
  assert.equal(
    single.some((line) => (line.match(/╶┬/g) ?? []).length === 2),
    false,
  );
});

test("bubbles keep their width while the typewriter types", async () => {
  const { harness } = await mount({ width: 120 });
  const boxWidths = () => {
    const frame = stripAnsiLines(harness.frame(120));
    return frame
      .filter((line) => line.includes("╭"))
      .map((line) => visibleWidth(line.slice(line.indexOf("╭"))));
  };
  const first = boxWidths();
  assert.ok(first.length > 0, "at least one bubble is visible");
  harness.advance(300);
  harness.tick();
  assert.deepEqual(boxWidths(), first);
  harness.advance(400);
  harness.tick();
  assert.deepEqual(boxWidths(), first);
});

test("persona names on one frame are unique and every row keeps its stable key", async () => {
  const single = await mount({ width: 120 });
  const names = single.harness.component.personaNames();
  assert.equal(new Set(names).size, names.length, names.join(","));
  const frame = single.harness.frameText(120).join("\n");
  const drawn = [...frame.matchAll(/([A-Z][a-zA-Z]+) the [A-Z]/g)].map(
    (match) => match[1],
  );
  assert.ok(drawn.length > 0, frame);
  assert.equal(new Set(drawn).size, drawn.length, drawn.join(","));
  assert.ok(frame.includes("[impl-AF1]"), "the stable child key stays visible");

  // In the two-column grid a card sheds `the <noun>` first; the key survives.
  const grid = await mount({ width: 160 });
  const gridFrame = grid.harness.frameText(160).join("\n");
  assert.ok(gridFrame.includes("[impl-AF1]"), gridFrame);
  assert.ok(gridFrame.includes("[stage-2]"), gridFrame);
  const gridNames = grid.harness.component.personaNames();
  assert.equal(new Set(gridNames).size, gridNames.length, gridNames.join(","));
  single.harness.dispose();
  grid.harness.dispose();
});

test("a promotion draws a fresh name, flourishes once and settles", async () => {
  // An empty world keeps the promotion deterministic: one agent, one gate crossed.
  const base = tempDir("agent-view-promo-");
  const root = path.join(base, "async-subagent-runs");
  fs.mkdirSync(root, { recursive: true });
  const harness = await mountHarness({
    runsDir: root,
    historyDir: path.join(base, "history"),
    sessionFile: "/home/fixture/sessions/session-a.jsonl",
    width: 120,
    rows: 60,
    now: NOW,
  });
  addRun(root, {
    runId: "abcdabcd-0001-4000-8000-000000000001",
    sessionId: "/home/fixture/sessions/session-a.jsonl",
    mode: "single",
    state: "running",
    startedAt: NOW,
    lastUpdate: NOW,
    cwd: "/home/fixture/promotion",
    agent: "worker",
    workflowKey: "impl-promo",
  });
  harness.tick();
  const before = harness.component.personaNames();
  assert.equal(before.length, 1);

  // Six minutes of the 20-minute default for a builder crosses the 25% gate.
  harness.advance(6 * 60_000);
  harness.tick();
  const frame = harness.frameText(120).join("\n");
  assert.equal((frame.match(/promoted to Squire!/g) ?? []).length, 1, frame);
  assert.equal((frame.match(/is now/g) ?? []).length, 1, frame);
  assert.equal(frame.includes("~30%"), true, frame);

  const after = harness.component.personaNames();
  assert.equal(new Set(after).size, after.length, after.join(","));
  assert.notDeepEqual(after, before, "the promotion draws a fresh name");

  harness.advance(6000);
  harness.tick();
  const settled = harness.frameText(120).join("\n");
  assert.equal(
    settled.includes("is now"),
    false,
    "the flourish ends after 5.6s",
  );
  assert.ok(settled.includes(after[0]), "the promoted persona stays");
});

test("NO_COLOR and reduced motion freeze the art and skip redraws", async () => {
  for (const options of [{ noColor: true }, { reducedMotion: true }]) {
    const { harness } = await mount({ width: 120, ...options });
    harness.tick();
    const rendersAfterTick = harness.tui.renders;
    const first = harness.frame(120);
    assert.deepEqual(
      harness.frame(120),
      first,
      "the same tick renders the same frame",
    );
    harness.advance(250);
    harness.tick();
    harness.advance(250);
    harness.tick();
    assert.equal(
      harness.tui.renders,
      rendersAfterTick,
      "no redraw request while only time moves",
    );
    const artKey = (lines: string[]) =>
      lines
        .map((line) => line.replace(/[0-9]+(?:m[0-9]+s|s|%)?/g, "#"))
        .map((line) => line.replace(/[█▏▎▍▌▋▊▉]+/g, "▮"));
    assert.deepEqual(
      artKey(harness.frame(120)),
      artKey(first),
      "only data-derived text moved",
    );
    if (options.noColor) {
      for (const line of first)
        assert.equal(line.includes("\x1b"), false, line);
    }
  }

  const lively = await mount({ width: 120 });
  lively.harness.tick();
  const renders = lively.harness.tui.renders;
  lively.harness.advance(100);
  lively.harness.tick();
  assert.equal(
    lively.harness.tui.renders,
    renders + 1,
    "exactly one render request per animated tick",
  );
});

test("NO_COLOR output never draws avatars", async () => {
  const { harness } = await mount({ width: 160, noColor: true });
  const lines = harness.frameText(160);
  assert.equal(
    lines.some((line) => line.includes("▀") || line.includes("▄")),
    false,
  );
  assert.equal(
    lines.some((line) => line.includes("\x1b")),
    false,
  );
});

test("a run directory created after the mount appears on the next refresh", async () => {
  const { harness, base } = await mount({ width: 120, rows: 200 });
  const before = harness.frameText(120).join("\n");
  assert.equal(before.includes("claude-haiku"), false);
  addRun(path.join(base, "async-subagent-runs"), {
    runId: "beefbeef-0001-4000-8000-000000000001",
    sessionId: "/home/fixture/sessions/session-a.jsonl",
    mode: "single",
    state: "running",
    startedAt: NOW - 30_000,
    lastUpdate: NOW,
    cwd: "/home/fixture/late-arrival",
    agent: "researcher",
    model: "anthropic/claude-haiku-4-5:low",
    workflowKey: "research-late",
  });
  harness.advance(1000);
  harness.tick();
  const after = harness.frameText(120).join("\n");
  assert.ok(after.includes("claude-haiku"), after);
  assert.ok(after.includes("late-arrival"), after);
});

test("with nothing running the view is a calm idle scene that wakes up", async () => {
  const base = tempDir("agent-view-idle-");
  const root = path.join(base, "async-subagent-runs");
  fs.mkdirSync(root, { recursive: true });
  const harness = await mountHarness({
    runsDir: root,
    historyDir: path.join(base, "history"),
    sessionFile: "/home/fixture/sessions/session-a.jsonl",
    width: 120,
    now: NOW,
  });
  const idle = harness.frameText(120).join("\n");
  assert.ok(idle.includes("nothing running · no runs for this session"), idle);
  assert.ok(
    idle.includes("▀") || idle.includes("▄"),
    "a sleeping avatar is drawn",
  );
  // The idle bubble is a real bubble: closed box, arrow tail, one width.
  const boxRows = idle.split("\n").filter((line) => /[╭│╰]/.test(line));
  assert.equal(boxRows.length, 3, idle);
  assert.ok(boxRows[0].includes("╭") && boxRows[0].includes("╮"), boxRows[0]);
  assert.ok(
    boxRows[1].includes("│") && boxRows[1].trimEnd().endsWith("│"),
    boxRows[1],
  );
  assert.ok(boxRows[2].includes("╰") && boxRows[2].includes("╯"), boxRows[2]);
  assert.ok(boxRows[1].includes("◂─"), "the bubble points at the avatar");
  harness.dispose();

  const world = buildFixtureWorld(root, NOW);
  const awake = await mountHarness({
    runsDir: root,
    historyDir: path.join(base, "history"),
    sessionFile: world.sessionFile,
    width: 120,
    now: NOW,
  });
  assert.equal(
    awake.frameText(120).join("\n").includes("nothing running"),
    false,
  );
  awake.dispose();
});

test("selection moves with the arrow keys and keeps the selected agent in view", async () => {
  const { harness } = await mount({ width: 120, rows: 20 });
  const first = harness.component.selectedChildKey;
  harness.component.handleInput("\x1b[B");
  assert.notEqual(harness.component.selectedChildKey, first);
  assert.ok(harness.tui.renders > 0, "input requests a render");

  harness.component.handleInput("f");
  const frame = harness.frameText(120).join("\n");
  assert.equal(
    frame.includes("✓ done"),
    false,
    "running-only hides finished children",
  );
  harness.component.handleInput("f");
});

test("Enter opens the inline detail pane with the tail of output-0.log and Esc closes it", async () => {
  const { harness } = await mount({ width: 120 });
  harness.component.handleInput("f");
  for (let index = 0; index < 3; index += 1)
    harness.component.handleInput("\x1b[B");
  harness.component.handleInput("\r");
  const detail = harness.frameText(120).join("\n");
  assert.ok(detail.includes("Detail ·"), detail);
  assert.ok(detail.includes("output-0.log"), detail);
  harness.component.handleInput("\x1b");
  const back = harness.frameText(120).join("\n");
  assert.equal(back.includes("Detail ·"), false);
});

test("the detail pane keeps the output file name visible under a long runs path", async () => {
  // A long TMPDIR (the Pi launcher's per-session root) once clipped the file
  // name off the detail path row.
  const previous = process.env.TMPDIR;
  const longBase = path.join(os.tmpdir(), "agent-view-long-" + "x".repeat(120));
  fs.mkdirSync(longBase, { recursive: true });
  process.env.TMPDIR = longBase;
  try {
    const { harness } = await mount({ width: 120 });
    harness.component.handleInput("f");
    for (let index = 0; index < 3; index += 1)
      harness.component.handleInput("\x1b[B");
    harness.component.handleInput("\r");
    const lines = harness.frameText(120);
    const pathLine = lines.find((line) => line.includes("output-0.log"));
    assert.ok(pathLine, lines.join("\n"));
    assert.ok(pathLine.trimEnd().endsWith("output-0.log"), pathLine);
    assert.ok(visibleWidth(pathLine) <= 120);
    harness.dispose();
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    fs.rmSync(longBase, { recursive: true, force: true });
  }
});

test("the avatar size keys change the avatar size", async () => {
  const { harness } = await mount({ width: 160 });
  const before = harness.component.statistics;
  assert.equal(before.avatarPx, 14);
  const firstFrame = harness.frame(160);
  harness.component.handleInput("+");
  assert.equal(harness.component.statistics.avatarPx, 16);
  const biggerFrame = harness.frame(160);
  assert.notDeepEqual(biggerFrame, firstFrame);
  assert.ok(
    harness.component.statistics.rasterCount >= before.rasterCount,
    "a new pixel size is rasterised",
  );
  harness.component.handleInput("-");
  harness.component.handleInput("-");
  assert.equal(harness.component.statistics.avatarPx, 12);
  assert.notDeepEqual(harness.frame(160), biggerFrame);
});

test("q closes the component and stops the clock", async () => {
  const { harness } = await mount({ width: 120 });
  let closed = false;
  const component = harness.component;
  // `handleInput("q")` calls the done callback supplied to the component; the
  // harness passes a no-op, so observe dispose() indirectly via the clock.
  component.handleInput("q");
  closed = true;
  assert.equal(closed, true);
  assert.doesNotThrow(() => component.dispose());
});

test("a missing runs directory is no runs on disk, never a scan error", async () => {
  const base = tempDir("agent-view-missing-");
  const harness = await mountHarness({
    runsDir: path.join(base, "does-not-exist"),
    historyDir: path.join(base, "history"),
    sessionFile: "/home/fixture/sessions/session-a.jsonl",
    width: 120,
    now: NOW,
  });
  const frame = harness.frameText(120).join("\n");
  assert.equal(frame.includes("scan error"), false, frame);
  assert.equal(frame.includes("ENOENT"), false, frame);
  assert.ok(
    frame.includes("nothing running · no runs for this session"),
    frame,
  );
  harness.dispose();
});

test("F9: finished runs from other sessions are not 'no runs on disk'", async () => {
  const base = tempDir("agent-view-other-finished-");
  const root = path.join(base, "async-subagent-runs");
  addRun(root, {
    runId: "ac000000-0001-4000-8000-000000000001",
    sessionId: "/home/fixture/sessions/other-session.jsonl",
    mode: "single",
    state: "complete",
    startedAt: NOW - 60 * 60_000,
    endedAt: NOW - 30 * 60_000,
    lastUpdate: NOW - 30 * 60_000,
    cwd: "/home/fixture/elsewhere",
    agent: "worker",
  });
  const harness = await mountHarness({
    runsDir: root,
    historyDir: path.join(base, "history"),
    sessionFile: SESSION,
    width: 120,
    now: NOW,
  });
  const idle = harness.frameText(120).join("\n");
  assert.ok(idle.includes("nothing running"), idle);
  // The session-filtered snapshot is empty, but the directory is not.
  assert.equal(idle.includes("no runs on disk"), false, idle);
  assert.ok(idle.includes("no runs for this session"), idle);
  harness.dispose();
});

test("the frame is deterministic for the same inputs", async () => {
  const first = await mount({ width: 160 });
  const second = await mount({ width: 160 });
  assert.deepEqual(first.harness.frame(160), second.harness.frame(160));
  first.harness.dispose();
  second.harness.dispose();
});

// --- Regression tests for the review findings (REVIEW-1 P0..P3) ---------------

const SESSION = "/home/fixture/sessions/session-a.jsonl";

async function mountWorld(
  build: (root: string, now: number) => { sessionFile: string },
  options: {
    width?: number;
    rows?: number;
    now?: number;
    noColor?: boolean;
  } = {},
): Promise<{ base: string; root: string; harness: Harness }> {
  const base = tempDir("agent-view-world-");
  const root = path.join(base, "async-subagent-runs");
  fs.mkdirSync(root, { recursive: true });
  const now = options.now ?? NOW;
  const world = build(root, now);
  const harness = await mountHarness({
    runsDir: root,
    historyDir: path.join(base, "history"),
    sessionFile: world.sessionFile,
    width: options.width ?? 120,
    rows: options.rows ?? 36,
    now,
    ...(options.noColor !== undefined ? { noColor: options.noColor } : {}),
  });
  return { base, root, harness };
}

function finishedRun(
  root: string,
  runId: string,
  name: string,
  minutesAgo: number,
  now = NOW,
): void {
  addRun(root, {
    runId,
    sessionId: SESSION,
    mode: "single",
    state: "complete",
    startedAt: now - minutesAgo * 60_000 - 10 * 60_000,
    endedAt: now - minutesAgo * 60_000,
    lastUpdate: now - minutesAgo * 60_000,
    cwd: "/home/fixture/arena-fix",
    agent: "worker",
    sessionName: name,
    stepStatus: "completed",
  });
}

test("the live board splits Now (full cards) from Recent (one line per finished root)", async () => {
  const { harness } = await mount({ width: 120, rows: 200 });
  const frame = harness.frameText(120).join("\n");
  assert.ok(frame.includes("Now · "), frame);
  assert.ok(frame.includes("Recent · "), frame);
  // The finished root is a one-line history row with its age.
  const recentLine = harness
    .frameText(120)
    .find((line) => line.includes("fixture arena fix, round one"));
  assert.ok(recentLine, frame);
  assert.match(recentLine, /✓ .*complete.*ended .*ago.*22m00s/, recentLine);
  assert.ok(recentLine.includes("$1.25"), recentLine);
  assert.ok(recentLine.includes("20.1k tok"), recentLine);
  // The live workflow stays a full card with a tree.
  assert.ok(frame.includes("╶┬ arena-fix · AF1→AF4"), frame);
  harness.dispose();
});

test("Recent is capped at 5 and h expands it", async () => {
  const { harness, root } = await mountWorld((root, now) => {
    for (let index = 0; index < 6; index += 1) {
      finishedRun(
        root,
        `b1000000-000${index}-4000-8000-000000000000`,
        `worker: finished run ${index}`,
        index + 1,
        now,
      );
    }
    return { sessionFile: SESSION };
  });
  const collapsed = harness.frameText(120).join("\n");
  assert.ok(collapsed.includes("5 of 6 finished"), collapsed);
  assert.ok(collapsed.includes("… 1 more finished run ·"), collapsed);
  assert.equal(
    (collapsed.match(/worker: finished run/g) ?? []).length,
    5,
    collapsed,
  );
  harness.component.handleInput("h");
  const expanded = harness.frameText(120).join("\n");
  assert.ok(expanded.includes("6 of 6 finished"), expanded);
  assert.equal(
    (expanded.match(/worker: finished run/g) ?? []).length,
    6,
    expanded,
  );
  harness.dispose();
  void root;
});

test("the idle scene names the last finish, and f is never a blank pane", async () => {
  const { harness } = await mountWorld((root, now) => {
    finishedRun(
      root,
      "b2000000-0001-4000-8000-000000000001",
      "worker: old run",
      134,
      now,
    );
    return { sessionFile: SESSION };
  });
  const idle = harness.frameText(120).join("\n");
  assert.ok(idle.includes("nothing running · last finished 2h14m ago"), idle);
  assert.ok(idle.includes("Recent · "), idle);
  assert.ok(idle.includes("worker: old run"), idle);

  harness.component.handleInput("f");
  const filtered = harness.frameText(120);
  assert.ok(
    filtered.join("\n").includes("nothing running"),
    filtered.join("\n"),
  );
  assert.equal(
    filtered.some((line) => line.trim().length > 0),
    true,
    "f with nothing running must not be blank",
  );
  assert.equal(
    filtered.join("\n").includes("worker: old run"),
    false,
    "running-only hides the Recent list",
  );
  harness.dispose();
});

test("a stale run is not live, carries no ETA and shows up as a history row", async () => {
  const { harness } = await mountWorld((root, now) => {
    addRun(root, {
      runId: "b3000000-0001-4000-8000-000000000001",
      sessionId: SESSION,
      mode: "single",
      state: "running",
      startedAt: now - 3 * 60 * 60_000,
      lastUpdate: now - 3 * 60 * 60_000,
      lastActivityAt: now - 3 * 60 * 60_000,
      cwd: "/home/fixture/haunted",
      agent: "worker",
      sessionName: "worker: ghost run",
      pid: 999999,
      marker: false,
    });
    return { sessionFile: SESSION };
  });
  const frame = harness.frameText(120).join("\n");
  assert.ok(frame.includes("nothing running"), frame);
  const line = harness
    .frameText(120)
    .find((candidate) => candidate.includes("ghost run"));
  assert.ok(line, frame);
  assert.ok(line.includes("stale"), line);
  assert.equal(line.includes("left"), false, "a stale run gets no ETA");
  assert.equal(line.includes("~"), false, "a stale run gets no estimate");
  harness.dispose();
});

test("a failed root says failed after <dur>, stopped and unknown states are their own", async () => {
  const { harness } = await mountWorld((root, now) => {
    const cases: [string, string, string][] = [
      ["b4000000-0001-4000-8000-000000000001", "failed", "done 0"],
      ["b4000000-0002-4000-8000-000000000002", "stopped", "done 0"],
      ["b4000000-0003-4000-8000-000000000003", "frobnicating", "done 0"],
    ];
    for (const [runId, state] of cases) {
      addRun(root, {
        runId,
        sessionId: SESSION,
        mode: "single",
        state,
        startedAt: now - 40 * 60_000,
        endedAt: now - 10 * 60_000,
        lastUpdate: now - 10 * 60_000,
        cwd: "/home/fixture/arena-fix",
        agent: "delegate",
        sessionName: `worker: ${state} root`,
        stepStatus: state,
      });
    }
    return { sessionFile: SESSION };
  });
  const frame = harness.frameText(120).join("\n");
  assert.ok(frame.includes("failed after 30m00s"), frame);
  assert.equal(
    frame.includes("100% · complete"),
    false,
    "a failed workflow is never 100 % complete",
  );
  assert.ok(frame.includes("stopped after 30m00s"), frame);
  assert.ok(frame.includes("frobnicating after 30m00s"), frame);
  const unknown = harness
    .frameText(120)
    .find((line) => line.includes("frobnicating root"));
  assert.ok(unknown?.trimStart().startsWith("?"), unknown ?? frame);
  harness.dispose();
});

test("a stopped child renders as stopped, never as done", async () => {
  const { harness } = await mountWorld((root, now) => {
    const workflowRunId = "b5000000-0001-4000-8000-000000000001";
    const childRunId = "b5000000-0002-4000-8000-000000000002";
    writeStatus(path.join(root, workflowRunId), {
      runId: workflowRunId,
      sessionId: SESSION,
      mode: "workflow",
      state: "running",
      startedAt: now - 30 * 60_000,
      lastUpdate: now - 1000,
      lastActivityAt: now - 1000,
      cwd: "/home/fixture/arena-fix",
      workflowChildren: {
        inventoryComplete: true,
        children: [
          {
            childId: "review-AF4-0",
            state: "stopped",
            runId: childRunId,
            agent: "delegate",
          },
        ],
      },
    });
    writeChildLine(path.join(root, workflowRunId), {
      type: "start",
      key: "review-AF4-0",
      runId: childRunId,
    });
    writeStatus(path.join(root, childRunId), {
      runId: childRunId,
      sessionId: SESSION,
      mode: "single",
      state: "stopped",
      startedAt: now - 20 * 60_000,
      endedAt: now - 5 * 60_000,
      lastUpdate: now - 5 * 60_000,
      agent: "delegate",
      parentWorkflowRunId: workflowRunId,
      workflowKey: "review-AF4-0",
      stepStatus: "stopped",
    });
    writeEvents(path.join(root, childRunId), []);
    return { sessionFile: SESSION };
  });
  const frame = harness.frameText(120).join("\n");
  assert.ok(frame.includes("○ stopped"), frame);
  assert.ok(frame.includes("[review-AF4-0]"), frame);
  // The stopped child is not done and not running: the row never says "done".
  assert.equal(frame.includes("✓ done"), false, frame);
  harness.dispose();
});

test("a failed child does not rank up and the unknown total gets an indeterminate bar", async () => {
  const { harness } = await mount({ width: 160, rows: 60 });
  const frame = harness.frameText(160).join("\n");
  // The fixture failed child (review-AF3-0) sits at Page, not Banneret.
  const failedRow = harness
    .frameText(160)
    .find((line) => line.includes("[review-AF3-0]"));
  assert.ok(failedRow, frame);
  assert.ok(failedRow.includes("♙ Page"), failedRow);
  assert.equal(failedRow.includes("♛ Banneret"), false, failedRow);
  // The fixture workflow has a partial inventory: indeterminate bar + done/seen.
  assert.ok(frame.includes("4/9 done · total unknown"), frame);
  harness.dispose();
});

test("two workflows sharing review-AF4-0 keep one selection and open the right output", async () => {
  const ids = {
    workflowA: "b6000000-0001-4000-8000-000000000001",
    childA: "b6000000-0002-4000-8000-000000000002",
    workflowB: "b6000000-0003-4000-8000-000000000003",
    childB: "b6000000-0004-4000-8000-000000000004",
  };
  const { harness } = await mountWorld((root, now) => {
    for (const [workflowRunId, childRunId] of [
      [ids.workflowA, ids.childA],
      [ids.workflowB, ids.childB],
    ] as const) {
      writeStatus(path.join(root, workflowRunId), {
        runId: workflowRunId,
        sessionId: SESSION,
        mode: "workflow",
        state: "running",
        startedAt: now - 30 * 60_000,
        lastUpdate: now - 1000,
        lastActivityAt: now - 1000,
        cwd: `/home/fixture/${workflowRunId === ids.workflowA ? "arena-fix" : "arena-fix-two"}`,
        workflowChildren: {
          inventoryComplete: true,
          children: [
            {
              childId: "review-AF4-0",
              state: "running",
              runId: childRunId,
              agent: "delegate",
            },
          ],
        },
      });
      writeChildLine(path.join(root, workflowRunId), {
        type: "start",
        key: "review-AF4-0",
        runId: childRunId,
      });
      writeStatus(path.join(root, childRunId), {
        runId: childRunId,
        sessionId: SESSION,
        mode: "single",
        state: "running",
        startedAt: now - 10 * 60_000,
        lastUpdate: now - 1000,
        lastActivityAt: now - 1000,
        agent: "delegate",
        parentWorkflowRunId: workflowRunId,
        workflowKey: "review-AF4-0",
        stepStatus: "running",
      });
      writeEvents(path.join(root, childRunId), []);
    }
    return { sessionFile: SESSION };
  });

  // The marker prefixes every row of the selected card, so count it only on the
  // header rows (the rows that carry the key).
  const markerCount = () =>
    (
      harness
        .frameText(160)
        .filter((line) => line.includes("[review-AF4-0]"))
        .join("\n")
        .match(/›/g) ?? []
    ).length;
  assert.equal(
    harness.component.selectedChildKey,
    `${ids.workflowA}/review-AF4-0`,
  );
  assert.equal(markerCount(), 1);
  harness.component.handleInput("\x1b[B");
  assert.equal(
    harness.component.selectedChildKey,
    `${ids.workflowB}/review-AF4-0`,
    "selection moves to the second workflow's row, not back to the first",
  );
  assert.equal(
    markerCount(),
    1,
    "the marker never duplicates across workflows",
  );

  harness.component.handleInput("\r");
  const detail = harness.frameText(160).join("\n");
  assert.ok(detail.includes("Detail ·"), detail);
  assert.ok(
    detail.includes(ids.childB),
    `Enter must open the selected workflow's child: ${detail}`,
  );
  harness.dispose();
});

test("the overlay maxHeight keeps the key hints and the selected row visible", async () => {
  const rows = 60;
  const maxHeight = Math.floor(rows * 0.85);
  const { harness } = await mount({ width: 120, rows });
  const lines = harness.frame(120);
  assert.ok(
    lines.length <= maxHeight,
    `${lines.length} lines for maxHeight ${maxHeight}`,
  );
  const visible = stripAnsiLines(lines.slice(0, maxHeight));
  assert.ok(
    visible.some((line) => line.includes("q quit")),
    "the footer with the key hints is inside the overlay",
  );
  assert.ok(
    visible.some((line) => line.trimStart().startsWith("›")),
    "the selected row is inside the overlay",
  );
  harness.dispose();
});

test("tokens and cost are rendered per root", async () => {
  // Inspect the whole board; viewport/scroll accessibility is covered by R5.
  const { harness } = await mount({ width: 160, rows: 200 });
  const frame = harness.frameText(160).join("\n");
  assert.ok(frame.includes("$1.25"), frame);
  assert.ok(frame.includes("20.1k tok"), frame);
  harness.dispose();
});

test("a single run is titled by its session name, with the dimmed cwd and a short id chip", async () => {
  const { harness } = await mount({ width: 160, rows: 200 });
  const frame = harness.frameText(160).join("\n");
  assert.ok(
    frame.includes("researcher: fixture run"),
    "the session name is the title",
  );
  // The 36-char run id is never the chip: the short id is.
  assert.equal(frame.includes("[dddddddd-0001"), false);
  assert.ok(frame.includes("[dddddddd]"), frame);
  harness.dispose();
});

// --- Regression tests for the second review (REVIEW.md R1..R21) ----------------

test("R1: a secret never reaches the frame from a tool line, an error or a title", async () => {
  const token = "sk-ant-api03-SECRETSECRETSECRET";
  const github = "ghp_abcdefghijklmnopqrst";
  const { harness } = await mountWorld(
    (root, now) => {
      const runningRunId = "ca000000-0001-4000-8000-000000000001";
      addRun(root, {
        runId: runningRunId,
        sessionId: SESSION,
        mode: "single",
        state: "running",
        startedAt: now - 60_000,
        lastUpdate: now,
        lastActivityAt: now,
        cwd: "/home/fixture/secret",
        agent: "worker",
        workflowKey: "impl-secret",
        sessionName: `delegate: use the key ${token}`,
      });
      appendEvents(path.join(root, runningRunId), [
        toolStart(
          "bash",
          {
            command: `curl -H "Authorization: Bearer ${token}" https://x && cat ${os.homedir()}/.ssh/id_ed25519`,
          },
          now - 5000,
        ),
      ]);
      addRun(root, {
        runId: "ca000000-0002-4000-8000-000000000002",
        sessionId: SESSION,
        mode: "single",
        state: "failed",
        startedAt: now - 30 * 60_000,
        endedAt: now - 20 * 60_000,
        lastUpdate: now - 20 * 60_000,
        cwd: "/home/fixture/secret",
        agent: "delegate",
        stepStatus: "failed",
        error: `auth failed with GITHUB_TOKEN=${github}`,
      });
      return { sessionFile: SESSION };
    },
    { width: 120, rows: 80 },
  );
  const frame = harness.frameText(120).join("\n");
  assert.equal(frame.includes(token), false, frame);
  assert.equal(frame.includes(github), false, frame);
  assert.equal(frame.includes(os.homedir()), false, "home is shortened");
  assert.ok(frame.includes("Used Bash!"), frame);
  assert.equal(
    frame.includes("id_ed25519"),
    false,
    "the feed never renders tool arguments",
  );
  assert.ok(frame.includes("[redacted]"), frame);
  assert.equal(
    frame.includes("Bearer"),
    false,
    "credentials are not even represented in the feed",
  );
  assert.ok(frame.includes("GITHUB_TOKEN=[redacted]"), frame);
  assert.ok(frame.includes("use the key [redacted-key]"), frame);
  harness.dispose();
});

test("R2: a promotion ends in static mode, with reduced motion and with NO_COLOR", async () => {
  for (const environment of [{ reducedMotion: true }, { noColor: true }]) {
    const base = tempDir("agent-view-static-promo-");
    const root = path.join(base, "async-subagent-runs");
    const runId = "fa000000-0001-4000-8000-000000000001";
    const world = addRun(root, {
      runId,
      sessionId: SESSION,
      mode: "single",
      state: "running",
      startedAt: NOW - 60_000,
      lastUpdate: NOW,
      lastActivityAt: NOW,
      cwd: "/home/fixture/promo",
      agent: "worker",
      workflowKey: "impl-promo",
    });
    appendEvents(world, [
      thinkingMessage("The rollback path needs a second look.", NOW - 30_000),
    ]);
    const harness = await mountHarness({
      runsDir: root,
      historyDir: path.join(base, "history"),
      sessionFile: SESSION,
      width: 120,
      rows: 40,
      now: NOW,
      ...environment,
    });
    harness.tick();
    const before = harness.frameText(120).join("\n");
    assert.ok(
      before.includes("rollback path"),
      `the thought is visible before the promotion (${JSON.stringify(environment)})`,
    );
    // Six minutes of a 20-minute default: the rank goes up (R6 keeps the
    // estimate honest, the promotion still happens).
    harness.advance(6 * 60_000);
    harness.tick();
    for (let step = 0; step < 20; step += 1) {
      harness.advance(6000);
      harness.tick();
    }
    const after = harness.frameText(120).join("\n");
    assert.equal(
      after.includes("promoted to"),
      false,
      `the flourish must end (${JSON.stringify(environment)})\n${after}`,
    );
    assert.ok(
      after.includes("rollback path"),
      `the thought survives the promotion (${JSON.stringify(environment)})\n${after}`,
    );
    // The new name is drawn: the promotion itself still happened.
    assert.notEqual(
      after.match(/the \w+/)?.[0],
      undefined,
      "the card still renders a persona",
    );
    harness.dispose();
  }
});

test("F2: pressing m after a promotion does not freeze the flourish", async () => {
  const base = tempDir("agent-view-toggle-promo-");
  const root = path.join(base, "async-subagent-runs");
  const runId = "fb000000-0001-4000-8000-000000000001";
  const runDir = addRun(root, {
    runId,
    sessionId: SESSION,
    mode: "single",
    state: "running",
    startedAt: NOW - 60_000,
    lastUpdate: NOW,
    lastActivityAt: NOW,
    cwd: "/home/fixture/toggle",
    agent: "worker",
    workflowKey: "impl-toggle",
  });
  appendEvents(runDir, [
    thinkingMessage("The rollback path needs a second look.", NOW - 30_000),
  ]);
  const harness = await mountHarness({
    runsDir: root,
    historyDir: path.join(base, "history"),
    sessionFile: SESSION,
    width: 120,
    rows: 40,
    now: NOW,
  });
  harness.tick();
  // Six minutes of a 20-minute default: the rank goes up with motion on.
  harness.advance(6 * 60_000);
  harness.tick();
  const promoted = harness.frameText(120).join("\n");
  assert.ok(promoted.includes("promoted to"), promoted);
  // The 5.6-second flourish ends on its own.
  harness.advance(6000);
  harness.tick();
  const settled = harness.frameText(120).join("\n");
  assert.equal(settled.includes("promoted to"), false, settled);
  // `m` freezes the art clock; it must not resurrect the promotion on every
  // card promoted while motion was on.
  harness.component.handleInput("m");
  harness.tick();
  harness.advance(6000);
  harness.tick();
  const frozen = harness.frameText(120).join("\n");
  assert.equal(frozen.includes("promoted to"), false, frozen);
  assert.ok(frozen.includes("rollback path"), frozen);
  harness.dispose();
});

test("R5: scrolling past the last card reaches the Recent list and the last workflow bar", async () => {
  const tall = await mount({ width: 120, rows: 400 });
  const tallFrame = tall.harness.frameText(120);
  const barLine = tallFrame.filter((line) => line.includes("▕")).at(-1) ?? "";
  const barLabel = barLine.slice(barLine.indexOf("▏") + 1).trim();
  assert.ok(
    barLabel.length > 0,
    `no bar line in the tall frame:\n${tallFrame.join("\n")}`,
  );
  tall.harness.dispose();

  const { harness } = await mount({ width: 120, rows: 30 });
  const frames: string[] = [harness.frameText(120).join("\n")];
  for (let step = 0; step < 60; step += 1) {
    harness.component.handleInput("\x1b[B");
    frames.push(harness.frameText(120).join("\n"));
  }
  for (let step = 0; step < 10; step += 1) {
    harness.component.handleInput("\x1b[6~");
    frames.push(harness.frameText(120).join("\n"));
  }
  assert.ok(
    frames.some((frame) => frame.includes("Recent ")),
    "the Recent header is reachable by scrolling past the last card",
  );
  assert.ok(
    frames.some((frame) => frame.includes(barLabel)),
    `the last workflow's bar (${barLabel}) is reachable`,
  );
  harness.dispose();
});

test("F6: unwinding the free scroll to zero does not move the selection", async () => {
  const { harness } = await mount({ width: 120, rows: 30 });
  for (let step = 0; step < 60; step += 1)
    harness.component.handleInput("\x1b[B");
  const past = harness.component.statistics.scrollPast;
  assert.ok(past > 0, `a free offset after the last card: ${past}`);
  const selected = harness.component.selectedChildKey;
  assert.ok(selected, "a row is selected");
  for (let step = 0; step < past - 1; step += 1)
    harness.component.handleInput("\x1b[A");
  assert.equal(harness.component.statistics.scrollPast, 1);
  harness.component.handleInput("\x1b[A");
  assert.equal(harness.component.statistics.scrollPast, 0);
  assert.equal(
    harness.component.selectedChildKey,
    selected,
    "the press that reaches 0 only unwinds; the selection stays put",
  );
  harness.dispose();
});

test("N5: Down escapes a free offset left behind when the selected row vanishes", async () => {
  const { harness } = await mount({ width: 120, rows: 30 });
  // Scrolled to the bottom: the free offset is past the last card and the last
  // Recent row is selected.
  for (let step = 0; step < 60; step += 1)
    harness.component.handleInput("\x1b[B");
  assert.ok(
    harness.component.statistics.scrollPast > 0,
    "a free offset at the bottom",
  );
  // `f` hides the Recent rows without a tick, so the stale selection and the
  // offset still coexist when the next key arrives.
  harness.component.handleInput("f");
  const stale = harness.component.selectedChildKey;
  assert.ok(stale?.startsWith("root:"), `a Recent row was selected: ${stale}`);
  harness.component.handleInput("\x1b[B");
  assert.notEqual(
    harness.component.selectedChildKey,
    stale,
    "Down moves the selection instead of scrolling the vanished row's offset",
  );
  assert.equal(
    harness.component.statistics.scrollPast,
    0,
    "the offset of the vanished row is dropped",
  );
  harness.dispose();
});

test("N5: a re-selection drops the free offset of the row that vanished", async () => {
  const { harness } = await mount({ width: 120, rows: 30 });
  for (let step = 0; step < 60; step += 1)
    harness.component.handleInput("\x1b[B");
  assert.ok(
    harness.component.statistics.scrollPast > 0,
    "a free offset at the bottom",
  );
  // `f` hides the Recent rows; the next tick re-selects the first live card the
  // way a vanished Recent row does, and must clear the vanished row's offset.
  harness.component.handleInput("f");
  harness.tick();
  assert.equal(
    harness.component.statistics.scrollPast,
    0,
    "the re-selection clears the offset",
  );
  harness.component.handleInput("f");
  const before = harness.component.selectedChildKey;
  harness.component.handleInput("\x1b[B");
  assert.notEqual(
    harness.component.selectedChildKey,
    before,
    "Down moves the selection after a re-selection",
  );
  harness.dispose();
});

test("F7: with `f` on, scrolling past the last card reaches the last live bar", async () => {
  const tall = await mount({ width: 120, rows: 400 });
  tall.harness.component.handleInput("f");
  const tallFrame = tall.harness.frameText(120);
  const barLine = tallFrame.filter((line) => line.includes("▕")).at(-1) ?? "";
  const barLabel = barLine.slice(barLine.indexOf("▏") + 1).trim();
  assert.ok(
    barLabel.length > 0,
    `no running-only bar line in the tall frame:\n${tallFrame.join("\n")}`,
  );
  tall.harness.dispose();

  const { harness } = await mount({ width: 120, rows: 30 });
  harness.component.handleInput("f");
  const first = harness.frameText(120).join("\n");
  // No Recent rows are selectable while running-only, so only the free scroll
  // can bring the last live bar into view.
  assert.equal(
    first.includes(barLabel),
    false,
    `the last live bar starts below the fold (${barLabel})`,
  );
  let reached = false;
  let offsetAtReach = 0;
  for (let step = 0; step < 60 && !reached; step += 1) {
    harness.component.handleInput("\x1b[B");
    reached = harness.frameText(120).join("\n").includes(barLabel);
    if (reached) offsetAtReach = harness.component.statistics.scrollPast;
  }
  assert.ok(
    reached,
    `the last live bar (${barLabel}) is reachable while running-only`,
  );
  assert.ok(
    offsetAtReach > 0,
    `the free scroll drove the view, not a new selection key (offset ${offsetAtReach})`,
  );
  harness.dispose();
});

test("R14: the grid tier draws the avatar size the footer reports", async () => {
  const base = tempDir("agent-view-avatar-");
  const root = path.join(base, "async-subagent-runs");
  buildFixtureWorld(root, NOW);
  const harness = await mountHarness({
    runsDir: root,
    historyDir: path.join(base, "history"),
    sessionFile: SESSION,
    width: 160,
    rows: 80,
    now: NOW,
    avatarPx: 8,
  });
  const count = (text: string) => (text.match(/[▀▄]/g) ?? []).length;
  const small = harness.frameText(160).join("\n");
  assert.ok(small.includes("size 8px"), small.split("\n").at(-1) ?? small);
  harness.component.handleInput("+");
  const larger = harness.frameText(160).join("\n");
  assert.ok(
    larger.includes("size 10px"),
    "`+` changes the setting and the footer",
  );
  assert.ok(
    count(larger) > count(small),
    `+ drew more avatar cells: ${count(small)} -> ${count(larger)}`,
  );
  harness.dispose();

  // A narrow terminal clamps the drawn size; the footer says the drawn one.
  const narrowBase = tempDir("agent-view-avatar-narrow-");
  const narrowRoot = path.join(narrowBase, "async-subagent-runs");
  buildFixtureWorld(narrowRoot, NOW);
  const narrow = await mountHarness({
    runsDir: narrowRoot,
    historyDir: path.join(narrowBase, "history"),
    sessionFile: SESSION,
    width: 80,
    rows: 80,
    now: NOW,
    avatarPx: 14,
  });
  const narrowFrame = narrow.frameText(80).join("\n");
  // The narrow tier clamps the drawing; the footer never claims the clipped
  // setting when it is visible at all.
  assert.equal(
    narrowFrame.includes("size 14px"),
    false,
    "the footer must not claim a size the tier does not draw",
  );
  for (const run of narrowFrame.match(/[▀▄]+/g) ?? [])
    assert.ok(run.length <= 8, `avatar run ${run.length} > 8`);
  narrow.dispose();
});

test("R18: a finished root is selectable and Enter opens its output", async () => {
  const { harness } = await mount({ width: 120, rows: 30 });
  const keys: string[] = [];
  const frames: string[] = [];
  for (let step = 0; step < 60; step += 1) {
    harness.component.handleInput("\x1b[B");
    keys.push(harness.component.selectedChildKey ?? "");
    frames.push(harness.frameText(120).join("\n"));
  }
  const rootIndex = keys.findIndex((key) => key.startsWith("root:"));
  assert.ok(
    rootIndex >= 0,
    `a Recent row becomes selectable: ${[...new Set(keys)].join(",")}`,
  );
  // F8: the selection is visible — the selected Recent row carries the accent
  // marker, so an invisible selection can never open a detail pane.
  const selectedKey = keys[rootIndex] ?? "";
  const rootRunId = selectedKey.slice("root:".length);
  const selectedRoot = harness.scanner
    .snapshot()
    .workflows.find((workflow) => workflow.runId === rootRunId);
  assert.ok(
    selectedRoot,
    `the selected root is in the snapshot: ${selectedKey}`,
  );
  const markerLine = (frames[rootIndex] ?? "")
    .split("\n")
    .find((line) => line.includes(selectedRoot.title));
  assert.ok(
    markerLine !== undefined,
    `the Recent row of ${selectedRoot.title} is on screen`,
  );
  assert.ok(
    markerLine.startsWith("› "),
    `the selected Recent row is marked: ${JSON.stringify(markerLine)}`,
  );
  // Scroll to the Recent line, then open it.
  for (let step = 0; step < 60; step += 1)
    harness.component.handleInput("\x1b[B");
  harness.component.handleInput("\r");
  const frame = harness.frameText(120).join("\n");
  assert.ok(frame.includes("Detail ·"), frame);
  assert.ok(frame.includes("output-0.log"), frame);
  harness.dispose();
});

test("R21: a frame builds the cards once, without rendering extra copies for the keys", async () => {
  const { harness } = await mount({ width: 120 });
  const before = harness.component.statistics;
  harness.frame(120);
  harness.frame(120);
  const after = harness.component.statistics;
  assert.equal(after.renders - before.renders, 2);
  assert.equal(
    after.cardBuilds - before.cardBuilds,
    2,
    `${after.cardBuilds - before.cardBuilds} card builds for two frames`,
  );
  harness.dispose();
});
