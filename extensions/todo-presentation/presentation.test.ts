import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  belowPromptTodoUI,
  paddedTodoRows,
  TODO_WIDGET_KEY,
} from "./presentation.ts";

const theme = {
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

test("todo panel gets a separated heading rule, two-column inset and vertical padding", () => {
  const rows = paddedTodoRows(
    ["● Todos (1/2)", "├─ first", "└─ second", ""],
    80,
    theme,
  );
  assert.equal(rows[0], "");
  assert.match(rows[1], /^  ● Todos \(1\/2\) ─+/);
  assert.equal(rows[2], "  ├─ first");
  assert.equal(rows[3], "  └─ second");
  assert.equal(rows[4], "");
  assert.equal(
    rows.length,
    5,
    "avoid extra empty boxes or duplicated spacer rows",
  );
});

test("empty/hidden todos draw nothing; all widths fit including Unicode rows", () => {
  assert.deepEqual(paddedTodoRows([], 80, theme), []);
  assert.deepEqual(paddedTodoRows([""], 80, theme), []);
  for (const width of [0, 1, 2, 3, 4, 12, 80, 240]) {
    for (const line of paddedTodoRows(
      ["● Todos (0/1)", "└─ 长名字 🚀 ".repeat(8), ""],
      width,
      theme,
    ))
      assert.ok(visibleWidth(line) <= width);
  }
});

test("UI adapter only routes rpiv-todos below the editor and preserves lifecycle/getters", () => {
  type Factory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };
  const calls: Array<{
    key: string;
    content: Factory | string[] | undefined;
    placement?: string;
  }> = [];
  let expanded = false;
  let invalidated = 0;
  let disposed = 0;
  let observedWidth = 0;
  const ui = {
    get theme() {
      return theme;
    },
    getToolsExpanded: () => expanded,
    setWidget: (
      key: string,
      content: Factory | string[] | undefined,
      options?: { placement?: string },
    ) => {
      calls.push({ key, content, placement: options?.placement });
    },
  } as unknown as ExtensionUIContext;
  const adapted = belowPromptTodoUI(ui);
  assert.equal(
    belowPromptTodoUI(ui),
    adapted,
    "stable identity avoids remounting upstream overlay",
  );
  expanded = true;
  assert.equal(adapted.getToolsExpanded(), true);
  assert.equal(adapted.theme, theme);
  adapted.setWidget(
    TODO_WIDGET_KEY,
    () => ({
      render: (width) => {
        observedWidth = width;
        return ["● Todos (0/1)", "└─ fixture", ""];
      },
      invalidate: () => {
        invalidated++;
      },
      dispose: () => {
        disposed++;
      },
    }),
    { placement: "aboveEditor" },
  );
  assert.equal(calls[0].placement, "belowEditor");
  const factory = calls[0].content;
  assert.equal(typeof factory, "function");
  if (typeof factory !== "function") throw new Error("missing widget factory");
  const component = factory({} as TUI, theme);
  const rows = component.render(80);
  assert.equal(observedWidth, 76);
  assert.equal(rows[0], "");
  component.invalidate();
  component.dispose?.();
  assert.equal(invalidated, 1);
  assert.equal(disposed, 1);
  adapted.setWidget("context-bar", ["untouched"], { placement: "aboveEditor" });
  assert.equal(calls[1].placement, "aboveEditor");
  assert.deepEqual(calls[1].content, ["untouched"]);
  adapted.setWidget(TODO_WIDGET_KEY, undefined);
  assert.equal(
    calls[2].content,
    undefined,
    "empty/disposed overlays must unregister normally",
  );
});
