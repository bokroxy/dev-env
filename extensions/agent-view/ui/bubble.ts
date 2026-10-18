/**
 * Thought bubbles with an arrow tail (`◂─`) pointing at the avatar. Sizing is
 * computed from the FINAL text, never from the revealed text, so a typewriter
 * reveal cannot resize the box; a shorter reveal only leaves blanks.
 */
import { confidenceBar, VERDICT_GATE } from "../anim/scripts.ts";
import { clip, padTo, visibleWidth, wrapPlain } from "./text.ts";
import type { Styles } from "./style.ts";

export type BubbleKind =
  "think" | "say" | "tool" | "promo" | "verdict" | "state";

export interface BubbleInput {
  kind: BubbleKind;
  /** Final text: sizing input for think/say/state. */
  text?: string;
  /** Revealed prefix while typing. */
  shownText?: string;
  typing?: boolean;
  dots?: string;
  /** `read: /path` for the tool variant. */
  tool?: string;
  verdict?: { label: string; p: number; action?: string; confident: boolean };
  promo?: {
    rankName: string;
    previousName: string;
    name: string;
    noun: string;
    sparkle: string;
  };
}

export interface BubbleOptions {
  /** Maximum total width of the tail gutter plus the box. */
  width: number;
  styles: Styles;
  maxLines?: number;
}

const MIN_BOX = 12;
const MAX_BOX = 76;

/** The plain body lines of a bubble, before box sizing. */
function plainBody(
  input: BubbleInput,
  inner: number,
  maxLines: number,
): string[] {
  switch (input.kind) {
    case "promo": {
      const promo = input.promo;
      if (!promo) return ["promoted!"];
      return [
        `${promo.sparkle} promoted to ${promo.rankName}! ${promo.sparkle}`,
        `${promo.previousName} is now ${promo.name} the ${promo.noun}`,
      ];
    }
    case "tool": {
      const tool = input.tool ?? "";
      const [name] = tool.split(":");
      return [`⚙ ${name}${input.dots ?? ""}`];
    }
    case "verdict": {
      const verdict = input.verdict;
      if (!verdict) return ["⚖ verdict unavailable"];
      const gate = verdict.p >= VERDICT_GATE;
      const action = verdict.action
        ? `→ ${verdict.action} ${gate ? "(confident)" : "(below the 0.9 gate)"}`
        : "→ (no action)";
      return [
        `⚖ ${verdict.label}  ▕${confidenceBar(verdict.p)}▏ ${verdict.p.toFixed(2)}`,
        action,
      ];
    }
    case "state": {
      return wrapPlain(input.text ?? "", inner, 1);
    }
    default: {
      const finalText = input.text ?? "";
      const lines = wrapPlain(finalText || " ", inner, maxLines);
      return lines.length > 0 ? lines : [""];
    }
  }
}

function styledBody(
  input: BubbleInput,
  lines: string[],
  inner: number,
  maxLines: number,
  styles: Styles,
): string[] {
  switch (input.kind) {
    case "promo":
      return lines.map((line, index) =>
        index === 0 ? styles.warning(line) : styles.dim(line),
      );
    case "tool":
      return lines.map((line) => styles.warning(line));
    case "verdict": {
      const verdict = input.verdict;
      const gate = (verdict?.p ?? 0) >= VERDICT_GATE;
      return lines.map((line, index) => {
        if (index === 0) {
          const label = verdict?.label ?? "";
          const tail = line.slice(2 + label.length + 2);
          return `${styles.warning("⚖ ")}${styles.bold(label)}  ${tail}`;
        }
        return gate ? styles.success(line) : styles.warning(line);
      });
    }
    case "state":
      return lines.map((line) => styles.muted(line));
    case "say":
      return lines.map((line) => styles.muted(line));
    default: {
      const body: string[] = [];
      const revealed = input.shownText ?? input.text ?? "";
      const shownLines =
        revealed.length > 0 ? wrapPlain(revealed, inner, maxLines) : [];
      for (let index = 0; index < lines.length; index += 1) {
        const line = index < shownLines.length ? shownLines[index] : "";
        const isLast = index === lines.length - 1;
        const decorated =
          input.typing && isLast ? `${line}${input.dots ?? ""}` : line;
        body.push(styles.dim(decorated));
      }
      return body;
    }
  }
}

/** Rounded box plus the `◂─` tail, clipped to the overlay width. */
export function renderBubble(
  input: BubbleInput,
  options: BubbleOptions,
): string[] {
  const styles = options.styles;
  const width = Math.max(MIN_BOX + 6, Math.floor(options.width));
  const maxLines = options.maxLines ?? 2;
  const inner = Math.max(4, width - 6);

  const plain =
    input.kind === "promo" || input.kind === "verdict"
      ? plainBody(input, inner, 2)
      : plainBody(input, inner, maxLines);
  const widths = plain.map((line) => visibleWidth(line));
  const boxWidth = Math.min(inner, MAX_BOX, Math.max(MIN_BOX, ...widths));
  const body = styledBody(input, plain, inner, maxLines, styles);

  const grey = styles.muted;
  const top = grey(`╭${"─".repeat(boxWidth + 2)}╮`);
  const bottom = grey(`╰${"─".repeat(boxWidth + 2)}╯`);
  const middle = body.map(
    (line) =>
      `${grey("│ ")}${padTo(clip(line, boxWidth), boxWidth)}${grey(" │")}`,
  );
  const lines = [top, ...middle, bottom];
  const tailRow = Math.floor(lines.length / 2);
  return lines.map(
    (line, index) => `${index === tailRow ? grey("◂─") : "  "}${line}`,
  );
}

/** Width of a rendered bubble (for layout decisions in tests and the view). */
export function bubbleWidth(lines: string[]): number {
  return lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
}
