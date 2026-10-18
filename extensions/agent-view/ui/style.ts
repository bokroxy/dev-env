/**
 * Styling for the view. Theme tokens carry the semantic colours, raw 256-colour
 * SGR carries the art (workflow tints, avatars, bars, the sword). With NO_COLOR
 * every helper becomes an identity function and the half-block cells become
 * blanks, so the view degrades to text without ever emitting colour.
 */
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { TerminalColorMode } from "@earendil-works/pi-tui";
import type { HalfBlockStyle, Rgb } from "../avatar/halfblock.ts";

export interface ViewTheme {
  fg(color: ThemeColor, text: string): string;
  bold(text: string): string;
  getColorMode(): TerminalColorMode;
}

export interface ViewEnvironment {
  noColor: boolean;
  reducedMotion: boolean;
}

export interface Styles {
  readonly color: boolean;
  readonly motion: boolean;
  bold(text: string): string;
  dim(text: string): string;
  accent(text: string): string;
  success(text: string): string;
  error(text: string): string;
  warning(text: string): string;
  muted(text: string): string;
  /** Workflow tint as a 256-colour foreground. */
  tint(index: number, text: string): string;
  /** A bright, art-level colour (used by the sword and the shimmer). */
  bright(index: number, text: string): string;
  halfBlock: HalfBlockStyle;
}

/** Nearest xterm-256 index for an RGB triple (6x6x6 cube + 24-step grey ramp). */
export function nearest256(color: Rgb): number {
  const toCube = (value: number) => Math.round((value / 255) * 5);
  const cube =
    16 + 36 * toCube(color.r) + 6 * toCube(color.g) + toCube(color.b);
  const grey = Math.round(((color.r + color.g + color.b) / 3 / 255) * 23);
  const greyIndex = 232 + grey;
  const greyValue = Math.round((grey / 23) * 255);
  const cubeValue = {
    r: Math.round((toCube(color.r) / 5) * 255),
    g: Math.round((toCube(color.g) / 5) * 255),
    b: Math.round((toCube(color.b) / 5) * 255),
  };
  const distance = (a: Rgb, b: Rgb) =>
    (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;
  const greyDistance = distance(color, {
    r: greyValue,
    g: greyValue,
    b: greyValue,
  });
  return greyDistance < distance(color, cubeValue) ? greyIndex : cube;
}

const RESET = "\x1b[0m";
const BG_DEFAULT = "\x1b[49m";

function identity(text: string): string {
  return text;
}

export function createStyles(
  theme: ViewTheme,
  environment: ViewEnvironment,
): Styles {
  const color = !environment.noColor;
  const mode = theme.getColorMode();
  const tint256 = (index: number) => (text: string) =>
    `\x1b[38;5;${index}m${text}${RESET}`;
  const fgRgb = (value: Rgb) =>
    mode === "truecolor"
      ? `\x1b[38;2;${value.r};${value.g};${value.b}m`
      : `\x1b[38;5;${nearest256(value)}m`;
  const bgRgb = (value: Rgb) =>
    mode === "truecolor"
      ? `\x1b[48;2;${value.r};${value.g};${value.b}m`
      : `\x1b[48;5;${nearest256(value)}m`;

  const token = (name: ThemeColor) =>
    color ? (text: string) => theme.fg(name, text) : identity;

  return {
    color,
    motion: !environment.reducedMotion,
    bold: (text) => (color ? theme.bold(text) : text),
    dim: token("dim"),
    accent: token("accent"),
    success: token("success"),
    error: token("error"),
    warning: token("warning"),
    muted: token("muted"),
    tint: (index, text) => (color ? tint256(index)(text) : text),
    bright: (index, text) => (color ? tint256(index)(text) : text),
    halfBlock: {
      fg: (value) => (color ? fgRgb(value) : ""),
      bg: (value) => (color ? bgRgb(value) : ""),
      bgDefault: color ? BG_DEFAULT : "",
      reset: color ? RESET : "",
    },
  };
}
