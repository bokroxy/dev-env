/**
 * The `/agents` overlay component. Owns selection, scrolling, the animation
 * clock, persona promotions, the typewriter reveal and the inline detail pane.
 * All data comes from RunScanner; all rendering is pure per frame.
 */
import { matchesKey } from "@earendil-works/pi-tui";
import * as path from "node:path";
import { Clock } from "../anim/clock.ts";
import {
  FLOURISH_SECONDS,
  isBlinking,
  spinnerFrame,
  typewriter,
} from "../anim/scripts.ts";
import type { AvatarEngine } from "../avatar/poses.ts";
import { currentThought } from "../source/derive.ts";
import { hashKey, PersonaBook, rankIndex } from "../persona.ts";
import type { PersonaName } from "../source/history.ts";
import { readTailLines } from "../source/tail.ts";
import {
  isTerminalState,
  stateKind,
  type ChildSnapshot,
  type ViewSnapshot,
  type WorkflowSnapshot,
} from "../source/types.ts";
import type { RunScanner } from "../source/runs.ts";
import { redact } from "../source/redact.ts";
import { renderBar } from "./bar.ts";
import { renderBubble } from "./bubble.ts";
import { renderCard, type CardLayout } from "./card.ts";
import { rootState, workflowBar, type RootTone } from "./status.ts";
import {
  createStyles,
  type Styles,
  type ViewEnvironment,
  type ViewTheme,
} from "./style.ts";
import {
  clip,
  clipStart,
  cropImageRows,
  countNoun,
  formatAgoPhrase,
  formatClock,
  formatCost,
  formatDuration,
  formatTokens,
  leftRight,
  padTo,
  visibleWidth,
} from "./text.ts";

export interface TuiLike {
  terminal?: { rows?: number; columns?: number };
  requestRender(): void;
}

export interface AgentViewOptions {
  scanner: RunScanner;
  theme: ViewTheme;
  tui: TuiLike;
  done: (result: undefined) => void;
  avatar?: AvatarEngine;
  environment?: ViewEnvironment;
  now?: () => number;
  avatarPx?: number;
  personaStore?: import("../source/history.ts").PersonaStore;
  /**
   * Share of the terminal height the component may use. The overlay renders at
   * `maxHeight: "85%"`, so the body is sized from the same fraction and the
   * footer with the key hints is never clipped away. The standalone watcher
   * owns the whole terminal and passes 1.
   */
  heightFraction?: number;
}

interface RankState {
  rank: number;
  previousRank: number;
  levelUpAt: number;
  fullPromotion?: boolean;
}

interface RevealState {
  text: string;
  startedAt: number;
}

interface BodyRow {
  text: string;
  key?: string;
}

interface Block {
  lines: string[];
  keys: (string | undefined)[];
  children: ChildSnapshot[];
}

const WIDE = 140;
const MEDIUM = 100;
const SMALL = 60;
const DEFAULT_ROWS = 32;
const MIN_AVATAR_PX = 6;
const MAX_AVATAR_PX = 22;
/** How many finished roots the Recent list shows before `h` expands it. */
const RECENT_CAP = 5;
/** Selection keys of finished roots: `root:<runId>`. */
const ROOT_KEY_PREFIX = "root:";

function rootKey(runId: string): string {
  return `${ROOT_KEY_PREFIX}${runId}`;
}

function rootRunIdOf(key: string): string | undefined {
  return key.startsWith(ROOT_KEY_PREFIX)
    ? key.slice(ROOT_KEY_PREFIX.length)
    : undefined;
}
/** pi-tui's `maxHeight: "85%"` on the overlay. */
const OVERLAY_HEIGHT_FRACTION = 0.85;
/** The overlay keeps a one-row margin above and below (index.ts). */
const OVERLAY_MARGIN_ROWS = 2;

export class AgentViewComponent {
  private readonly scanner: RunScanner;
  private readonly theme: ViewTheme;
  private readonly tui: TuiLike;
  private readonly done: (result: undefined) => void;
  private avatar?: AvatarEngine;
  private readonly noColor: boolean;
  private readonly now: () => number;
  private readonly clock: Clock;
  private readonly personas: PersonaBook;
  private readonly personaStore?: import("../source/history.ts").PersonaStore;
  private readonly rankState = new Map<string, RankState>();
  private readonly reveals = new Map<string, RevealState>();
  private lastFullPromotionAt = Number.NEGATIVE_INFINITY;
  private readonly heightFraction: number;
  private startedAt: number;
  private snapshot: ViewSnapshot;
  private styles: Styles;
  private motion: boolean;
  private avatarPx: number;
  private runningOnly = false;
  private historyExpanded = false;
  private selectedKey: string | undefined;
  private selected = 0;
  /** Scroll offset the selection requires; `scrollPast` moves beyond it. */
  private scrollBase = 0;
  private scroll = 0;
  /**
   * Extra rows scrolled past the selection, so the workflow bar and the Recent
   * list below the last selectable card can be brought into view.
   */
  private scrollPast = 0;
  private detail?: {
    key: string;
    title: string;
    path: string;
    lines: string[];
    scroll: number;
  };
  private lastRenderLines: string[] = [];
  private disposed = false;
  /** Card builds per frame: one body composition, no re-render for the keys. */
  private cardBuilds = 0;

  constructor(options: AgentViewOptions) {
    this.scanner = options.scanner;
    this.theme = options.theme;
    this.tui = options.tui;
    this.done = options.done;
    this.avatar = options.avatar;
    this.now = options.now ?? (() => Date.now());
    this.noColor = options.environment?.noColor === true;
    this.motion = options.environment?.reducedMotion !== true && !this.noColor;
    this.avatarPx = options.avatarPx ?? 14;
    this.heightFraction = Math.min(
      1,
      Math.max(0.3, options.heightFraction ?? OVERLAY_HEIGHT_FRACTION),
    );
    this.styles = this.buildStyles();
    this.personaStore = options.personaStore;
    this.personas = new PersonaBook(options.personaStore);
    this.startedAt = this.now();
    this.snapshot = options.scanner.snapshot();
    this.clock = new Clock(() => this.tick());
    this.ensureSelection();
  }

  /** Start the animation/data clock. The overlay calls this on open. */
  start(): void {
    this.ensureSelection();
    this.clock.setPeriod(this.periodMs());
    this.clock.start();
    this.tui.requestRender();
  }

  /**
   * Attach the avatar engine after mounting. The watcher loads it
   * asynchronously; the overlay passes it to the constructor instead.
   */
  setAvatar(avatar: AvatarEngine | undefined): void {
    this.avatar = avatar;
    this.tui.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clock.stop();
    this.scanner.durationBook.save();
    if (this.personas.isDirty) {
      this.personaStore?.save();
      this.personas.markSaved();
    }
  }

  private buildStyles(): Styles {
    return createStyles(this.theme, {
      noColor: this.noColor,
      reducedMotion: !this.motion,
    });
  }

  private periodMs(): number {
    if (!this.motion) return 1000;
    if (this.lastRenderLines.some((line) => line.includes("PROMOTED")))
      return 50;
    return this.animating() ? 100 : 500;
  }

  private frame(): number {
    return (this.now() - this.startedAt) / 1000;
  }

  /** Frame time used for art: frozen at 0 in static mode. */
  private artTime(): number {
    return this.motion ? this.frame() : 0;
  }

  private animating(): boolean {
    if (!this.motion) return false;
    // A live workflow animates even while all its children are queued.
    if (this.snapshot.workflows.some((workflow) => workflow.live)) return true;
    const t = this.artTime();
    for (const state of this.rankState.values()) {
      if (t - state.levelUpAt < FLOURISH_SECONDS) return true;
    }
    return false;
  }

  /** One clock tick: refresh data, advance promotions, redraw once. */
  tick(): void {
    if (this.disposed) return;
    const changed = this.scanner.poll();
    // `levelUpAt` is stored in the same time base the cards are drawn with, so
    // a promotion ends even when the art clock is frozen.
    const promotions = this.updateRanks(this.artTime());
    this.ensureSelection();
    if (!this.motion) {
      if (changed || promotions) this.tui.requestRender();
    } else {
      this.tui.requestRender();
    }
    this.clock.setPeriod(this.periodMs());
  }

  /** The first selectable agent is selected by default; a vanished key re-selects. */
  private ensureSelection(): void {
    const keys = this.selectableKeys();
    if (keys.length === 0) return;
    if (this.selectedKey === undefined || !keys.includes(this.selectedKey)) {
      this.selected = 0;
      this.selectedKey = keys[0];
      // The vanished row may have owned the free scroll; the new selection is
      // above it, so the offset must not survive it.
      this.scrollPast = 0;
    }
  }

  private updateRanks(t: number): boolean {
    const snapshot = this.scanner.snapshot();
    this.snapshot = snapshot;
    let promotions = false;
    for (const workflow of snapshot.workflows) {
      for (const child of workflow.children) {
        const desired = rankIndex(child.progress);
        const state = this.rankState.get(child.rowKey);
        if (!state) {
          this.rankState.set(child.rowKey, {
            rank: desired,
            previousRank: desired,
            levelUpAt: Number.NEGATIVE_INFINITY,
          });
          continue;
        }
        if (desired > state.rank) {
          state.previousRank = state.rank;
          state.rank = desired;
          // Static mode has no running clock, so the flourish is skipped
          // outright instead of comparing against a frozen `t` forever.
          state.levelUpAt = this.motion ? t : Number.NEGATIVE_INFINITY;
          state.fullPromotion =
            this.motion && child.active && t - this.lastFullPromotionAt >= 10;
          if (state.fullPromotion) this.lastFullPromotionAt = t;
          promotions = true;
        }
      }
    }
    return promotions;
  }

  private childPersonas(child: ChildSnapshot): {
    persona: PersonaName;
    previousPersona: PersonaName;
  } {
    const state = this.rankState.get(child.rowKey) ?? {
      rank: rankIndex(child.progress),
      previousRank: 0,
      levelUpAt: Number.NEGATIVE_INFINITY,
    };
    const runId = child.runId || child.key;
    const persona = this.personas.persona(
      runId,
      child.key,
      child.roleKey,
      state.rank,
    );
    const previousRank = Math.min(state.previousRank, state.rank);
    const previousPersona =
      previousRank === state.rank
        ? persona
        : this.personas.persona(runId, child.key, child.roleKey, previousRank);
    return { persona, previousPersona };
  }

  private revealFor(
    child: ChildSnapshot,
    text: string,
    frame: number,
  ): { shownText: string; typing: boolean } {
    const key = `${child.rowKey}|${text}`;
    const existing = this.reveals.get(key);
    // Static mode never types: the bubble shows the whole line from the first frame.
    if (!this.motion) {
      if (!existing) this.reveals.set(key, { text, startedAt: frame });
      return { shownText: text, typing: false };
    }
    if (!existing || existing.text !== text) {
      this.reveals.set(key, { text, startedAt: frame });
      if (this.reveals.size > 200) {
        const oldest = this.reveals.keys().next().value;
        if (oldest !== undefined && oldest !== key) this.reveals.delete(oldest);
      }
      return { shownText: "", typing: true };
    }
    const reveal = typewriter({
      text,
      startedAt: existing.startedAt,
      now: frame,
    });
    return { shownText: reveal.text, typing: !reveal.done };
  }

  private buildBlocks(width: number, workflows: WorkflowSnapshot[]): Block[] {
    const blocks: Block[] = [];
    this.cardBuilds += 1;
    // Keep one native image placement per row; glyph avatars can still use the grid.
    const twoColumn = width >= WIDE && !this.avatar?.graphics;
    const columnWidth = twoColumn
      ? Math.max(40, Math.floor((width - 2) / 2))
      : width;
    // The tiers are the brief's terminal-width tiers (>=140 grid, 100-139 one
    // column, 60-99 small, <60 text only). The avatar size is decided on the
    // terminal width, not on the column: a 69-column grid column is not a small
    // terminal, and `+`/`-` must keep changing the avatar there.
    const small = width < MEDIUM && width >= SMALL;
    const tight = width < SMALL;
    const avatarPx = small
      ? Math.max(MIN_AVATAR_PX, Math.min(8, this.avatarPx))
      : this.avatarPx;
    const showAvatar = !tight && !this.noColor && this.avatar !== undefined;
    // Bubble lines stay a property of the column, as before.
    const bubbleLines = columnWidth < MEDIUM ? 1 : 2;
    const frame = this.artTime();
    const wallClock = this.now();

    for (const workflow of workflows) {
      const visibleChildren = this.runningOnly
        ? workflow.children.filter((child) => child.active)
        : workflow.children;
      if (visibleChildren.length === 0) continue;
      const block: Block = { lines: [], keys: [], children: visibleChildren };
      const tint = (text: string) => this.styles.tint(workflow.tint, text);
      block.lines.push(clip(this.workflowHeader(workflow), columnWidth));
      block.keys.push(undefined);

      visibleChildren.forEach((child, index) => {
        const last = index === visibleChildren.length - 1;
        const branch = tint(last ? "└─" : "├─");
        const guide = tint(last ? "   " : "│  ");
        const layout: CardLayout = {
          avatarPx: showAvatar ? avatarPx : 0,
          bubbleLines,
          bubbleWidth: Math.max(18, Math.min(68, columnWidth - avatarPx - 8)),
          guide,
          branch,
          marker:
            this.selectedKey === child.rowKey ? this.styles.accent("›") : " ",
          width: columnWidth,
        };
        const { persona, previousPersona } = this.childPersonas(child);
        const state = this.rankState.get(child.rowKey);
        const thought = currentThought(child.activity);
        const bubbleText = thought ?? child.activity.text ?? "";
        const reveal = bubbleText
          ? this.revealFor(child, bubbleText, this.frame())
          : undefined;
        const rows = renderCard({
          child,
          persona,
          previousPersona,
          rank: state?.rank ?? rankIndex(child.progress),
          previousRank: state?.previousRank ?? 0,
          levelUpAt: state?.levelUpAt ?? Number.NEGATIVE_INFINITY,
          fullPromotion: state?.fullPromotion ?? true,
          t: frame,
          now: wallClock,
          blink: this.motion && isBlinking(frame, hashKey(child.rowKey)),
          layout,
          styles: this.styles,
          ...(this.avatar && showAvatar ? { avatar: this.avatar } : {}),
          ...(reveal ? { reveal } : {}),
        });
        for (const row of rows) {
          block.lines.push(row);
          block.keys.push(child.rowKey);
        }
      });

      const bar = workflowBar(workflow);
      const tone = this.tone(rootState(workflow).tone);
      const barWidth = Math.max(12, Math.min(46, columnWidth - 30));
      const extras = [
        workflow.tokens !== undefined
          ? `${formatTokens(workflow.tokens)} tok`
          : "",
        workflow.costUsd !== undefined ? formatCost(workflow.costUsd) : "",
      ].filter((part) => part.length > 0);
      block.lines.push(
        clip(
          `${tint("    ")}${this.styles.dim("▕")}${renderBar(
            {
              progress: bar.progress,
              width: barWidth,
              tint: workflow.tint,
              active: workflow.live,
              t: frame,
              indeterminate: bar.indeterminate,
            },
            this.styles,
          )}${this.styles.dim("▏")} ${tone(bar.text)}${
            extras.length > 0 ? this.styles.dim(` · ${extras.join(" · ")}`) : ""
          }`,
          columnWidth,
        ),
      );
      block.keys.push(undefined);
      block.lines.push("", "");
      block.keys.push(undefined, undefined);
      blocks.push(block);
    }
    return blocks;
  }

  /**
   * `╶┬ title · cwd · HH:MM · state age · done/seen done · N active`, fitted by
   * the usual clip: the title always survives.
   */
  private workflowHeader(workflow: WorkflowSnapshot): string {
    const tint = (text: string) => this.styles.tint(workflow.tint, text);
    const state = rootState(workflow);
    const age = workflow.live
      ? formatDuration(workflow.elapsedMs)
      : workflow.finishedAt !== undefined
        ? formatAgoPhrase(Math.max(0, this.now() - workflow.finishedAt))
        : "";
    // A single run is titled by its session name, so the cwd basename is the
    // extra identity piece; a workflow title already carries the cwd.
    const cwdLabel =
      workflow.mode === "single" && workflow.sessionName && workflow.cwdName
        ? this.styles.dim(workflow.cwdName)
        : "";
    const parts = [
      this.styles.bold(workflow.title),
      cwdLabel,
      this.styles.dim(formatClock(workflow.startedAt)),
      `${this.tone(state.tone)(`${state.glyph} ${state.text}`)}${age ? ` ${this.styles.dim(age)}` : ""}`,
      this.styles.dim(`${workflow.doneCount}/${workflow.seenCount} done`),
      workflow.activeCount > 0
        ? this.styles.dim(`${workflow.activeCount} active`)
        : "",
      workflow.otherSession ? this.styles.warning("other session") : "",
    ].filter((part) => part.length > 0);
    return `${tint("╶┬")} ${parts.join(" · ")}`;
  }

  private tone(tone: RootTone): (text: string) => string {
    switch (tone) {
      case "running":
      case "done":
        return this.styles.success;
      case "failed":
        return this.styles.error;
      case "queued":
        return this.styles.muted;
      default:
        return this.styles.warning;
    }
  }

  /** The finished roots the Recent section actually shows. */
  private visibleRecent(): WorkflowSnapshot[] {
    const recent = this.snapshot.workflows.filter((workflow) => !workflow.live);
    const limit = this.historyExpanded ? recent.length : RECENT_CAP;
    return recent.slice(0, limit);
  }

  private composeBody(width: number): BodyRow[] {
    const live = this.snapshot.workflows.filter((workflow) => workflow.live);
    const recent = this.visibleRecent();
    const rows: BodyRow[] = [];
    if (live.length > 0) {
      rows.push({
        text: this.sectionLabel(width, "Now", `${live.length} live`),
      });
      rows.push(...this.blockRows(width, live));
    } else {
      for (const text of this.idleLines(width)) rows.push({ text });
    }
    if (!this.runningOnly && recent.length > 0) {
      const total = this.snapshot.workflows.filter(
        (workflow) => !workflow.live,
      ).length;
      rows.push({
        text: this.sectionLabel(
          width,
          "Recent",
          `${recent.length} of ${total} finished${this.historyExpanded ? "" : " · h expands"}`,
        ),
      });
      // A finished root is selectable too: Enter opens its output.
      for (const workflow of recent)
        rows.push({
          text: this.recentLine(workflow, width),
          key: rootKey(workflow.runId),
        });
      if (total > recent.length) {
        rows.push({
          text: clip(
            this.styles.dim(
              `  … ${countNoun(total - recent.length, "more finished run")} · h expands`,
            ),
            width,
          ),
        });
      }
    }
    return rows;
  }

  private sectionLabel(width: number, text: string, note: string): string {
    const head = `${this.styles.accent(text)} ${this.styles.dim(`· ${note}`)}`;
    const rule = "─".repeat(Math.max(0, width - visibleWidth(head) - 1));
    return clip(`${head} ${this.styles.dim(rule)}`, width);
  }

  /**
   * One line per finished (or stale) root: `title · state · duration/ended ·
   * cost`, with the first line of a failure's `status.error` at the end. The
   * selected row carries the accent `›`, so the invisible selection is visible.
   */
  private recentLine(workflow: WorkflowSnapshot, width: number): string {
    const selected = this.selectedKey === rootKey(workflow.runId);
    const state = rootState(workflow);
    const bar = workflowBar(workflow);
    const tone = this.tone(state.tone);
    const age =
      workflow.finishedAt !== undefined
        ? formatAgoPhrase(Math.max(0, this.now() - workflow.finishedAt))
        : "unknown";
    const endedLabel =
      workflow.stale || !isTerminalState(workflow.state)
        ? "last seen"
        : "ended";
    // A failed/stopped/unrecognised bar text already carries the duration; a
    // completed one does not. A stale run has no duration, only "last seen".
    const kind = stateKind(workflow.state);
    const durationShown = kind === "done";
    const parts = [
      `${tone(state.glyph)} ${this.styles.bold(workflow.title)}`,
      tone(bar.text),
      this.styles.dim(`${endedLabel} ${age}`),
      ...(durationShown
        ? [this.styles.dim(formatDuration(workflow.elapsedMs))]
        : []),
      ...(workflow.tokens !== undefined
        ? [this.styles.dim(`${formatTokens(workflow.tokens)} tok`)]
        : []),
      ...(workflow.costUsd !== undefined
        ? [this.styles.dim(formatCost(workflow.costUsd))]
        : []),
      ...(workflow.error ? [this.styles.error(workflow.error)] : []),
    ];
    return clip(
      `${selected ? this.styles.accent("›") : " "} ${parts.join(" · ")}`,
      width,
    );
  }

  private blockRows(width: number, workflows: WorkflowSnapshot[]): BodyRow[] {
    const blocks = this.buildBlocks(width, workflows);
    const twoColumn = width >= WIDE && !this.avatar?.graphics;
    if (!twoColumn) {
      return blocks.flatMap((block) =>
        block.lines.map((text, index) => ({ text, key: block.keys[index] })),
      );
    }
    const columnWidth = Math.max(40, Math.floor((width - 2) / 2));
    const rows: BodyRow[] = [];
    for (let index = 0; index < blocks.length; index += 2) {
      const left = blocks[index];
      const right = blocks[index + 1];
      const lineCount = Math.max(left.lines.length, right?.lines.length ?? 0);
      for (let line = 0; line < lineCount; line += 1) {
        const leftText = padTo(left.lines[line] ?? "", columnWidth);
        const rightText = right
          ? clip(right.lines[line] ?? "", columnWidth)
          : "";
        const key = left.keys[line] ?? right?.keys[line];
        rows.push({
          text: clip(`${leftText}  ${rightText}`, width),
          ...(key ? { key } : {}),
        });
      }
    }
    return rows;
  }

  /**
   * The overlay renders at `maxHeight: "85%"` and pi-tui cuts anything past it
   * (`overlayLines.slice(0, maxHeight)`), so the body is sized from that limit:
   * header + body + footer never exceed `floor(rows * 0.85)`, and the footer
   * with the key hints stays visible.
   */
  private maxOverlayRows(): number {
    const rows = this.tui.terminal?.rows ?? DEFAULT_ROWS;
    const available = Math.max(1, rows - OVERLAY_MARGIN_ROWS);
    return Math.max(
      3,
      Math.min(Math.floor(rows * this.heightFraction), available),
    );
  }

  /** Header (plus notes) + the blank separator + the footer. */
  private chromeRows(): number {
    return (
      2 +
      (this.snapshot.error ? 1 : 0) +
      (this.snapshot.hiddenWorkflows > 0 ? 1 : 0) +
      1
    );
  }

  private bodyHeight(): number {
    return Math.max(3, this.maxOverlayRows() - this.chromeRows());
  }

  /**
   * Selection keys, derived from the snapshot: the live children first, then
   * one key per Recent line. Never rendered here — the keys are pure data, and
   * building every card just to collect them cost two thirds of a frame.
   */
  private selectableKeys(): string[] {
    const keys: string[] = [];
    for (const workflow of this.snapshot.workflows) {
      if (!workflow.live) continue;
      for (const child of workflow.children) {
        if (this.runningOnly && !child.active) continue;
        keys.push(child.rowKey);
      }
    }
    if (!this.runningOnly)
      for (const workflow of this.visibleRecent())
        keys.push(rootKey(workflow.runId));
    return keys;
  }

  /**
   * The tail Enter opens for a selection key: a child's own output file, or —
   * for a finished root — the output of its last failed child, which is the one
   * that carries the error when it matters.
   */
  private detailTargetFor(
    key: string | undefined,
  ): { key: string; title: string; path: string } | undefined {
    if (!key) return undefined;
    const rootRunId = rootRunIdOf(key);
    if (rootRunId !== undefined) {
      const workflow = this.snapshot.workflows.find(
        (candidate) => candidate.runId === rootRunId,
      );
      if (!workflow) return undefined;
      const reversed = [...workflow.children].reverse();
      const failed = reversed.find(
        (child) => child.failed && child.outputPath !== undefined,
      );
      const withOutput = reversed.find(
        (child) => child.outputPath !== undefined,
      );
      const child = failed ?? withOutput;
      return {
        key,
        title: `${workflow.title} · ${workflow.state}${
          child ? ` · ${child.key}` : ""
        }`,
        path:
          child?.outputPath ??
          path.join(this.scanner.runsDir, rootRunId, "output-0.log"),
      };
    }
    const child = this.selectedChildFor(key);
    if (!child) return undefined;
    return {
      key,
      title: `${child.agent} · ${child.key} · ${child.state}`,
      path: child.outputPath ?? "",
    };
  }

  private selectedChildFor(rowKey: string): ChildSnapshot | undefined {
    for (const workflow of this.snapshot.workflows) {
      const child = workflow.children.find(
        (candidate) => candidate.rowKey === rowKey,
      );
      if (child) return child;
    }
    return undefined;
  }

  private moveSelection(delta: number): void {
    const keys = this.selectableKeys();
    const lastIndex = keys.length - 1;
    if (keys.length === 0 || (delta > 0 && this.selected >= lastIndex)) {
      // Past the last selectable row: scroll the body freely, so the last
      // workflow's bar and the Recent list are reachable.
      this.scrollPast = Math.max(0, this.scrollPast + delta);
      this.tui.requestRender();
      return;
    }
    if (delta < 0 && this.scrollPast > 0) {
      // Free scrolling unwinds before the selection moves again. Return even
      // when the offset reaches 0, or the same press would also move the
      // selection (one Up scrolls back and selects the previous card).
      this.scrollPast = Math.max(0, this.scrollPast + delta);
      this.tui.requestRender();
      return;
    }
    // A downward press moves the selection even when an earlier selection left
    // a free offset behind; the offset is dropped so the selected row stays in
    // view.
    this.scrollPast = 0;
    this.selected = Math.max(0, Math.min(lastIndex, this.selected + delta));
    this.selectedKey = keys[this.selected];
    if (this.detail)
      this.clipboardDetail(this.detailTargetFor(this.selectedKey));
    this.tui.requestRender();
  }

  private openDetail(
    target: { key: string; title: string; path: string } | undefined,
  ): void {
    if (!target) return;
    const lines = target.path
      ? readTailLines(target.path, 200).map((line) => redact(line))
      : [];
    this.detail = {
      key: target.key,
      title: target.title,
      path: target.path ? redact(target.path) : "(no output path)",
      lines:
        lines.length > 0
          ? lines
          : ["(no output yet — the run has not written its output log)"],
      scroll: Math.max(0, lines.length - this.bodyHeight()),
    };
    this.tui.requestRender();
  }

  private clipboardDetail(
    target: { key: string; title: string; path: string } | undefined,
  ): void {
    if (!this.detail || !target) return;
    const lines = target.path
      ? readTailLines(target.path, 200).map((line) => redact(line))
      : [];
    this.detail = {
      ...this.detail,
      title: target.title,
      lines: lines.length > 0 ? lines : this.detail.lines,
    };
  }

  private toggleMotion(): void {
    this.motion = !this.motion;
    if (!this.motion) {
      // Static art is frozen at t=0, while `levelUpAt` was stored in the running
      // clock. Without this reset a promotion from the motion phase would keep
      // every card in its flourish forever (bubble, old face, happy pose).
      for (const state of this.rankState.values()) {
        state.levelUpAt = Number.NEGATIVE_INFINITY;
      }
    }
    this.styles = this.buildStyles();
    this.clock.setPeriod(this.periodMs());
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "ctrl+c") ||
      data === "q"
    ) {
      if (this.detail) {
        this.detail = undefined;
        this.tui.requestRender();
        return;
      }
      this.dispose();
      this.done(undefined);
      return;
    }

    if (this.detail) {
      if (matchesKey(data, "up") || data === "k") this.scrollDetail(-1);
      else if (matchesKey(data, "down") || data === "j") this.scrollDetail(1);
      else if (matchesKey(data, "pageUp"))
        this.scrollDetail(-this.bodyHeight());
      else if (matchesKey(data, "pageDown"))
        this.scrollDetail(this.bodyHeight());
      return;
    }

    if (matchesKey(data, "up") || data === "k") {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.moveSelection(-Math.max(1, Math.floor(this.bodyHeight() / 3)));
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.moveSelection(Math.max(1, Math.floor(this.bodyHeight() / 3)));
      return;
    }
    if (matchesKey(data, "return")) {
      this.openDetail(this.detailTargetFor(this.selectedKey));
      return;
    }
    if (data === "+" || data === "=") {
      this.avatarPx = Math.min(MAX_AVATAR_PX, this.avatarPx + 2);
      this.tui.requestRender();
      return;
    }
    if (data === "-") {
      this.avatarPx = Math.max(MIN_AVATAR_PX, this.avatarPx - 2);
      this.tui.requestRender();
      return;
    }
    if (data === "m") {
      this.toggleMotion();
      return;
    }
    if (data === "f") {
      this.runningOnly = !this.runningOnly;
      this.selected = 0;
      this.tui.requestRender();
      return;
    }
    if (data === "h") {
      this.historyExpanded = !this.historyExpanded;
      this.tui.requestRender();
      return;
    }
    if (data === "a") {
      const scanner = this.scanner;
      scanner.setIncludeOtherSessions(!scanner.includesOtherSessions);
      scanner.poll();
      this.tui.requestRender();
      return;
    }
  }

  private scrollDetail(delta: number): void {
    if (!this.detail) return;
    const max = Math.max(0, this.detail.lines.length - this.bodyHeight());
    this.detail = {
      ...this.detail,
      scroll: Math.max(0, Math.min(max, this.detail.scroll + delta)),
    };
    this.tui.requestRender();
  }

  invalidate(): void {
    this.styles = this.buildStyles();
  }

  private headerLines(width: number): string[] {
    const snapshot = this.snapshot;
    const spinner = this.styles.accent(spinnerFrame(this.artTime()));
    const live = snapshot.workflows.filter((workflow) => workflow.live).length;
    // Every count names its unit and agrees with its number: roots are runs,
    // the rest are agents.
    const counts =
      `${countNoun(snapshot.workflows.length, "run")} · ${live} live · ` +
      `${snapshot.runningCount} agents running · ${snapshot.doneCount} agents done`;
    const left = `${spinner} ${this.styles.bold("Agents")} ${this.styles.dim(`· ${counts}`)}`;
    const state = this.motion ? (this.animating() ? "live" : "idle") : "static";
    const right = this.styles.dim(
      `${state} · ${this.avatar ? (this.avatar.graphics ? "smooth Kitty avatars" : "half-block avatars") : "no avatars"}`,
    );
    const lines = [leftRight(left, right, width)];
    if (snapshot.error)
      lines.push(
        clip(this.styles.error(`scan error: ${snapshot.error}`), width),
      );
    if (snapshot.hiddenWorkflows > 0) {
      lines.push(
        clip(
          this.styles.dim(
            `+${countNoun(snapshot.hiddenWorkflows, "earlier finished run")} hidden`,
          ),
          width,
        ),
      );
    }
    lines.push("");
    return lines;
  }

  private footerLines(width: number): string[] {
    const on = (value: boolean) => (value ? "on" : "off");
    const size = this.effectiveAvatarPx(width);
    // The important keys come first: on a narrow terminal the clip eats the
    // tail, and `q quit` must survive it. The size shown is the size drawn, not
    // the `+`/`-` setting, so a narrow terminal never claims a bigger avatar.
    const hints =
      this.detail !== undefined
        ? "↑↓ scroll detail · Esc close detail · q quit"
        : `↑↓ select · Enter detail · q quit · f running-only ${on(this.runningOnly)} · h history ${on(this.historyExpanded)} · a others ${on(this.scanner.includesOtherSessions)} · m motion ${on(this.motion)} · +− size ${size > 0 ? `${size}px` : "off"}`;
    return [clip(this.styles.dim(hints), width)];
  }

  /** The avatar size this width and colour mode actually draw. */
  private effectiveAvatarPx(width: number): number {
    if (this.noColor || this.avatar === undefined || width < SMALL) return 0;
    const small = width < MEDIUM && width >= SMALL;
    return small
      ? Math.max(MIN_AVATAR_PX, Math.min(8, this.avatarPx))
      : this.avatarPx;
  }

  /**
   * `nothing running · no runs for this session` — the session-filtered
   * snapshot cannot tell an empty directory from one full of other sessions'
   * runs, so the idle line claims only what it knows. It is shown whenever Now
   * is empty, so `f` with nothing running is never a blank pane, and the Recent
   * list stays underneath it.
   */
  private idleLines(width: number): string[] {
    const finished = this.snapshot.workflows
      .map((workflow) => workflow.finishedAt)
      .filter((value): value is number => value !== undefined);
    const last = finished.length > 0 ? Math.max(...finished) : undefined;
    const message =
      last !== undefined
        ? `nothing running · last finished ${formatAgoPhrase(Math.max(0, this.now() - last))}`
        : "nothing running · no runs for this session";
    const lines: string[] = [];
    const persona: PersonaName = { name: "Wystan", noun: "Warden" };
    if (this.avatar && !this.noColor && width >= SMALL) {
      const px = Math.max(MIN_AVATAR_PX, Math.min(16, this.avatarPx));
      const rows = this.avatar.rows(persona.name, "sleepy", px);
      // The same bubble renderer as a card's, so the idle box is closed and
      // carries the arrow tail instead of a fixed 18-column frame.
      const bubble = renderBubble(
        { kind: "state", text: message },
        {
          width: Math.max(18, Math.min(68, width - px - 8)),
          styles: this.styles,
          maxLines: 1,
        },
      );
      const offset = Math.max(0, Math.floor((rows.length - bubble.length) / 2));
      rows.forEach((row, index) =>
        lines.push(clip(`${row}  ${bubble[index - offset] ?? ""}`, width)),
      );
    } else {
      lines.push(clip(`  ${this.styles.bold(message)}`, width));
    }
    lines.push("");
    lines.push(
      clip(
        this.styles.dim(
          "  the hall is quiet — runs and workflows appear here the moment they start",
        ),
        width,
      ),
    );
    return lines;
  }

  render(width: number): string[] {
    const bodyHeight = this.bodyHeight();
    let body: BodyRow[];
    let header: string[];
    let footer: string[];
    try {
      header = this.headerLines(width);
      footer = this.footerLines(width);
      body = this.detail ? this.detailRows(width) : this.composeBody(width);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return [
        clip(this.styles.error(`agent view render error: ${message}`), width),
      ];
    }

    if (!this.detail && body.length > 0) {
      this.scrollToSelection(body, bodyHeight);
    }
    const maxScroll = Math.max(0, body.length - bodyHeight);
    this.scrollBase = Math.max(0, Math.min(maxScroll, this.scrollBase));
    const target = Math.min(maxScroll, this.scrollBase + this.scrollPast);
    // Clamp the free offset itself, so scrolling back up responds at once
    // instead of unwinding an overshoot that was never drawn.
    this.scrollPast = Math.max(0, target - this.scrollBase);
    this.scroll = target;
    const visible = body.slice(this.scroll, this.scroll + bodyHeight);
    const lines = [
      ...header,
      ...cropImageRows(visible.map((row) => row.text)),
      ...footer,
    ];
    while (lines.length < bodyHeight + header.length + footer.length)
      lines.push("");
    this.lastRenderLines = lines.map((line) => clip(line, width));
    return this.lastRenderLines;
  }

  /** Keep the selected card in view; the free scroll is added in `render`. */
  private scrollToSelection(body: BodyRow[], bodyHeight: number): void {
    const keys = this.selectableKeys();
    if (keys.length === 0) return;
    const selectedKey =
      this.selectedKey ?? keys[Math.min(this.selected, keys.length - 1)];
    this.selectedKey = selectedKey;
    this.selected = Math.max(0, keys.indexOf(selectedKey));
    let first = -1;
    let last = -1;
    body.forEach((row, index) => {
      if (row.key === selectedKey) {
        if (first < 0) first = index;
        last = index;
      }
    });
    if (first < 0) return;
    if (first < this.scrollBase) this.scrollBase = first;
    else if (last >= this.scrollBase + bodyHeight)
      this.scrollBase = Math.max(0, last - bodyHeight + 1);
  }

  private detailRows(width: number): BodyRow[] {
    const detail = this.detail;
    if (!detail) return [];
    const rows: BodyRow[] = [
      { text: clip(this.styles.bold(`Detail · ${detail.title}`), width) },
      // Clip the path from the left: the file name is the part that identifies it.
      { text: this.styles.dim(clipStart(detail.path, width)) },
      { text: "" },
    ];
    for (const line of detail.lines) rows.push({ text: clip(line, width) });
    return rows;
  }

  get selectedChildKey(): string | undefined {
    return this.selectedKey;
  }

  get statistics(): {
    motion: boolean;
    avatarPx: number;
    runningOnly: boolean;
    personas: string[];
    renders: number;
    cardBuilds: number;
    rasterCount: number;
    clockRunning: boolean;
    scrollPast: number;
  } {
    return {
      motion: this.motion,
      avatarPx: this.avatarPx,
      runningOnly: this.runningOnly,
      personas: this.personas.liveNames(),
      renders: this.renderCount,
      cardBuilds: this.cardBuilds,
      rasterCount: this.avatar?.rasterCount ?? 0,
      clockRunning: this.clock.running,
      scrollPast: this.scrollPast,
    };
  }

  private renderCount = 0;

  /** Wraps render to count frames for the performance report. */
  renderFrame(width: number): string[] {
    this.renderCount += 1;
    return this.render(width);
  }

  /** Aggregated persona names for the uniqueness assertion in tests. */
  personaNames(): string[] {
    const names: string[] = [];
    for (const workflow of this.snapshot.workflows) {
      for (const child of workflow.children) {
        const { persona } = this.childPersonas(child);
        names.push(persona.name);
      }
    }
    return names;
  }
}
