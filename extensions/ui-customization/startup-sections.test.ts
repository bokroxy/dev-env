import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collapseStartupSections,
  countIssues,
  countListed,
  type StartupNode,
} from "./startup-sections.ts";

const heading = (text: string) => `\u001b[1;34m${text}\u001b[0m`;
const leaf = (lines: string[]): StartupNode => ({
  invalidate() {},
  render: () => lines,
});
const container = (...children: StartupNode[]): StartupNode => ({
  children,
  invalidate() {},
  render: (width) => children.flatMap((child) => child.render(width)),
});
const spacer = () => leaf([""]);

function startup() {
  return container(
    container(
      leaf([heading("[Context]"), "  ~/.pi/agent/AGENTS.md"]),
      spacer(),
      leaf([
        heading("[Skills]"),
        "  ab-testing, ads,",
        "  apple-design, caveman",
      ]),
      spacer(),
      leaf([heading("[Prompts]"), "  /council, /review-loop"]),
      spacer(),
      leaf([heading("[Extensions]"), "  agent-view, clef, workflows"]),
      spacer(),
      leaf([
        heading("[Extension issues]"),
        "  ~/.pi/agent/npm/node_modules/remote-pi/package.json",
        "    Host-provided extension packages must be declared in peerDependencies",
      ]),
      spacer(),
    ),
  );
}

test("counts comma lists and indented issue entries", () => {
  assert.equal(countListed([heading("[Skills]"), "  a, b,", "  c"]), 3);
  assert.equal(
    countIssues([
      heading("[Extension issues]"),
      "  one.json",
      "    why",
      "  two.json",
      "    why",
    ]),
    2,
  );
});

test("collapsed: one line per section, spacers removed, Context untouched", () => {
  let expanded = false;
  const root = startup();
  assert.equal(
    collapseStartupSections(root, () => expanded),
    true,
  );
  const lines = root
    .render(120)
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
  assert.deepEqual(lines.slice(0, 2), ["[Context]", "  ~/.pi/agent/AGENTS.md"]);
  assert.ok(lines.includes("[Skills] 4 loaded · ctrl+o to expand"));
  assert.ok(lines.includes("[Prompts] 2 loaded · ctrl+o to expand"));
  assert.ok(lines.includes("[Extensions] 3 loaded · ctrl+o to expand"));
  assert.ok(lines.includes("[Extension issues] 1 entry · ctrl+o to expand"));
  assert.ok(!lines.some((line) => line.includes("apple-design")));
  // Only the spacer after [Context] is left.
  assert.equal(lines.filter((line) => line === "").length, 1);
  expanded = true;
  const full = root
    .render(120)
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
  assert.ok(full.includes("  apple-design, caveman"));
  assert.ok(full.some((line) => line.includes("peerDependencies")));
  assert.equal(full.filter((line) => line === "").length, 5);
});

test("is idempotent and skips a listing that is already expanded", () => {
  const root = startup();
  assert.equal(
    collapseStartupSections(root, () => false),
    true,
  );
  assert.equal(
    collapseStartupSections(root, () => false),
    false,
  );
  const expandedRoot = startup();
  collapseStartupSections(expandedRoot, () => true);
  // Issues can still be wrapped; listings need the collapsed text to be counted.
  const text = expandedRoot.render(120).join("\n");
  assert.ok(text.includes("apple-design"));
});
