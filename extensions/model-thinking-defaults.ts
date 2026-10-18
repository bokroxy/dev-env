import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// Per-model default thinking levels, keyed by "provider/modelId".
const DEFAULTS = new Map<
  string,
  Parameters<ExtensionAPI["setThinkingLevel"]>[0]
>([["anthropic/claude-opus-5-5", "high"]]);

function applyDefault(pi: ExtensionAPI, model: ExtensionContext["model"]) {
  if (!model) return;
  const level = DEFAULTS.get(`${model.provider}/${model.id}`);
  if (level) pi.setThinkingLevel(level);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "startup" || event.reason === "new") {
      applyDefault(pi, ctx.model);
    }
  });

  pi.on("model_select", async (event) => {
    // Don't override the level saved with a resumed session.
    if (event.source !== "restore") applyDefault(pi, event.model);
  });
}
