/**
 * Shared test/measurement harness: a fake TUI, a fake theme and a mounted
 * AgentViewComponent fed by a fixture runs directory and a fake clock. Used by
 * render.test.ts, tools/harness.ts (pty smoke test) and tools/perf.ts.
 */
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { createAvatarEngine, type AvatarEngine } from "./avatar/poses.ts";
import { RunScanner } from "./source/runs.ts";
import { PersonaStore } from "./source/history.ts";
import {
  createStyles,
  type ViewEnvironment,
  type ViewTheme,
} from "./ui/style.ts";
import { AgentViewComponent, type TuiLike } from "./ui/view.ts";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
const IMAGE_PATTERN = /\x1b_G[^\x1b]*\x1b\\/g;

export function stripAnsi(text: string): string {
  return text
    .replace(IMAGE_PATTERN, "")
    .replace(OSC_PATTERN, "")
    .replace(ANSI_PATTERN, "");
}

export function stripAnsiLines(lines: string[]): string[] {
  return lines.map((line) => stripAnsi(line));
}

export interface FakeTui extends TuiLike {
  renders: number;
  terminal: { rows: number; columns: number };
}

export function fakeTui(width = 120, rows = 36): FakeTui {
  const tui: FakeTui = {
    renders: 0,
    terminal: { rows, columns: width },
    requestRender() {
      tui.renders += 1;
    },
  };
  return tui;
}

/** A theme with recognisable ANSI so width math is exercised with real escapes. */
export function fakeTheme(): ViewTheme {
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
      const code = codes[color] ?? "0";
      return `\x1b[${code}m${text}\x1b[0m`;
    },
    bold(text: string) {
      return `\x1b[1m${text}\x1b[0m`;
    },
    getColorMode() {
      return "truecolor";
    },
  };
}

export interface HarnessOptions {
  runsDir: string;
  sessionFile?: string;
  historyDir: string;
  width?: number;
  rows?: number;
  noColor?: boolean;
  reducedMotion?: boolean;
  avatarPx?: number;
  withAvatar?: boolean;
  now?: number;
}

export interface Harness {
  component: AgentViewComponent;
  scanner: RunScanner;
  tui: FakeTui;
  avatar?: AvatarEngine;
  now: () => number;
  advance(ms: number): void;
  tick(): void;
  frame(width?: number): string[];
  frameText(width?: number): string[];
  dispose(): void;
}

export async function mountHarness(options: HarnessOptions): Promise<Harness> {
  let current = options.now ?? Date.now();
  const now = () => current;
  const width = options.width ?? 160;
  const tui = fakeTui(width, options.rows ?? 36);
  const environment: ViewEnvironment = {
    noColor: options.noColor === true,
    reducedMotion: options.reducedMotion === true,
  };
  const scanner = new RunScanner({
    runsDir: options.runsDir,
    historyDir: options.historyDir,
    now,
    ...(options.sessionFile ? { sessionFile: options.sessionFile } : {}),
  });
  scanner.poll();
  const theme = fakeTheme();
  const styles = createStyles(theme, environment);
  const avatar =
    options.withAvatar === false || environment.noColor
      ? undefined
      : await createAvatarEngine({ style: styles.halfBlock, graphics: false });
  const component = new AgentViewComponent({
    scanner,
    theme,
    tui,
    done: () => {},
    environment,
    now,
    ...(options.avatarPx !== undefined ? { avatarPx: options.avatarPx } : {}),
    ...(avatar ? { avatar } : {}),
    personaStore: new PersonaStore(`${options.historyDir}/personas.json`, now),
  });
  const harness: Harness = {
    component,
    scanner,
    tui,
    ...(avatar ? { avatar } : {}),
    now,
    advance(ms: number) {
      current += ms;
    },
    tick() {
      component.tick();
    },
    frame(frameWidth = width) {
      return component.renderFrame(frameWidth);
    },
    frameText(frameWidth = width) {
      return stripAnsiLines(component.renderFrame(frameWidth));
    },
    dispose() {
      component.dispose();
    },
  };
  return harness;
}
