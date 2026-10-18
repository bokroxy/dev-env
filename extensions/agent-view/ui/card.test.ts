import assert from "node:assert/strict";
import { test } from "node:test";
import { createStyles } from "./style.ts";
import { fakeTheme, stripAnsi } from "../harness.ts";
import {
  poseFor,
  poofRows,
  renderCard,
  swordFrame,
  type CardInput,
} from "./card.ts";
import type { ChildSnapshot } from "../source/types.ts";
import { visibleWidth } from "./text.ts";

const styles = createStyles(fakeTheme(), {
  noColor: false,
  reducedMotion: false,
});
const plain = createStyles(fakeTheme(), { noColor: true, reducedMotion: true });

function child(overrides: Partial<ChildSnapshot> = {}): ChildSnapshot {
  return {
    key: "review-AF1-2",
    rowKey: "aaaaaaaa-1111-4111-8111-000000000001/review-AF1-2",
    runId: "bbbbbbbb-0004-4000-8000-000000000004",
    agent: "delegate",
    roleKey: "review",
    model: "claude-opus-5-5",
    effort: "high",
    state: "running",
    active: true,
    stale: false,
    queued: false,
    failed: false,
    elapsedMs: 60_000,
    isClef: false,
    activity: {},
    progress: 0.4,
    estimated: true,
    ...overrides,
  };
}

function input(overrides: Partial<CardInput> = {}): CardInput {
  return {
    child: child(),
    persona: { name: "Cecily", noun: "Warden" },
    previousPersona: { name: "Aldric", noun: "Builder" },
    rank: 1,
    previousRank: 0,
    levelUpAt: Number.NEGATIVE_INFINITY,
    t: 0,
    now: 0,
    blink: false,
    layout: {
      avatarPx: 0,
      bubbleLines: 2,
      bubbleWidth: 60,
      guide: "│  ",
      branch: "├─",
      marker: " ",
      width: 120,
    },
    styles,
    ...overrides,
  };
}

test("poses follow the state: happy when done, mad when failed, sleepy when long-running", () => {
  assert.equal(
    poseFor(child(), 10, Number.NEGATIVE_INFINITY, false, 0),
    "idle",
  );
  assert.equal(
    poseFor(
      child({ activity: { thought: "thinking about it" } }),
      10,
      Number.NEGATIVE_INFINITY,
      false,
      0,
    ),
    "thinking",
  );
  assert.equal(
    poseFor(
      child({ activity: { longRunning: true } }),
      10,
      Number.NEGATIVE_INFINITY,
      false,
      0,
    ),
    "sleepy",
  );
  assert.equal(
    poseFor(child(), 10, Number.NEGATIVE_INFINITY, true, 0),
    "sleepy",
    "blink frame",
  );
  assert.equal(
    poseFor(
      child({ active: false, failed: false, state: "complete" }),
      10,
      Number.NEGATIVE_INFINITY,
      false,
      0,
    ),
    "happy",
  );
  assert.equal(
    poseFor(
      child({ active: false, failed: true, state: "failed" }),
      10,
      Number.NEGATIVE_INFINITY,
      false,
      0,
    ),
    "mad",
  );
  assert.equal(
    poseFor(
      child({ verdict: { label: "blocking", p: 0.95, confident: true } }),
      10,
      Number.NEGATIVE_INFINITY,
      false,
      0,
    ),
    "smug",
  );
  assert.equal(
    poseFor(child(), 0.2, 0, false, 0),
    "happy",
    "promotion flourish",
  );
});

test("a bash call open for more than a minute makes the agent sleepy", () => {
  // The tool age is measured against the injected clock, never Date.now().
  const wall = 1_800_000_000_000;
  const worried = child({
    activity: {
      tool: "bash: go test -race ./...",
      toolName: "bash",
      toolStartedAt: wall - 120_000,
    },
  });
  assert.equal(
    poseFor(worried, 10, Number.NEGATIVE_INFINITY, false, wall),
    "sleepy",
  );
  assert.equal(
    poseFor(worried, 10, Number.NEGATIVE_INFINITY, false, wall - 110_000),
    "idle",
  );
});

test("the sword glints, flashes and stays inside four cells", () => {
  const seen = new Set<string>();
  for (let step = 0; step < 6; step += 1) {
    const frame = stripAnsi(swordFrame(step / 9, styles));
    assert.equal(visibleWidth(frame), 4, frame);
    seen.add(frame);
  }
  assert.ok(seen.size >= 5, "the glint frames and the flash are distinct");
  assert.ok(
    [...seen].some((frame) => frame.startsWith("⚔")),
    "the flash frame exists",
  );
  assert.equal(stripAnsi(swordFrame(0, plain)), "†✧──");
});

test("the promotion puff is a block of sparkles at the avatar size", () => {
  const rows = poofRows(10, 0.5, styles);
  assert.equal(rows.length, 5);
  assert.equal(visibleWidth(rows[0]), 10);
  assert.ok(stripAnsi(rows.join("")).trim().length > 0);
});

test("a running row keeps the model first, the persona, the key and the estimate", () => {
  const lines = renderCard(input()).map(stripAnsi);
  const flat = lines.join("\n");
  assert.match(
    lines[0],
    /├─ ▸ claude-opus-5-5 · high {2}♘ Squire Cecily the Warden \[review-AF1-2\]/,
  );
  assert.ok(flat.includes("● running"), flat);
  assert.ok(flat.includes("1m00s"), flat);
  assert.ok(lines.every((line) => visibleWidth(line) <= 120));
});

test("the selection marker replaces the branch's leading space", () => {
  const marked = renderCard(
    input({ layout: { ...input().layout, marker: "›" } }),
  ).map(stripAnsi);
  assert.match(marked[0], /^›├─ ▸ /);
  assert.ok(
    marked.every((line) => line.startsWith("›")),
    marked.join("\n"),
  );
});

test("a finished row collapses to one line", () => {
  const lines = renderCard(
    input({ child: child({ active: false, state: "complete", progress: 1 }) }),
  ).map(stripAnsi);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("✓ done"), lines[0]);
});

test("a failed row collapses to one mad line", () => {
  const lines = renderCard(
    input({
      child: child({
        active: false,
        failed: true,
        state: "failed",
        activity: { error: "exit code 3" },
      }),
    }),
  ).map(stripAnsi);
  assert.ok(lines[0].includes("✗ failed"), lines[0]);
});

test("a queued row says who awaits", () => {
  const lines = renderCard(
    input({ child: child({ active: false, queued: true, state: "queued" }) }),
  ).map(stripAnsi);
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /○ claude-opus-5-5 · high {2}queued · review-AF1-2 · a reviewer awaits/,
  );
});

test("the clef sword accompanies the persona and the verdict bubble follows", () => {
  const clef = child({
    key: "clef-1-blocker",
    agent: "clef",
    roleKey: "clef",
    model: "cf/clef",
    isClef: true,
    verdict: {
      label: "stage_regression",
      p: 0.8924,
      action: "escalate",
      confident: false,
    },
  });
  const lines = renderCard(
    input({ child: clef, persona: { name: "Drogo", noun: "Oracle" }, rank: 2 }),
  ).map(stripAnsi);
  const flat = lines.join("\n");
  assert.ok(flat.includes("†"), "the sword hilt is drawn");
  assert.ok(flat.includes("stage_regression"), flat);
  assert.ok(flat.includes("0.89"), flat);
  assert.ok(flat.includes("escalate"), flat);
  assert.ok(flat.includes("(below the 0.9 gate)"), flat);
});

test("a finished clef keeps its verdict instead of collapsing", () => {
  const clef = child({
    key: "clef-1-blocker",
    agent: "clef",
    roleKey: "clef",
    model: "cf/clef",
    isClef: true,
    active: false,
    state: "complete",
    progress: 1,
    verdict: { label: "blocking", p: 0.97, action: "fix_now", confident: true },
  });
  const lines = renderCard(input({ child: clef })).map(stripAnsi);
  assert.ok(lines.length > 1, "not collapsed");
  assert.ok(lines.join("\n").includes("blocking"));
});

test("tool activity has a rainbow feed outside the reasoning bubble", () => {
  const card = input({
    child: child({
      activity: {
        tool: "firecrawl_scrape: https://example.org",
        toolName: "firecrawl_scrape",
        recentTools: [
          {
            id: "f1",
            name: "firecrawl_scrape",
            label: "Firecrawl",
            failed: false,
          },
        ],
      },
    }),
  });
  const lines = renderCard(card);
  assert.ok(lines.some((line) => stripAnsi(line).includes("Used Firecrawl!")));
  assert.ok(lines.some((line) => line.includes("\x1b[38;5;")));
  assert.ok(
    !lines.some((line) => stripAnsi(line).includes("https://example.org")),
  );
  assert.ok(!lines.some((line) => stripAnsi(line).includes("using firecrawl")));
  assert.ok(
    renderCard({ ...card, styles: plain }).every(
      (line) => !line.includes("\x1b"),
    ),
  );
});

test("a promotion has a separate dramatic banner for 5.6 seconds", () => {
  const lines = renderCard(input({ t: 3, levelUpAt: 0 })).map(stripAnsi);
  assert.ok(
    lines.some((line) => line.includes("PROMOTED")),
    lines.join("\n"),
  );
  assert.ok(
    !renderCard(input({ t: 6, levelUpAt: 0 }))
      .map(stripAnsi)
      .some((line) => line.includes("PROMOTED")),
  );
});

test("NO_COLOR rows contain no escape sequences", () => {
  const lines = renderCard(input({ styles: plain }));
  for (const line of lines) assert.equal(line.includes("\x1b"), false, line);
});
