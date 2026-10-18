import assert from "node:assert/strict";
import { test } from "node:test";
import { stripAnsi } from "../harness.ts";
import {
  clip,
  clipStart,
  countNoun,
  formatDuration,
  formatEta,
  formatPercent,
  formatTokens,
  leftRight,
  padTo,
  visibleWidth,
  wrapPlain,
} from "./text.ts";

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

test("visibleWidth ignores ANSI, counts wide characters and half blocks", () => {
  assert.equal(visibleWidth("abc"), 3);
  assert.equal(visibleWidth(`${RED}abc${RESET}`), 3);
  assert.equal(visibleWidth("▀▀▀"), 3);
  assert.equal(visibleWidth("日本"), 4);
});

test("clip never exceeds the requested width", () => {
  assert.equal(stripAnsi(clip("abcdef", 3)), "ab…");
  assert.ok(visibleWidth(clip("abcdef", 3)) <= 3);
  assert.equal(clip(`${RED}abcdef${RESET}`, 100), `${RED}abcdef${RESET}`);
  assert.ok(visibleWidth(clip(`${RED}abcdef${RESET}`, 4)) <= 4);
  assert.equal(clip("anything", 0), "");
  assert.ok(visibleWidth(clip("日本語のテキスト", 5)) <= 5);
});

test("clipStart keeps the tail of a long path behind a leading ellipsis", () => {
  const long = `/home/user/${"deep/".repeat(30)}run/output-0.log`;
  const clipped = clipStart(long, 40);
  assert.equal(visibleWidth(clipped), 40);
  assert.ok(clipped.startsWith("…"));
  assert.ok(clipped.endsWith("/run/output-0.log"));
  assert.equal(clipStart("short.log", 40), "short.log");
  assert.equal(clipStart("anything", 0), "");
  assert.equal(clipStart("anything", 1), "…");
  assert.ok(visibleWidth(clipStart("/日本語/テキスト/ファイル.log", 9)) <= 9);
});

test("padTo pads to an exact visible width", () => {
  assert.equal(padTo("ab", 4), "ab  ");
  assert.equal(visibleWidth(padTo(`${RED}ab${RESET}`, 4)), 4);
  assert.ok(visibleWidth(padTo("abcdef", 3)) <= 3);
});

test("leftRight aligns the right side and keeps a space between", () => {
  const line = leftRight("left", "right", 20);
  assert.equal(visibleWidth(line), 20);
  assert.ok(line.startsWith("left"));
  assert.ok(line.endsWith("right"));
  assert.ok(
    visibleWidth(leftRight("a very long left side", "right", 12)) <= 12,
  );
});

test("duration, token and percent formats stay short", () => {
  assert.equal(formatDuration(42_000), "42s");
  assert.equal(formatDuration(18 * 60_000 + 39_000), "18m39s");
  assert.equal(formatDuration(3 * 3600_000), "3h00m");
  assert.equal(formatDuration(-5), "0s");
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(12_300), "12.3k");
  assert.equal(formatTokens(2_500_000), "2.5M");
  assert.equal(formatPercent(0.624), "62%");
  assert.equal(formatPercent(2), "100%");
});

test("ETA is always labelled as an estimate", () => {
  assert.match(formatEta(90_000, true), /^~1m30s left$/);
  assert.match(formatEta(90_000, false), /\(seen\)$/);
  // Past the expectation the label says so, and names the typical duration
  // instead of claiming the run is finishing.
  assert.equal(formatEta(0, true), "overrunning");
  assert.equal(
    formatEta(-5_000, true, 8 * 60_000),
    "overrunning · typical 8m00s",
  );
});

test("a count noun agrees with its number", () => {
  assert.equal(countNoun(1, "run"), "1 run");
  assert.equal(countNoun(0, "run"), "0 runs");
  assert.equal(countNoun(3, "run"), "3 runs");
  assert.equal(countNoun(1, "earlier finished run"), "1 earlier finished run");
});

test("wrapPlain wraps on spaces and clips long words", () => {
  assert.deepEqual(wrapPlain("one two three", 7, 2), ["one two", "three"]);
  assert.equal(stripAnsi(wrapPlain("supercalifragilistic", 5, 1)[0]), "supe…");
  assert.equal(wrapPlain("one two three four", 7, 2).length, 2);
});
