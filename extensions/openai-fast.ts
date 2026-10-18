import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "openai-fast-mode";
const STATUS_KEY = "openai-fast";
const SUPPORTED_MODELS = new Set([
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);

function supportsFastMode(ctx: ExtensionContext) {
  return (
    ctx.model?.provider === "openai-codex" && SUPPORTED_MODELS.has(ctx.model.id)
  );
}

function restoreEnabled(ctx: ExtensionContext) {
  const entries = ctx.sessionManager.getBranch();

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type === "custom" &&
      entry.customType === ENTRY_TYPE &&
      typeof entry.data === "object" &&
      entry.data !== null &&
      "enabled" in entry.data &&
      typeof entry.data.enabled === "boolean"
    ) {
      return entry.data.enabled;
    }
  }

  return true;
}

export default function openAIFast(pi: ExtensionAPI) {
  let enabled = true;

  const updateStatus = (ctx: ExtensionContext) => {
    ctx.ui.setStatus(
      STATUS_KEY,
      enabled && supportsFastMode(ctx) ? "fast" : undefined,
    );
  };

  const describeStatus = (ctx: ExtensionContext) => {
    const model = ctx.model
      ? `${ctx.model.provider}/${ctx.model.id}`
      : "no model";

    if (!supportsFastMode(ctx)) {
      return `Fast mode is ${enabled ? "enabled" : "disabled"}, but ${model} does not support this extension`;
    }

    return `Fast mode is ${enabled ? "on" : "off"} for ${model}`;
  };

  pi.on("session_start", (_event, ctx) => {
    enabled = restoreEnabled(ctx);
    updateStatus(ctx);
  });

  pi.on("model_select", (_event, ctx) => updateStatus(ctx));

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled || !supportsFastMode(ctx)) return;
    if (
      typeof event.payload !== "object" ||
      event.payload === null ||
      Array.isArray(event.payload)
    ) {
      return;
    }

    return { ...event.payload, service_tier: "priority" };
  });

  pi.registerCommand("fast", {
    description: "Manage OpenAI Codex Fast mode: /fast on|off|status",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";

      if (action === "status") {
        ctx.ui.notify(
          describeStatus(ctx),
          supportsFastMode(ctx) ? "info" : "warning",
        );
        return;
      }

      if (action !== "on" && action !== "off") {
        ctx.ui.notify("Usage: /fast on|off|status", "warning");
        return;
      }

      enabled = action === "on";
      pi.appendEntry(ENTRY_TYPE, { enabled });
      updateStatus(ctx);
      ctx.ui.notify(
        describeStatus(ctx),
        supportsFastMode(ctx) ? "info" : "warning",
      );
    },
  });
}
