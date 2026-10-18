import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Every openai-codex model from GPT-5.6 onward gets a 1.05M window and
// compacts at 65% of it (reserve = the remaining 35%).
const PROVIDER = "openai-codex";
const CONTEXT_WINDOW = 1_050_000;
const COMPACT_AT = 0.65;
const RESERVE_TOKENS = CONTEXT_WINDOW - Math.floor(CONTEXT_WINDOW * COMPACT_AT);
const AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

function isFromGpt56(id: string) {
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(id);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 6);
}

type Json = Record<string, any>;

function readJson(path: string): Json {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function writeJson(path: string, value: Json) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export default function codexContextWindow(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const ids = ctx.modelRegistry
      .getAll()
      .filter((m) => m.provider === PROVIDER && isFromGpt56(m.id))
      .map((m) => m.id);

    const modelsPath = join(AGENT_DIR, "models.json");
    const settingsPath = join(AGENT_DIR, "settings.json");
    const models = readJson(modelsPath);
    const settings = readJson(settingsPath);
    const overrides = (((models.providers ??= {})[PROVIDER] ??=
      {}).modelOverrides ??= {});
    const compaction = ((settings.compaction ??= {}).modelOverrides ??= {});

    const added: string[] = [];
    for (const id of ids) {
      const key = `${PROVIDER}/${id}`;
      let changed = false;
      if (overrides[id]?.contextWindow !== CONTEXT_WINDOW) {
        overrides[id] = { ...overrides[id], contextWindow: CONTEXT_WINDOW };
        changed = true;
      }
      if (compaction[key]?.reserveTokens !== RESERVE_TOKENS) {
        compaction[key] = { ...compaction[key], reserveTokens: RESERVE_TOKENS };
        changed = true;
      }
      if (changed) added.push(id);
    }

    if (added.length > 0) {
      writeJson(modelsPath, models);
      writeJson(settingsPath, settings);
    }

    // /reload does not re-read models.json, and the active session keeps its
    // old model object. Refresh the registry and swap in the updated model.
    const current = ctx.model;
    if (
      !current ||
      current.provider !== PROVIDER ||
      current.contextWindow === CONTEXT_WINDOW ||
      !ids.includes(current.id)
    ) {
      return;
    }
    await ctx.modelRegistry.refresh({ allowNetwork: false });
    const fresh = ctx.modelRegistry.find(PROVIDER, current.id);
    if (fresh && fresh.contextWindow === CONTEXT_WINDOW) {
      await pi.setModel(fresh);
      ctx.ui.notify(
        `${current.id}: context window is now ${CONTEXT_WINDOW.toLocaleString()} tokens`,
        "info",
      );
    }
  });
}
