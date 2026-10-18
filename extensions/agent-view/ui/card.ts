/**
 * One agent card: model-first row, half-block avatar, thought bubble, per-agent
 * progress. Pure given its inputs (frame time, personas, layout), which is what
 * makes the render harness deterministic.
 */
import {
  FLOURISH_OLD_FACE_S,
  FLOURISH_PUFF_END_S,
  FLOURISH_SECONDS,
  LONG_TOOL_SECONDS,
  sparkle,
  SWORD_FRAMES,
} from "../anim/scripts.ts";
import { currentThought } from "../source/derive.ts";
import { promotionRows } from "../anim/promotion.ts";
import { renderToolFeed } from "./tool-feed.ts";
import type { AvatarEngine, PoseName } from "../avatar/poses.ts";
import type { PersonaName } from "../source/history.ts";
import { stateKind, type ChildSnapshot } from "../source/types.ts";
import { RANKS, roleOf } from "../persona.ts";
import { renderBubble, type BubbleInput } from "./bubble.ts";
import { clip, formatDuration, formatPercent, visibleWidth } from "./text.ts";
import type { Styles } from "./style.ts";

export interface CardLayout {
  /** Avatar pixel size (`+`/`-`); 0 hides avatars. */
  avatarPx: number;
  /** Maximum bubble lines. */
  bubbleLines: number;
  /** Maximum bubble width, in columns, including the tail gutter. */
  bubbleWidth: number;
  /** Tree guide for continuation rows (no leading marker column). */
  guide: string;
  /** `├─` or `└─` (no leading marker column). */
  branch: string;
  /** Selection marker prepended to `guide` and `branch` (a space, or `›`). */
  marker: string;
  /** Available width for the header row's right-aligned status. */
  width: number;
}

export interface CardInput {
  child: ChildSnapshot;
  persona: PersonaName;
  previousPersona: PersonaName;
  rank: number;
  previousRank: number;
  /** Animation-clock seconds at the last promotion, or Infinity. */
  levelUpAt: number;
  /** Frame time in seconds. */
  t: number;
  /** Wall clock in ms (for tool age). */
  now: number;
  layout: CardLayout;
  styles: Styles;
  /** Blink frame for this agent, from the shared animation clock. */
  blink: boolean;
  avatar?: AvatarEngine;
  /** Typewriter reveal for the current bubble text, owned by the view. */
  reveal?: { shownText: string; typing: boolean };
  /** Ration the full ceremony; other simultaneous promotions keep a compact banner. */
  fullPromotion?: boolean;
}

const POOF = ["✦", "✧", "·", "*", "+"];

function hash(value: string): number {
  let h = 2166136261;
  for (const char of value) {
    h ^= char.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function poofRows(px: number, t: number, styles: Styles): string[] {
  const rows = Math.max(1, Math.ceil(px / 2));
  const columns = Math.max(2, px);
  const frame = Math.floor(t * 20);
  const lines: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    let line = "";
    for (let column = 0; column < columns; column += 1) {
      line +=
        (hash(`${row},${column}`) + frame) % 5 === 0
          ? styles.warning(POOF[(row + column + frame) % POOF.length])
          : " ";
    }
    lines.push(line);
  }
  return lines;
}

function isBashTool(child: ChildSnapshot): boolean {
  const name = child.activity.toolName?.toLowerCase();
  return name === "bash" || name === "powershell";
}

function longToolOpen(child: ChildSnapshot, now: number): boolean {
  if (!isBashTool(child) || child.activity.toolStartedAt === undefined)
    return false;
  return now - child.activity.toolStartedAt > LONG_TOOL_SECONDS * 1000;
}

/** Pose for the current state, matching spike/demo.mjs. */
export function poseFor(
  child: ChildSnapshot,
  t: number,
  levelUpAt: number,
  blink: boolean,
  now: number,
): PoseName {
  if (t - levelUpAt >= 0 && t - levelUpAt < FLOURISH_SECONDS) return "happy";
  if (child.stale) return "mad";
  if (!child.active) return child.failed ? "mad" : "happy";
  if (child.activity.longRunning || longToolOpen(child, now)) return "sleepy";
  if (blink) return "sleepy";
  if (child.verdict) return "smug";
  if (currentThought(child.activity)) return "thinking";
  return "idle";
}

/** Sword: `†✧──` with a sweeping glint and a `⚔` flash. */
export function swordFrame(t: number, styles: Styles): string {
  const frame = SWORD_FRAMES[Math.floor(t * 9) % SWORD_FRAMES.length];
  return frame
    .map((cell, index) => {
      if (index === 0) return styles.warning(cell);
      if (cell === "✧") return styles.bright(231, "✧");
      if (cell === " ") return " ";
      return styles.bright(45, cell);
    })
    .join("");
}

function bubbleFor(input: CardInput): BubbleInput | undefined {
  const { child, t, levelUpAt, styles } = input;
  const promoing = t - levelUpAt < FLOURISH_SECONDS;
  if (styles.motion && promoing && child.active) {
    return {
      kind: "promo",
      promo: {
        rankName: RANKS[input.rank]?.name ?? "Banneret",
        previousName: input.previousPersona.name,
        name: input.persona.name,
        noun: input.persona.noun,
        sparkle: input.styles.motion ? sparkle(t) : "✦",
      },
    };
  }
  if (child.verdict) {
    return {
      kind: "verdict",
      verdict: { ...child.verdict, confident: child.verdict.confident },
    };
  }
  if (child.stale) {
    const text = `stale · no live process for this run`;
    return { kind: "say", text, shownText: text };
  }
  if (child.failed) {
    const text =
      child.error ??
      child.activity.error ??
      child.activity.text ??
      `failed · ${child.state}`;
    return { kind: "say", text, shownText: text };
  }
  if (!child.active) {
    const text =
      child.activity.text ??
      child.activity.tool ??
      `done · ${formatDuration(child.elapsedMs)}`;
    return { kind: "say", text, shownText: text };
  }
  const activity = child.activity;
  const thought = currentThought(activity);
  if (thought) {
    return {
      kind: "think",
      text: thought,
      shownText: input.reveal?.shownText,
      typing: input.reveal?.typing,
      dots: input.reveal?.typing
        ? styles.dim(styles.motion ? "." : "")
        : undefined,
    };
  }
  if (activity.text)
    return { kind: "say", text: activity.text, shownText: activity.text };
  if (activity.thinkingDropped)
    return { kind: "state", text: `thinking redacted · ${child.state}` };
  return { kind: "state", text: child.state };
}

function statusSuffix(child: ChildSnapshot, styles: Styles): string {
  const duration = styles.dim(`· ${formatDuration(child.elapsedMs)}`);
  if (child.stale) return `${styles.warning("⚠ stale")} ${duration}`;
  if (!child.active) {
    switch (stateKind(child.state)) {
      case "failed":
        return `${styles.error("✗ failed")} ${duration}`;
      case "done":
        return `${styles.success("✓ done")} ${duration}`;
      case "stopped":
        return `${styles.warning("○ stopped")} ${duration}`;
      case "queued":
        return `${styles.muted("○ queued")} ${duration}`;
      default:
        return `${styles.warning(`? ${child.state}`)} ${duration}`;
    }
  }
  const state = child.activity.longRunning
    ? styles.warning("● long-running")
    : styles.success("● running");
  const percent =
    child.progress > 0 ? ` · ~${formatPercent(child.progress)}` : "";
  return `${state} ${styles.dim(`· ${formatDuration(child.elapsedMs)}${percent}`)}`;
}

/**
 * A single run's key is a 36-character run id; the row shows the short id
 * instead. Workflow child keys (`review-AF4-0`) are already short and stay.
 */
function displayKey(child: ChildSnapshot): string {
  if (child.key.length <= 18) return child.key;
  return (child.runId || child.key).slice(0, 8);
}

function terminalMark(child: ChildSnapshot, styles: Styles): string {
  if (child.stale) return styles.warning("⚠");
  switch (stateKind(child.state)) {
    case "failed":
      return styles.error("✗");
    case "done":
      return styles.success("✓");
    case "stopped":
      return styles.warning("○");
    case "queued":
      return styles.muted("○");
    default:
      return styles.muted("?");
  }
}

function modelLabel(child: ChildSnapshot, styles: Styles): string {
  return child.effort
    ? `${styles.accent(child.model)} ${styles.dim(`· ${child.effort}`)}`
    : styles.accent(child.model);
}

/**
 * The card's first row, fitted by priority: the model and the stable `[key]`
 * chip survive every width, while `the <noun>`, the thinking effort, the rank
 * name and finally the model itself give way in that order.
 */
function headerFor(input: CardInput, mark: string, branch: string): string {
  const { child, styles, layout } = input;
  const rank = RANKS[input.rank] ?? RANKS[0];
  const sword = child.isClef ? `  ${swordFrame(input.t, styles)}` : "";
  const key = styles.dim(`[${displayKey(child)}]`);
  const promotedAge = input.t - input.levelUpAt;
  const badge =
    styles.motion && promotedAge >= 0 && promotedAge < FLOURISH_SECONDS + 20
      ? ` ${styles.warning("NEW")}`
      : "";
  const name = `${styles.bold(input.persona.name)}${badge}`;
  const variants = [
    `${branch} ${mark} ${modelLabel(child, styles)}  ${styles.warning(rank.glyph)} ${styles.dim(rank.name)} ${name} ${styles.dim(`the ${input.persona.noun}`)} ${key}${sword}`,
    `${branch} ${mark} ${modelLabel(child, styles)}  ${styles.warning(rank.glyph)} ${name} ${key}${sword}`,
    `${branch} ${mark} ${modelLabel(child, styles)}  ${name} ${key}`,
    `${branch} ${mark} ${styles.accent(child.model)} ${name} ${key}`,
    `${branch} ${mark} ${name} ${key}`,
    `${branch} ${mark} ${key}`,
  ];
  for (const variant of variants) {
    if (visibleWidth(variant) <= layout.width) return variant;
  }
  return clip(variants[variants.length - 1], layout.width);
}

/**
 * Rows for one child. Returns lines already clipped to the layout width; the
 * caller maps them to the child key for selection.
 */
export function renderCard(input: CardInput): string[] {
  const { child, layout, styles } = input;
  // The marker replaces the branch's leading column so the tree stays aligned.
  const branch = `${layout.marker}${layout.branch}`;
  const guide = `${layout.marker}${layout.guide}`;

  if (child.queued) {
    const model = child.effort
      ? `${child.model} · ${child.effort}`
      : child.model;
    const awaits = `queued · ${child.key} · a ${roleOf(child.roleKey).label} awaits`;
    return [
      clip(
        `${styles.muted(branch)} ${styles.muted("○")} ${styles.muted(model)}  ${styles.muted(awaits)}`,
        layout.width,
      ),
    ];
  }

  if (
    !child.active &&
    input.layout.bubbleLines > 1 &&
    child.isClef &&
    child.verdict
  ) {
    // A finished classifier keeps its verdict visible: that is its deliverable.
  } else if (!child.active) {
    const mark = terminalMark(child, styles);
    const reason = child.error ? ` ${styles.dim(`· ${child.error}`)}` : "";
    return [
      clip(
        `${headerFor(input, mark, styles.muted(branch))}  ${statusSuffix(child, styles)}${reason}`,
        layout.width,
      ),
    ];
  }

  const mark = child.activity.longRunning
    ? styles.warning("▸")
    : styles.success("▸");
  const header = headerFor(input, mark, styles.muted(branch));
  const suffix = statusSuffix(child, styles);
  const headerWidth = visibleWidth(header);
  const suffixWidth = visibleWidth(suffix);
  const rows: string[] = [];
  rows.push(
    headerWidth + suffixWidth + 1 <= layout.width
      ? `${header}${" ".repeat(layout.width - headerWidth - suffixWidth)}${suffix}`
      : header,
  );

  const bubble = bubbleFor(input);
  const bubbleRows = bubble
    ? renderBubble(bubble, {
        width: layout.bubbleWidth,
        styles,
        maxLines: layout.bubbleLines,
      })
    : [];

  if (layout.avatarPx > 0 && input.avatar) {
    const promoing = input.t - input.levelUpAt;
    const face =
      promoing < FLOURISH_OLD_FACE_S ? input.previousPersona : input.persona;
    const pose = poseFor(
      child,
      input.t,
      input.levelUpAt,
      input.blink,
      input.now,
    );
    const avatarRows =
      promoing >= FLOURISH_OLD_FACE_S && promoing < FLOURISH_PUFF_END_S
        ? poofRows(layout.avatarPx, input.t, styles)
        : input.avatar.rows(face.name, pose, layout.avatarPx);
    const offset = Math.max(
      0,
      Math.floor((avatarRows.length - bubbleRows.length) / 2),
    );
    avatarRows.forEach((row, index) => {
      rows.push(
        clip(
          `${guide}${row}  ${bubbleRows[index - offset] ?? ""}`,
          layout.width,
        ),
      );
    });
  } else if (bubble) {
    const text =
      bubble.kind === "verdict" && bubble.verdict
        ? [
            `⚖ ${bubble.verdict.label} ${bubble.verdict.p.toFixed(2)}`,
            bubble.verdict.action ?? "(no action)",
            bubble.verdict.p >= 0.9 ? "(confident)" : "(below the 0.9 gate)",
          ].join(" ")
        : (bubble.text ?? bubble.tool ?? "");
    if (text.trim().length > 0)
      rows.push(clip(`${guide}${styles.dim(`⎿ ${text}`)}`, layout.width));
  }
  const contentWidth = Math.max(1, layout.width - visibleWidth(guide) - 2);
  for (const row of renderToolFeed(child.activity, styles, contentWidth)) {
    rows.push(clip(`${guide}  ${row}`, layout.width));
  }
  const ceremony = promotionRows(
    input.t,
    input.levelUpAt,
    input.persona.name,
    RANKS[input.rank]?.name ?? "Banneret",
    input.rank,
    contentWidth,
    styles,
    input.fullPromotion ?? true,
  );
  // Reserve the ceremony lane even at rest; promotions never shift neighbouring cards.
  for (let index = 0; index < 2; index += 1) {
    rows.push(clip(`${guide}  ${ceremony[index] ?? ""}`, layout.width));
  }
  return rows;
}
