/**
 * Headless harness for the pty smoke test: mounts the component against a
 * fixture world with the REAL clock, writes every requested frame to stdout
 * (through a pty when the test wraps it) and exits 0 after a few seconds with
 * the Esc key. Prints `harness ok frames=<n> timers=<n>` so the test can assert
 * that no timer outlives the overlay.
 */
import * as path from "node:path";
import { mountHarness } from "../harness.ts";
import { buildFixtureWorld, tempDir } from "../source/fixtures.ts";

const seconds = Number(process.env.AGENT_VIEW_HARNESS_SECONDS ?? "2.5");
const width =
  process.stdout.columns && process.stdout.columns > 0
    ? Math.min(process.stdout.columns, 160)
    : 120;
const rows =
  process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 40;

const base = tempDir("agent-view-harness-");
const root = path.join(base, "async-subagent-runs");
const now = Date.now();
const fixture = buildFixtureWorld(root, now);

const harness = await mountHarness({
  runsDir: root,
  historyDir: path.join(base, "history"),
  sessionFile: fixture.sessionFile,
  width,
  rows,
  now,
});

let frames = 0;
const tui = harness.tui;
const requestRender = tui.requestRender.bind(tui);
tui.requestRender = () => {
  requestRender();
  const lines = harness.component.render(width);
  frames += 1;
  process.stdout.write(`${lines.join("\n")}\n`);
};

harness.component.start();
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// Esc closes the overlay; the component must clear its clock on the way out.
harness.component.handleInput("\x1b");
harness.component.dispose();
await new Promise((resolve) => setTimeout(resolve, 0));
const timers = process
  .getActiveResourcesInfo()
  .filter((resource) => resource === "Timeout").length;
const clock = harness.component.statistics.clockRunning ? "running" : "stopped";
process.stdout.write(
  `\nharness ok frames=${frames} clock=${clock} timers=${timers}\n`,
);
process.exit(clock === "stopped" ? 0 : 1);
