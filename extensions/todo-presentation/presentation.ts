import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const TODO_WIDGET_KEY = "rpiv-todos";
const HORIZONTAL_PADDING = 2;
const MAX_SECTION_WIDTH = 120;

/** Only presentation changes: original todo component/state and keyboard handling stay intact. */
export function paddedTodoRows(
  rows: readonly string[],
  width: number,
  theme: Theme,
) {
  if (width <= 0 || !rows.length) return [];
  const body = [...rows];
  while (body.length && body.at(-1) === "") body.pop();
  if (!body.length) return [];
  const padding = Math.min(
    HORIZONTAL_PADDING,
    Math.max(0, Math.floor((width - 1) / 2)),
  );
  const inner = Math.max(1, width - padding * 2);
  const inset = " ".repeat(padding);
  const heading = truncateToWidth(body[0], inner);
  const ruleLength = Math.max(
    0,
    Math.min(inner, MAX_SECTION_WIDTH) - visibleWidth(heading) - 1,
  );
  const rule = ruleLength
    ? " " + theme.fg("borderMuted", "─".repeat(ruleLength))
    : "";
  return [
    "",
    truncateToWidth(`${inset}${heading}${rule}`, width),
    ...body
      .slice(1)
      .map((line) =>
        truncateToWidth(`${inset}${truncateToWidth(line, inner)}`, width),
      ),
    "",
  ];
}

const contexts = new WeakMap<ExtensionUIContext, ExtensionUIContext>();

/** Stable adapter identity preserves upstream's register-once lifecycle. */
export function belowPromptTodoUI(ui: ExtensionUIContext) {
  const cached = contexts.get(ui);
  if (cached) return cached;
  const setWidget: ExtensionUIContext["setWidget"] = (
    key,
    content,
    options,
  ) => {
    if (key !== TODO_WIDGET_KEY || content === undefined) {
      if (typeof content === "function") ui.setWidget(key, content, options);
      else ui.setWidget(key, content, options);
      return;
    }
    ui.setWidget(
      key,
      (tui, theme) => {
        const component =
          typeof content === "function"
            ? content(tui, theme)
            : {
                render: () => content,
                invalidate() {},
              };
        return {
          ...component,
          render(width: number) {
            const padding = Math.min(
              HORIZONTAL_PADDING,
              Math.max(0, Math.floor((width - 1) / 2)),
            );
            return paddedTodoRows(
              component.render(Math.max(1, width - padding * 2)),
              width,
              theme,
            );
          },
        };
      },
      { ...options, placement: "belowEditor" },
    );
  };
  // Preserve live UI getters (theme, expansion state, etc.) and all native methods.
  const adapted: ExtensionUIContext = Object.create(ui, {
    setWidget: { value: setWidget },
  });
  contexts.set(ui, adapted);
  return adapted;
}
