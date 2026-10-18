/**
 * Eighth-block progress bar with a shimmer that sweeps the filled part while
 * anything runs. Progress is an estimate (pi-subagents publishes no total), so
 * the caller labels the percentage with `~`.
 */
import { shimmerIndex } from "../anim/scripts.ts";
import type { Styles } from "./style.ts";

export interface BarInput {
  progress: number;
  width: number;
  tint: number;
  /** True while at least one child is running: gates the shimmer. */
  active: boolean;
  /** Frame time in seconds. */
  t: number;
  /** The total is unknown: sweep a window instead of filling a fraction. */
  indeterminate?: boolean;
}

const BLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** Filled part: mixes the tint toward brighter 256-colours as it approaches the end. */
export function renderBar(input: BarInput, styles: Styles): string {
  const width = Math.max(8, Math.floor(input.width));
  if (input.indeterminate) return renderIndeterminate(input, width, styles);
  const fraction = Math.min(1, Math.max(0, input.progress));
  const cells = Math.round(fraction * width * 8);
  const full = Math.floor(cells / 8);
  const part = cells % 8;
  const shimmer =
    input.active && styles.motion ? shimmerIndex(input.t, full) : -99;
  let out = "";
  for (let index = 0; index < width; index += 1) {
    if (index < full) {
      const tint =
        index < full * 0.5 ? input.tint : index < full * 0.8 ? 38 : 45;
      out +=
        index === shimmer || index === shimmer + 1
          ? styles.bright(231, "█")
          : styles.bright(tint, "█");
    } else if (index === full && part > 0) {
      out += styles.bright(45, BLOCKS[part]);
    } else {
      out += styles.dim("░");
    }
  }
  return out;
}

/** No total is known, so a window sweeps the bar; static mode shows a flat rail. */
function renderIndeterminate(
  input: BarInput,
  width: number,
  styles: Styles,
): string {
  if (!styles.motion) return styles.dim("░".repeat(width));
  const window = Math.max(2, Math.round(width / 6));
  // Wrap around, so the sweep is visible on every frame.
  const offset = Math.floor(input.t * window * 1.5) % width;
  let out = "";
  for (let index = 0; index < width; index += 1) {
    const inside = (index - offset + width) % width < window;
    out += inside ? styles.bright(45, "█") : styles.dim("░");
  }
  return out;
}
