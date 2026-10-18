/**
 * Pty smoke test: runs tools/harness.ts inside a real pty (python3's `pty`
 * module — the machine has no `script(1)` and no tmux) for a couple of seconds
 * and asserts a clean exit. Skipped with a message when python3 is missing.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { buildFixtureWorld, tempDir } from "./source/fixtures.ts";

import * as fs from "node:fs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PYTHON_WRAPPER =
  "import os,pty,sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))";

test(
  "the production watcher emits native graphics and clears placements in a Ghostty-profile PTY",
  { skip: !pythonAvailable() && "python3 with pty is unavailable" },
  () => {
    const base = tempDir("agent-view-ghostty-pty-");
    const root = path.join(base, "runs");
    buildFixtureWorld(root, Date.now());
    try {
      const result = spawnSync(
        "python3",
        [
          "-c",
          PYTHON_WRAPPER,
          "node",
          "--experimental-strip-types",
          "tools/watch.ts",
        ],
        {
          cwd: HERE,
          encoding: "utf8",
          timeout: 15000,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            ...process.env,
            AGENT_VIEW_RUNS_DIR: root,
            AGENT_VIEW_HOME: path.join(base, "history"),
            AGENTS_WATCH_SECONDS: "0.8",
            TERM: "xterm-ghostty",
            TERM_PROGRAM: "ghostty",
            PI_IMAGE_PROTOCOL: "kitty",
          },
        },
      );
      assert.equal(result.status, 0, String(result.error ?? result.stderr));
      assert.match(result.stdout, /\x1b_Ga=T,f=100,q=2,C=1/);
      assert.match(
        result.stdout,
        /\x1b_Ga=p,q=2/,
        "later frames reuse uploaded PNGs",
      );
      assert.match(
        result.stdout,
        /\x1b_Ga=d,d=A/,
        "exit clears the watcher's image data",
      );
      assert.match(
        result.stdout,
        /\x1b\[\?2026h/,
        "frame writes are synchronized",
      );
      assert.match(result.stdout, /smooth Kitty avatars/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  },
);

function pythonAvailable(): boolean {
  const probe = spawnSync("python3", ["-c", "import pty"], {
    encoding: "utf8",
  });
  return probe.status === 0;
}

test(
  "the harness runs and exits cleanly inside a pty",
  { skip: !pythonAvailable() && "python3 with pty is unavailable" },
  async () => {
    const child = spawn(
      "python3",
      [
        "-c",
        PYTHON_WRAPPER,
        "node",
        "--experimental-strip-types",
        "tools/harness.ts",
      ],
      {
        cwd: HERE,
        env: {
          ...process.env,
          AGENT_VIEW_HARNESS_SECONDS: "2",
          TERM: "xterm-256color",
          COLUMNS: "120",
          LINES: "40",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new Error(`harness did not exit in 20s. Output so far:\n${output}`),
        );
      }, 20_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    assert.equal(
      exitCode,
      0,
      `pty exit code ${exitCode}. Output:\n${output.slice(-2000)}`,
    );
    assert.match(output, /harness ok frames=\d+ clock=stopped timers=\d+/);
    assert.ok(
      output.includes("Agents"),
      "the view drew its header inside the pty",
    );
    assert.ok(
      output.includes("╶┬"),
      "the view drew a workflow tree inside the pty",
    );
    assert.ok(
      (output.match(/harness ok frames=(\d+)/)?.[1] ?? "0") !== "0",
      "the clock produced frames",
    );
  },
);

test(
  "the standalone watcher runs in a pty against a fixture world and exits cleanly",
  { skip: !pythonAvailable() && "python3 with pty is unavailable" },
  async () => {
    const base = tempDir("agent-view-watch-");
    const root = path.join(base, "async-subagent-runs");
    buildFixtureWorld(root, Date.now());
    const child = spawn(
      "python3",
      [
        "-c",
        PYTHON_WRAPPER,
        "node",
        "--experimental-strip-types",
        "tools/watch.ts",
      ],
      {
        cwd: HERE,
        env: {
          ...process.env,
          AGENT_VIEW_RUNS_DIR: root,
          AGENT_VIEW_HOME: path.join(base, "history"),
          AGENTS_WATCH_SECONDS: "2",
          TERM: "xterm-256color",
          COLUMNS: "120",
          LINES: "40",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new Error(`watcher did not exit in 20s. Output so far:\n${output}`),
        );
      }, 20_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    assert.equal(exitCode, 0, `pty exit code ${exitCode}. Output:\n${output}`);
    assert.match(output, /\x1b\[\?1049h/, "the alt screen is entered");
    assert.match(
      output,
      /\x1b\[2K/,
      "every row is erased before it is redrawn",
    );
    assert.match(output, /\x1b\[\?1049l/, "the alt screen is left on exit");
    // The board colours its labels, so the text assertions run on the raw
    // output with the escape sequences removed.
    const plain = output
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    assert.ok(plain.includes("Agents"), "the board drew its header");
    assert.ok(
      plain.includes("Now · "),
      `the board drew the live section:\n${plain.slice(-1200)}`,
    );
    assert.ok(
      plain.includes("[impl-AF1]"),
      "the board drew the fixture workflow's cards",
    );
    assert.ok(
      (plain.match(/↓ select/g) ?? []).length > 1,
      "the clock kept drawing frames",
    );
  },
);
