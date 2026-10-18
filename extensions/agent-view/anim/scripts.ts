/**
 * Vendored animation frames and timing helpers (no cli-spinners dependency).
 * Everything is a pure function of the frame time `t` in seconds, so a test can
 * snapshot deterministic frames.
 */

/** cli-spinners' `dots` frames, advanced by the view's own clock. */
export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

/** Thinking-dots cycle used while a bubble is still typing. */
export const DOTS = ["·", "··", "···"];

export const THINKING_DOTS_PERIOD = 1 / 3;
export const BLINK_PERIOD_S = 3.4;
export const BLINK_SECONDS = 0.22;
export const FLOURISH_SECONDS = 5.6;
export const FLOURISH_OLD_FACE_S = 0.45;
export const FLOURISH_PUFF_END_S = 0.7;
export const SPARKLES = ["✦", "✧", "·", "*", "+"];
export const TYPING_CHARS_PER_SECOND = 38;
export const VERDICT_GATE = 0.9;
/** pi-subagents treats a bash call open this long as "long-running" attention. */
export const LONG_TOOL_SECONDS = 60;

/** Sword frames: hilt, three blade slots (one glinting), then a cross flash. */
export const SWORD_FRAMES: string[][] = [
  ["†", "✧", "─", "─"],
  ["†", "─", "✧", "─"],
  ["†", "─", "─", "✧"],
  ["†", "─", "─", "─"],
  ["⚔", " ", " ", " "],
  ["†", "─", "─", "─"],
];

export function spinnerFrame(t: number): string {
  const index = Math.floor(t * 10) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[
    (index + SPINNER_FRAMES.length) % SPINNER_FRAMES.length
  ];
}

export function thinkingDots(t: number): string {
  const index = Math.floor(t / THINKING_DOTS_PERIOD) % DOTS.length;
  return DOTS[(index + DOTS.length) % DOTS.length];
}

/** Per-agent blink: a seed offset keeps agents from blinking in unison. */
export function isBlinking(t: number, seedHash: number): boolean {
  const offset = (seedHash % 3000) / 1000;
  return (t + offset) % BLINK_PERIOD_S < BLINK_SECONDS;
}

export function sparkle(t: number): string {
  return SPARKLES[Math.floor(t * 8) % SPARKLES.length];
}

export function shimmerIndex(t: number, full: number): number {
  return Math.floor((t * 14) % (full + 10)) - 5;
}

export interface TypewriterState {
  text: string;
  startedAt: number;
  now: number;
  charsPerSecond?: number;
}

export function typewriter(state: TypewriterState): {
  text: string;
  done: boolean;
} {
  const rate = state.charsPerSecond ?? TYPING_CHARS_PER_SECOND;
  const revealed = Math.max(
    0,
    Math.floor((state.now - state.startedAt) * rate),
  );
  if (revealed >= state.text.length) return { text: state.text, done: true };
  return { text: state.text.slice(0, revealed), done: false };
}

/** Verdict confidence bar, 12 cells wide like the demo. */
export function confidenceBar(p: number, width = 12): string {
  const filled = Math.round(Math.min(1, Math.max(0, p)) * width);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}
