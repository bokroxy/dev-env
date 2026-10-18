import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  getAgentDir,
  getLastAssistantUsage,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatCompactTokens } from "../shared/context-utilization.ts";
import {
  allocateColumns,
  CATEGORIES,
  estimateTextTokens,
  splitSystemPrompt,
  usedTokens,
  type Breakdown,
} from "./breakdown.ts";

const WIDGET_KEY = "context-bar";
const statePath = () => join(getAgentDir(), "context-bar.json");

function loadEnabled() {
  try {
    const path = statePath();
    return (
      existsSync(path) &&
      JSON.parse(readFileSync(path, "utf8")).enabled === true
    );
  } catch {
    return false;
  }
}

function saveEnabled(enabled: boolean) {
  writeFileSync(statePath(), `${JSON.stringify({ enabled }, null, 2)}\n`);
}

function isMcpTool(tool: ToolInfo) {
  return (
    tool.namespace !== undefined ||
    /^mcp(__|$)/.test(tool.name) ||
    tool.sourceInfo.path === "builtin:mcp" ||
    /mcp/i.test(tool.sourceInfo.source)
  );
}

function compactionBuffer(pi: ExtensionAPI, ctx: ExtensionContext) {
  const settings = pi.getSettings().compaction;
  if (!(settings?.enabled ?? DEFAULT_COMPACTION_SETTINGS.enabled)) return 0;
  const key = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  const override = key
    ? settings?.modelOverrides?.[key]?.reserveTokens
    : undefined;
  return (
    override ??
    settings?.reserveTokens ??
    DEFAULT_COMPACTION_SETTINGS.reserveTokens
  );
}

function measure(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Breakdown | undefined {
  const usage = ctx.getContextUsage();
  const window = usage?.contextWindow ?? ctx.model?.contextWindow;
  if (!window) return undefined;

  const prompt = splitSystemPrompt(ctx.getSystemPrompt());

  const toolsByName = new Map(
    pi.getAllTools().map((tool) => [tool.name, tool]),
  );
  let tools = 0;
  let mcp = 0;
  for (const name of pi.getActiveTools()) {
    const tool = toolsByName.get(name);
    if (!tool) continue;
    const size = estimateTextTokens(
      JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }),
    );
    if (isMcpTool(tool)) mcp += size;
    else tools += size;
  }

  // Provider-reported usage covers the whole request (system + tools + messages), so messages
  // are the remainder. Without usage (fresh session, or right after compaction) estimate them.
  const fixed =
    prompt.system + prompt.contextFiles + prompt.skills + tools + mcp;
  const reported = usage?.tokens;
  const measured =
    typeof reported === "number" &&
    getLastAssistantUsage(ctx.sessionManager.getBranch()) !== undefined;
  const messages = measured
    ? Math.max(0, reported - fixed)
    : ctx.sessionManager
        .buildSessionProjection()
        .messages.reduce((sum, message) => sum + estimateTokens(message), 0);

  return {
    ...prompt,
    tools,
    mcp,
    messages,
    window,
    buffer: compactionBuffer(pi, ctx),
    estimated: !measured,
  };
}

function render(breakdown: Breakdown | undefined, width: number, theme: Theme) {
  if (width <= 0) return [];
  if (!breakdown)
    return [
      truncateToWidth(theme.fg("dim", "context: no model selected"), width),
    ];

  const used = usedTokens(breakdown);
  const buffer = Math.min(
    breakdown.buffer,
    Math.max(0, breakdown.window - used),
  );
  const free = Math.max(0, breakdown.window - used - buffer);
  const cols = allocateColumns(
    [...CATEGORIES.map((c) => breakdown[c.key]), buffer, free],
    width,
  );

  let bar = "";
  CATEGORIES.forEach((c, i) => {
    if (cols[i] > 0) bar += theme.fg(c.color, "█".repeat(cols[i]));
  });
  const bufferCols = cols[CATEGORIES.length];
  const freeCols = cols[CATEGORIES.length + 1];
  if (bufferCols > 0) bar += theme.fg("muted", "▒".repeat(bufferCols));
  if (freeCols > 0) bar += theme.fg("dim", "░".repeat(freeCols));

  const percent = Math.round((used / breakdown.window) * 100);
  const total = `${breakdown.estimated ? "~" : ""}${formatCompactTokens(used)}/${formatCompactTokens(breakdown.window)} (${percent}%)`;
  const item = (swatch: string, label: string, tokens: number) =>
    `${swatch} ${theme.fg("muted", `${label} ${formatCompactTokens(tokens)}`)}`;

  const legend = [theme.bold(total)];
  for (const c of CATEGORIES) {
    if (breakdown[c.key] > 0)
      legend.push(item(theme.fg(c.color, "█"), c.label, breakdown[c.key]));
  }
  if (buffer > 0)
    legend.push(item(theme.fg("muted", "▒"), "Compact buffer", buffer));
  legend.push(item(theme.fg("dim", "░"), "Free", free));

  return [bar, truncateToWidth(legend.join("  "), width)];
}

export default function contextBar(pi: ExtensionAPI) {
  let enabled = false;
  let snapshot: Breakdown | undefined;
  let requestRender: (() => void) | undefined;

  const show = (ctx: ExtensionContext) => {
    snapshot = measure(pi, ctx);
    ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      requestRender = () => tui.requestRender();
      return {
        render: (width: number) => render(snapshot, width, theme),
        invalidate() {},
        dispose() {
          requestRender = undefined;
        },
      };
    });
  };

  const hide = (ctx: ExtensionContext) => {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    requestRender = undefined;
    snapshot = undefined;
  };

  const apply = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    if (enabled) show(ctx);
    else hide(ctx);
  };

  const refresh = (ctx: ExtensionContext) => {
    if (!enabled || ctx.mode !== "tui") return;
    snapshot = measure(pi, ctx);
    requestRender?.();
  };

  pi.on("session_start", (_event, ctx) => {
    enabled = loadEnabled();
    apply(ctx);
  });
  pi.on("model_select", (_event, ctx) => refresh(ctx));
  pi.on("message_end", (_event, ctx) => refresh(ctx));
  pi.on("tool_execution_end", (_event, ctx) => refresh(ctx));
  pi.on("turn_end", (_event, ctx) => refresh(ctx));
  pi.on("agent_end", (_event, ctx) => refresh(ctx));
  pi.on("session_compact", (_event, ctx) => refresh(ctx));
  pi.on("session_tree", (_event, ctx) => refresh(ctx));

  pi.registerCommand("context-bar", {
    description:
      "Toggle the context window bar above the prompt (optional: on | off)",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      enabled = arg === "on" ? true : arg === "off" ? false : !enabled;
      saveEnabled(enabled);
      apply(ctx);
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          "The context bar is only shown in the interactive TUI",
          "warning",
        );
        return;
      }
      ctx.ui.notify(`Context bar ${enabled ? "on" : "off"}`, "info");
    },
  });
}
