import { truncateToWidth } from "@earendil-works/pi-tui";

/**
 * Collapses pi's startup resource listing ([Skills], [Prompts], [Extensions]) and
 * its issue blocks ([Extension issues] and the *conflicts* blocks) to one line each.
 * Ctrl+O (pi's tool-output expansion key) restores the full listing.
 *
 * Pi draws these sections itself, so they are rewritten in place: each matching
 * child of the TUI tree is wrapped by a component that renders the original
 * unchanged while expanded and a single summary line while collapsed.
 */
export interface StartupNode {
  children?: StartupNode[];
  invalidate(): void;
  render(width: number): string[];
}

const LISTED = /^\[(Skills|Prompts|Extensions)\]$/;
const ISSUES =
  /^\[(Extension issues|Skill conflicts|Prompt conflicts|Theme conflicts)\]$/;
// Select Graphic Rendition and other CSI sequences are all pi emits here.
// eslint-disable-next-line no-control-regex
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const WIDE = 10_000;
const WRAPPED = Symbol.for("dev-env.startup-sections.wrapped");

type Wrapped = StartupNode & { [WRAPPED]?: true };

const plain = (line: string) => line.replace(CSI, "");
const dim = (text: string) => `\u001b[2m${text}\u001b[22m`;

function renderWide(node: StartupNode) {
  try {
    return node.render(WIDE);
  } catch {
    return [];
  }
}

const firstContentLine = (lines: string[]) =>
  lines.find((line) => plain(line).trim() !== "");

/** Items in a collapsed listing: the body is one comma-separated list. */
export function countListed(lines: string[]) {
  const body = lines.slice(lines.indexOf(firstContentLine(lines) ?? "") + 1);
  return plain(body.join(" "))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean).length;
}

/** Issues in a block: each one starts with an indented source path. */
export function countIssues(lines: string[]) {
  const body = lines.slice(lines.indexOf(firstContentLine(lines) ?? "") + 1);
  const entries = body.map(plain).filter((line) => /^ {2}\S/.test(line));
  return entries.length > 0
    ? entries.length
    : body.some((l) => plain(l).trim())
      ? 1
      : 0;
}

export function summaryLine(header: string, summary: string, width: number) {
  return truncateToWidth(
    `${header} ${dim(`${summary} · ctrl+o to expand`)}`,
    width,
  );
}

function wrap(
  original: StartupNode,
  collapsed: (width: number) => string[],
  isExpanded: () => boolean,
): Wrapped {
  return {
    [WRAPPED]: true,
    render: (width) =>
      isExpanded() ? original.render(width) : collapsed(width),
    invalidate: () => original.invalidate(),
  };
}

/**
 * Wraps every matching section below `root`. Safe to call repeatedly: sections
 * already wrapped are skipped. Returns true when something changed.
 */
export function collapseStartupSections(
  root: StartupNode,
  isExpanded: () => boolean,
) {
  let changed = false;

  const visit = (node: StartupNode) => {
    const children = node.children;
    if (!Array.isArray(children)) return;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]! as Wrapped;
      if (child[WRAPPED]) continue;
      const lines = renderWide(child);
      const header = firstContentLine(lines);
      const title = header ? plain(header).trim() : "";
      const listed = LISTED.test(title);
      const issues = ISSUES.test(title);
      if (!header || (!listed && !issues)) {
        visit(child);
        continue;
      }
      // Counting needs the collapsed (comma list) rendering of a listing.
      if (listed && isExpanded()) continue;
      const count = listed ? countListed(lines) : countIssues(lines);
      if (count === 0) continue;
      const label = header.trimEnd();
      const summary = listed
        ? `${count} loaded`
        : `${count} ${count === 1 ? "entry" : "entries"}`;
      children[index] = wrap(
        child,
        (width) => [summaryLine(label, summary, width)],
        isExpanded,
      );
      // Drop the blank spacer pi adds after each section while collapsed.
      const spacer = children[index + 1] as Wrapped | undefined;
      if (
        spacer &&
        !spacer[WRAPPED] &&
        renderWide(spacer).every((line) => plain(line).trim() === "")
      ) {
        children[index + 1] = wrap(spacer, () => [], isExpanded);
        index += 1;
      }
      changed = true;
    }
  };

  visit(root);
  if (changed) root.invalidate();
  return changed;
}
