import assert from "node:assert/strict";
import { test } from "node:test";
import { footerTimerText } from "./footer-timer.ts";

test("shows nothing before any prompt has run", () => {
  assert.equal(footerTimerText({ running: false, elapsedMs: null }), "");
});

test("shows the live elapsed time while a prompt runs", () => {
  assert.equal(footerTimerText({ running: true, elapsedMs: 92_000 }), "1m 32s");
  assert.equal(footerTimerText({ running: true, elapsedMs: 0 }), "0s");
});

test("shows how long the last prompt took once it has finished", () => {
  assert.equal(
    footerTimerText({ running: false, elapsedMs: 252_000 }),
    "took 4m 12s",
  );
});
