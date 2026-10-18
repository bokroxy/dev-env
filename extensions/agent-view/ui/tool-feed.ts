import type { Activity } from "../source/types.ts";
import { redact } from "../source/redact.ts";
import type { Styles } from "./style.ts";
import { clip, visibleWidth } from "./text.ts";

// Bright, readable accents on the incumbent dark terminal palette. State still has text.
const RAINBOW = [203, 214, 228, 84, 81, 141];

/** Observed invocations, not claimed successful results. Never print arguments here. */
export function renderToolFeed(
  activity: Activity,
  styles: Styles,
  width: number,
) {
  const recent = activity.recentTools ?? [];
  const tools = recent.slice(-3).reverse();
  if (tools.length === 0 && activity.toolName) {
    tools.push({
      id: "current",
      name: activity.toolName,
      label: redact(activity.toolName).slice(0, 48),
      failed: false,
    });
  }
  const rows: string[] = [];
  let row = "";
  for (const [index, tool] of tools.entries()) {
    const text = `Used ${redact(tool.label)}!${tool.failed ? " (failed)" : ""}`;
    const chip = styles.bright(RAINBOW[index % RAINBOW.length], text);
    const candidate = row ? `${row} ${styles.dim("·")} ${chip}` : chip;
    if (row && visibleWidth(candidate) > width) {
      rows.push(clip(row, width));
      row = chip;
    } else {
      row = candidate;
    }
  }
  if (row) rows.push(clip(row, width));
  return rows.slice(0, 3);
}
