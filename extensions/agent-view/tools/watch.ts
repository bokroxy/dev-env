/**
 * `agents-watch` — the same live board as the `/agents` overlay, rendered
 * full-screen in its own terminal pane, with no pi process involved.
 *
 * It reuses the pure `RunScanner` and the same `AgentViewComponent`: alt
 * screen, raw mode, resize aware, `q`/Ctrl-C quit, `a` other sessions,
 * `h` history, `f` running-only. It has no pi session, so it defaults to ALL
 * sessions; pin one with `--session <session.jsonl>` if you want only that
 * session's runs (`a` then toggles the rest back in).
 *
 *   agents-watch [--session <session.jsonl>]
 *
 * Env: AGENT_VIEW_RUNS_DIR / AGENT_VIEW_HOME (same overrides as the overlay),
 * NO_COLOR / PI_REDUCED_MOTION, AGENTS_WATCH_SECONDS (auto-exit, for the pty
 * smoke test).
 */
import * as path from "node:path";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { createAvatarEngine } from "../avatar/poses.ts";
import { defaultHistoryDir, PersonaStore } from "../source/history.ts";
import { defaultRunsDir, RunScanner } from "../source/runs.ts";
import { createStyles, type ViewTheme } from "../ui/style.ts";
import { AgentViewComponent, type TuiLike } from "../ui/view.ts";
import { WatchImageFrame } from "./image-frame.ts";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_TO_END = "\x1b[J";

/** The overlay gets its theme from pi; standalone we map the same tokens. */
function ansiTheme(): ViewTheme {
  const codes: Record<string, string> = {
    dim: "2",
    accent: "36",
    success: "32",
    error: "31",
    warning: "33",
    muted: "90",
  };
  return {
    fg(color: ThemeColor, text: string) {
      return `\x1b[${codes[color] ?? "0"}m${text}\x1b[0m`;
    },
    bold(text: string) {
      return `\x1b[1m${text}\x1b[0m`;
    },
    getColorMode() {
      return "truecolor";
    },
  };
}

function sessionArgument(argv: string[]): string | undefined {
  const index = argv.indexOf("--session");
  if (index >= 0) return argv[index + 1];
  const inline = argv.find((argument) => argument.startsWith("--session="));
  return inline?.slice("--session=".length);
}

if (process.argv.includes("--version")) {
  process.stdout.write("agents-watch 2026-10-07-smooth-tools\n");
  process.exit(0);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(
    "agents-watch [--session <session.jsonl>]\n" +
      "Live subagent board for a second terminal pane; defaults to all sessions.\n",
  );
  process.exit(0);
}

if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) {
  process.stderr.write(
    "agents-watch needs a terminal (TTY): run it in its own pane.\n",
  );
  process.exit(1);
}

const runsDir = process.env.AGENT_VIEW_RUNS_DIR ?? defaultRunsDir();
const historyDir = process.env.AGENT_VIEW_HOME ?? defaultHistoryDir();
const sessionFile = sessionArgument(process.argv);
const environment = {
  noColor: (process.env.NO_COLOR ?? "") !== "",
  reducedMotion: /^(1|true|yes|on)$/i.test(process.env.PI_REDUCED_MOTION ?? ""),
};

const scanner = new RunScanner({
  runsDir,
  historyDir,
  // No pi session here: show every session's live runs and recent history.
  includeOtherSessions: true,
  ...(sessionFile ? { sessionFile } : {}),
});
scanner.poll();

const stdout = process.stdout;
const stdin = process.stdin;

let closed = false;
const images = new WatchImageFrame();

function cleanup(code: number): void {
  if (closed) return;
  closed = true;
  component.dispose();
  try {
    stdin.setRawMode(false);
    stdin.pause();
  } catch {
    // The terminal may already be gone (SIGTERM); leaving the alt screen is
    // still worth attempting.
  }
  stdout.write(`${images.dispose()}${SHOW_CURSOR}${LEAVE_ALT_SCREEN}`);
  process.exit(code);
}

const tui: TuiLike = {
  terminal: {
    rows: stdout.rows || 40,
    columns: stdout.columns || 120,
  },
  requestRender() {
    draw();
  },
};

function draw(): void {
  if (closed) return;
  const columns = Math.max(40, stdout.columns || 120);
  const frame = images.render(component.render(columns));
  // Clear old placements, reuse uploaded PNGs, and commit the whole frame atomically.
  const sync = process.env.AGENT_VIEW_NO_SYNC !== "1";
  stdout.write(
    `${sync ? "\x1b[?2026h" : ""}${frame.cleanup}\x1b[H${frame.lines.map((line) => `\x1b[2K${line}`).join("\r\n")}${CLEAR_TO_END}${sync ? "\x1b[?2026l" : ""}`,
  );
}

const component = new AgentViewComponent({
  scanner,
  theme: ansiTheme(),
  tui,
  done: () => cleanup(0),
  environment,
  // This pane owns the whole terminal: no overlay maxHeight here.
  heightFraction: 1,
  personaStore: new PersonaStore(path.join(historyDir, "personas.json")),
});

stdout.write(`${ENTER_ALT_SCREEN}${HIDE_CURSOR}`);
stdin.setRawMode(true);
stdin.resume();
stdin.setEncoding("utf8");
stdin.on("data", (data: string) => component.handleInput(data));
stdout.on("resize", () => {
  tui.terminal = {
    rows: stdout.rows || 40,
    columns: stdout.columns || 120,
  };
  draw();
});
process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));
process.on("exit", () => {
  if (closed) return;
  try {
    stdout.write(`${images.dispose()}${SHOW_CURSOR}${LEAVE_ALT_SCREEN}`);
  } catch {
    // Nothing can be done while the process is already leaving.
  }
});

createAvatarEngine({ style: createStyles(ansiTheme(), environment).halfBlock })
  .then((avatar) => {
    component.setAvatar(environment.noColor ? undefined : avatar);
  })
  .catch(() => {
    // Avatars are decoration; the board runs without them.
  });

component.start();
draw();

const exitAfterSeconds = Number(process.env.AGENTS_WATCH_SECONDS ?? "0");
if (Number.isFinite(exitAfterSeconds) && exitAfterSeconds > 0) {
  setTimeout(() => cleanup(0), exitAfterSeconds * 1000);
}
