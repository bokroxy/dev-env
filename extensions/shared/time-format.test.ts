import assert from "node:assert/strict";
import { test } from "node:test";
import { formatClock, formatDuration } from "./time-format.ts";

test("formats durations in whole seconds with steady-width lower units", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(999), "0s");
  assert.equal(formatDuration(1_000), "1s");
  assert.equal(formatDuration(59_999), "59s");
  assert.equal(formatDuration(60_000), "1m 00s");
  assert.equal(formatDuration(252_000), "4m 12s");
  assert.equal(formatDuration(245_000), "4m 05s");
  assert.equal(formatDuration(3_599_000), "59m 59s");
  assert.equal(formatDuration(3_600_000), "1h 00m 00s");
  assert.equal(formatDuration(3_912_000), "1h 05m 12s");
});

test("treats negative and non-finite durations as zero", () => {
  assert.equal(formatDuration(-5_000), "0s");
  assert.equal(formatDuration(Number.NaN), "0s");
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), "0s");
});

test("formats a same-day time as a 24-hour clock", () => {
  const now = new Date(2026, 9, 19, 23, 0, 0).getTime();
  const at = new Date(2026, 9, 19, 9, 4, 7).getTime();
  assert.equal(formatClock(at, now), "09:04:07");
  assert.equal(
    formatClock(new Date(2026, 9, 19, 22, 14, 7).getTime(), now),
    "22:14:07",
  );
});

test("adds the date for another day this year", () => {
  const now = new Date(2026, 9, 20, 8, 0, 0).getTime();
  const at = new Date(2026, 9, 19, 22, 14, 7).getTime();
  assert.equal(formatClock(at, now), "Oct 19 22:14:07");
});

test("adds the year for a different year and treats midnight as a new day", () => {
  const now = new Date(2026, 0, 2, 0, 0, 5).getTime();
  assert.equal(
    formatClock(new Date(2025, 11, 31, 23, 59, 59).getTime(), now),
    "Dec 31 2025 23:59:59",
  );
  assert.equal(
    formatClock(new Date(2026, 0, 1, 23, 59, 59).getTime(), now),
    "Jan 1 23:59:59",
  );
});
