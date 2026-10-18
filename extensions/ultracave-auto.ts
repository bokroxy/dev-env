/**
 * Auto-invoke the ultracave skill (owner policy 2026-10-06).
 *
 * Every session — main session and every subagent child that loads this
 * extension — gets the ultracave rules as a system-prompt section from its
 * first turn, so the terse style is on without /skill:ultracave. The text is
 * read from the skill file at load time, so the skill stays the single source
 * of truth, and it is byte-stable across turns so the prompt cache survives.
 *
 * Switch off with "stop caveman" or "normal mode" (the rules say so).
 * Skips injection when the skill file is missing (the extension then does
 * nothing rather than guessing at the rules).
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// The skill ships next to this extension (<agent dir>/skills/ultracave); a copy
// in ~/.agents/skills is used when the bundled one is missing.
const SKILL_PATHS = [
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "skills",
    "ultracave",
    "SKILL.md",
  ),
  path.join(os.homedir(), ".agents", "skills", "ultracave", "SKILL.md"),
];
const LOG_DIR = path.join(
  process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
  "logs",
);
const LOG_PATH = path.join(LOG_DIR, "ultracave-auto.log");

/** Skill body without the YAML frontmatter; empty string when unreadable. */
function readSkillBody(): string {
  for (const file of SKILL_PATHS) {
    try {
      return readFileSync(file, "utf8")
        .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
        .trim();
    } catch {
      // try the next location
    }
  }
  return "";
}

function log(line: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(
      LOG_PATH,
      `${new Date().toISOString()} ${process.pid} ${line}\n`,
    );
  } catch {
    // logging must never break a session
  }
}

export default function ultracaveAuto(pi: ExtensionAPI) {
  const body = readSkillBody();
  log(
    body
      ? `loaded skill (${body.length} chars)`
      : "skill file unreadable, injection disabled",
  );
  let injectedOnce = false;

  pi.on("before_agent_start", (event, ctx) => {
    if (!body) return;
    event.systemPromptOptions.sections = {
      ...(event.systemPromptOptions.sections ?? {}),
      ultracave: body,
    };
    const guideline =
      'Ultracave response style is ON for this session (owner policy). Follow the rules in the <ultracave> section: fragments over prose, payload verbatim, never cut a negation, a number, a path or an error string. Switch off only on "stop caveman" or "normal mode".';
    event.systemPromptOptions.promptGuidelines = [
      ...(event.systemPromptOptions.promptGuidelines ?? []),
      guideline,
    ];
    if (!injectedOnce) {
      injectedOnce = true;
      log(
        `injected into session ${ctx.sessionManager?.getSessionFile?.() ?? "unknown"}`,
      );
    }
  });
}
