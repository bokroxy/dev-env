import assert from "node:assert/strict";
import { test } from "node:test";
import { bubbleWidth, renderBubble, type BubbleInput } from "./bubble.ts";
import { createStyles, type ViewTheme } from "./style.ts";
import { stripAnsi, fakeTheme } from "../harness.ts";
import { visibleWidth } from "./text.ts";

const styles = createStyles(fakeTheme(), {
  noColor: false,
  reducedMotion: false,
});
const plainStyles = createStyles(fakeTheme(), {
  noColor: true,
  reducedMotion: true,
});

test("the box is sized from the final text, so typing cannot resize it", () => {
  const text =
    "Re-reading the diff to find the crash window before I trust the fix at all.";
  const widths = new Set<number>();
  for (let shown = 0; shown <= text.length; shown += 4) {
    const input: BubbleInput = {
      kind: "think",
      text,
      shownText: text.slice(0, shown),
      typing: shown < text.length,
      dots: "·",
    };
    const lines = renderBubble(input, { width: 80, styles });
    widths.add(visibleWidth(stripAnsi(lines[0])));
  }
  assert.equal(
    widths.size,
    1,
    `box width changed while typing: ${[...widths].join(",")}`,
  );
});

test("a fully revealed bubble shows the whole text", () => {
  const text = "The rollback path still looks unsafe; I need a counterexample.";
  const lines = renderBubble(
    { kind: "think", text, shownText: text, typing: false },
    { width: 90, styles },
  );
  const flat = stripAnsi(lines.join("\n"));
  assert.ok(flat.includes("counterexample"), flat);
  assert.ok(flat.includes("◂─"), flat);
});

test("bubbles never exceed the requested width", () => {
  for (const width of [24, 40, 60, 90]) {
    const lines = renderBubble(
      { kind: "think", text: "x".repeat(400), shownText: "x".repeat(400) },
      { width, styles },
    );
    for (const line of lines)
      assert.ok(
        visibleWidth(line) <= width,
        `${visibleWidth(line)} > ${width}`,
      );
  }
});

test("the tool variant names the tool and marks it as ongoing", () => {
  const lines = renderBubble(
    { kind: "tool", tool: "bash: go test -race ./...", dots: "…" },
    { width: 70, styles },
  );
  const flat = stripAnsi(lines.join("\n"));
  assert.ok(flat.includes("⚙ bash"), flat);
});

test("the verdict bubble shows label, confidence bar and action, and marks the gate", () => {
  const confident = stripAnsi(
    renderBubble(
      {
        kind: "verdict",
        verdict: {
          label: "blocking",
          p: 0.93,
          action: "fix_now",
          confident: true,
        },
      },
      { width: 80, styles },
    ).join("\n"),
  );
  assert.ok(confident.includes("blocking"), confident);
  assert.ok(confident.includes("0.93"), confident);
  assert.ok(confident.includes("fix_now"), confident);
  assert.ok(confident.includes("(confident)"), confident);
  assert.ok(confident.includes("█"), confident);

  const belowGate = stripAnsi(
    renderBubble(
      {
        kind: "verdict",
        verdict: {
          label: "stage_regression",
          p: 0.42,
          action: "escalate",
          confident: false,
        },
      },
      { width: 80, styles },
    ).join("\n"),
  );
  assert.ok(belowGate.includes("(below the 0.9 gate)"), belowGate);
});

test("the promotion bubble names the old and new persona once", () => {
  const lines = renderBubble(
    {
      kind: "promo",
      promo: {
        rankName: "Knight",
        previousName: "Aldric",
        name: "Bertram",
        noun: "Mason",
        sparkle: "✦",
      },
    },
    { width: 80, styles },
  );
  const flat = stripAnsi(lines.join("\n"));
  assert.ok(flat.includes("promoted to Knight!"), flat);
  assert.ok(flat.includes("Aldric is now Bertram the Mason"), flat);
});

test("NO_COLOR bubbles carry no escape codes at all", () => {
  const lines = renderBubble(
    { kind: "think", text: "quiet work", shownText: "quiet work" },
    { width: 60, styles: plainStyles },
  );
  for (const line of lines) assert.equal(line.includes("\x1b"), false, line);
});

test("bubbleWidth reports the widest rendered line", () => {
  const lines = renderBubble(
    { kind: "say", text: "done · 4m12s", shownText: "done · 4m12s" },
    { width: 60, styles },
  );
  assert.equal(
    bubbleWidth(lines),
    Math.max(...lines.map((line) => visibleWidth(line))),
  );
});

test("a fake theme is injectable through ViewTheme", () => {
  const theme: ViewTheme = fakeTheme();
  assert.equal(stripAnsi(theme.fg("success", "ok")), "ok");
  assert.equal(theme.getColorMode(), "truecolor");
});
