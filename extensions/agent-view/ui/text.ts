/**
 * Width-safe helpers built on pi-tui's measurement so every returned line fits
 * the overlay width (ANSI, wide characters and half-blocks included).
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  cropKittyImageLine,
  getKittyImageMetadata,
} from "@earendil-works/pi-tui/dist/terminal-image.js";

export { truncateToWidth, visibleWidth };

/** Crop image placements to the visible body so avatars cannot paint over the footer. */
export function cropImageRows(lines: string[]) {
  return lines.map((line, index) => {
    const rows = getKittyImageMetadata(line)?.rows;
    const available = lines.length - index;
    return rows !== undefined && rows > available
      ? cropKittyImageLine(line, 0, available)
      : line;
  });
}

export function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const clipped = truncateToWidth(text, width, "…");
  // pi-tui's truncate wraps the result in SGR resets even when the input has
  // no ANSI at all; NO_COLOR output must never carry an escape sequence.
  return text.includes("\x1b") ? clipped : clipped.replace(/\x1b\[0m/g, "");
}

/**
 * Clip plain text from the left, keeping its tail behind a leading ellipsis.
 * For paths, whose file name is the informative end. Input must carry no ANSI;
 * style the result afterwards.
 */
export function clipStart(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  if (width === 1) return "…";
  const characters = Array.from(text);
  let tail = "";
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const next = `${characters[index]}${tail}`;
    if (visibleWidth(next) > width - 1) break;
    tail = next;
  }
  return `…${tail}`;
}

export function padTo(text: string, width: number): string {
  const padding = width - visibleWidth(text);
  return padding > 0 ? `${text}${" ".repeat(padding)}` : clip(text, width);
}

/** Left text, right text, one space minimum between them. */
export function leftRight(left: string, right: string, width: number): string {
  const rightWidth = Math.min(visibleWidth(right), Math.max(0, width - 1));
  const leftWidth = Math.max(0, width - rightWidth - 1);
  const trimmedRight = clip(right, rightWidth);
  return `${padTo(left, leftWidth)}${" ".repeat(Math.max(1, width - leftWidth - visibleWidth(trimmedRight)))}${trimmedRight}`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export function formatTokens(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k`;
  return String(total);
}

export function formatPercent(fraction: number): string {
  return `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

/** Local wall-clock `HH:MM`, for a run's start time. */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** `$3.28` / `$0.045`; work is never free, but runs may publish no cost at all. */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0";
  return usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

/** `2h14m ago` / `just now`, for an age measured from the current clock. */
export function formatAgoPhrase(ageMs: number): string {
  if (ageMs < 60_000) return "just now";
  return `${formatDuration(ageMs)} ago`;
}

/** `1 run` / `4 runs` — a count is never printed with the wrong noun. */
export function countNoun(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * `~2m30s left` / `~2m30s left (seen)` — never presented as exact — or
 * `overrunning · typical 2m30s` once the elapsed time has passed the estimate.
 */
export function formatEta(
  ms: number,
  inventoryComplete: boolean,
  typicalMs?: number,
): string {
  if (ms <= 0) {
    return typicalMs !== undefined && typicalMs > 0
      ? `overrunning · typical ${formatDuration(typicalMs)}`
      : "overrunning";
  }
  const base = `${formatDuration(ms)} left`;
  return inventoryComplete ? `~${base}` : `~${base} (seen)`;
}

/** Wrap plain text (no ANSI) on spaces to `width` columns, at most `maxLines`. */
export function wrapPlain(
  text: string,
  width: number,
  maxLines: number,
): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (visibleWidth(`${current} ${word}`) > width) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    } else {
      current = `${current} ${word}`;
    }
  }
  if (lines.length < maxLines && current.length > 0) lines.push(current);
  const clipped = lines.slice(0, maxLines).map((line) => clip(line, width));
  return clipped;
}
