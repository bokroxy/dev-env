/**
 * events.jsonl -> Activity. Pure and incremental: the scanner applies each
 * newly tailed line once and keeps only the bounded summary. Bubble priority
 * (brief): thinking text, then the last assistant text, then the run state.
 * Tool invocations live only in the separate bounded activity feed.
 */
import { redact, shortenPath } from "./redact.ts";
import type { Activity } from "./types.ts";

const THOUGHT_CHARS = 260;
const TEXT_CHARS = 300;
const TOOL_CHARS = 160;

export function emptyActivity(): Activity {
  return {};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Last one or two sentences, collapsed to a single line. */
export function condense(text: string, maxChars = THOUGHT_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  const tail = flat.slice(-maxChars);
  const boundary = tail.search(/[.!?]\s/);
  const cut = boundary >= 0 ? tail.slice(boundary + 1) : tail;
  return `${cut.trim().slice(0, maxChars)}`;
}

function firstString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** A short, informative line for a tool call: `read: /path`, `bash: cmd`. */
export function toolLine(name: string, args: unknown): string | undefined {
  const record = asRecord(args) ?? {};
  const tool = name.toLowerCase();
  const detail =
    tool === "bash" || tool === "powershell"
      ? firstString(record, ["command"])
      : tool === "read" || tool === "write" || tool === "edit" || tool === "ls"
        ? firstString(record, ["path", "file_path", "pattern"])
        : tool === "grep" || tool === "search"
          ? firstString(record, ["query", "pattern", "path"])
          : tool === "find" || tool === "glob"
            ? firstString(record, ["pattern", "path", "query"])
            : firstString(record, [
                "query",
                "url",
                "path",
                "command",
                "pattern",
                "description",
                "prompt",
                "agent",
                "task",
                "id",
                "name",
              ]);
  const label = tool === "subagent" ? "subagent" : tool;
  if (detail === undefined) return label;
  // A command line is the most likely place for a token to leak, so the whole
  // line is redacted before it is trimmed to length.
  const full = redact(`${label}: ${detail}`);
  return full.length > TOOL_CHARS ? `${full.slice(0, TOOL_CHARS - 1)}…` : full;
}

function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === "text" && typeof record.text === "string")
      return record.text;
  }
  return undefined;
}

function applyAssistantMessage(
  activity: Activity,
  message: Record<string, unknown>,
  observedAt?: number,
) {
  const content = message.content;
  if (!Array.isArray(content)) {
    const text = messageText(content);
    if (text) {
      activity.text = redact(condense(text, TEXT_CHARS));
      if (observedAt !== undefined) activity.lastActivityAt = observedAt;
    }
    if (observedAt !== undefined) activity.updatedAt = observedAt;
    return;
  }
  for (const block of content) {
    const record = asRecord(block);
    if (!record) continue;
    if (record.type === "thinking") {
      const thinking =
        typeof record.thinking === "string" ? record.thinking.trim() : "";
      if (thinking.length > 0) {
        activity.thought = redact(condense(thinking));
        // Timed against the newer activity, so a later tool can outrank it.
        if (observedAt !== undefined) activity.thoughtAt = observedAt;
      } else {
        activity.thinkingDropped = true;
      }
    } else if (
      record.type === "text" &&
      typeof record.text === "string" &&
      record.text.trim()
    ) {
      activity.text = redact(condense(record.text, TEXT_CHARS));
      if (observedAt !== undefined) activity.lastActivityAt = observedAt;
    }
  }
  if (observedAt !== undefined) activity.updatedAt = observedAt;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** A display family derived only from the invoked tool, never its raw arguments. */
export function toolDisplayName(name: string, args: unknown): string {
  const record = asRecord(args) ?? {};
  const nested = typeof record.tool === "string" ? record.tool : "";
  const identity = `${name} ${nested}`.toLowerCase();
  if (identity.includes("firecrawl")) return "Firecrawl";
  if (identity.includes("higgsfield")) return "Higgsfield";
  if (identity.includes("brave") || name === "search") return "Brave";
  if (identity.includes("gitnexus")) return "GitNexus";
  if (
    name === "bash" &&
    typeof record.command === "string" &&
    /^\s*(?:\/[\w./-]+\/)?higgsfield(?:\s|$)/.test(record.command)
  )
    return "Higgsfield";
  const known: Record<string, string> = {
    bash: "Bash",
    read: "Read",
    edit: "Edit",
    write: "Write",
    fd: "File search",
    rg: "Code search",
    mcp: "MCP",
    mcpScript: "MCP script",
    subagent: "Subagent",
    clef_judge: "Clef",
    ai_detect: "AI detector",
    paraphrase: "Paraphrase",
  };
  // Unknown tool names are still untrusted strings. Redaction strips terminal controls.
  return known[name] ?? (redact(name).slice(0, 48) || "Tool");
}

/** Apply one parsed event. Unknown event types are ignored (fail soft). */
export function applyEvent(activity: Activity, event: unknown): void {
  const record = asRecord(event);
  if (!record) return;
  const observedAt = number(record.observedAt) ?? number(record.ts);

  switch (record.type) {
    case "tool_execution_start": {
      const name = typeof record.toolName === "string" ? record.toolName : "";
      activity.tool = toolLine(name, record.args);
      activity.toolName = name;
      activity.toolStartedAt = observedAt;
      activity.longRunning = false;
      if (name) {
        const id =
          typeof record.toolCallId === "string"
            ? record.toolCallId
            : `${name}:${observedAt ?? activity.recentTools?.length ?? 0}`;
        const recent = activity.recentTools ?? [];
        if (!recent.some((tool) => tool.id === id)) {
          recent.push({
            id,
            name,
            label: toolDisplayName(name, record.args),
            failed: false,
            ...(observedAt !== undefined ? { startedAt: observedAt } : {}),
          });
          activity.recentTools = recent.slice(-8);
        }
      }
      if (observedAt !== undefined) {
        activity.updatedAt = observedAt;
        activity.lastActivityAt = observedAt;
      }
      return;
    }
    case "tool_execution_end": {
      const name =
        typeof record.toolName === "string" ? record.toolName : undefined;
      const isError =
        record.isError === true || asRecord(record.result)?.isError === true;
      const recent = activity.recentTools ?? [];
      const tool =
        typeof record.toolCallId === "string"
          ? recent.find((entry) => entry.id === record.toolCallId)
          : recent
              .slice()
              .reverse()
              .find(
                (entry) =>
                  entry.name === name && entry.finishedAt === undefined,
              );
      if (tool) {
        tool.failed = isError;
        tool.finishedAt = observedAt ?? tool.startedAt ?? 0;
      }
      if (isError) activity.error = `${name ?? "tool"} failed`;
      if (name !== undefined && activity.toolName === name) {
        activity.tool = undefined;
        activity.toolName = undefined;
        activity.toolStartedAt = undefined;
      }
      if (observedAt !== undefined) {
        activity.updatedAt = observedAt;
        activity.lastActivityAt = observedAt;
      }
      return;
    }
    case "message_end": {
      const message = asRecord(record.message);
      if (message?.role === "assistant")
        applyAssistantMessage(activity, message, observedAt);
      return;
    }
    case "thinking_dropped": {
      activity.thinkingDropped = true;
      return;
    }
    case "subagent.control": {
      const control = asRecord(record.event) ?? record;
      if (
        control.type === "active_long_running" ||
        control.to === "active_long_running"
      ) {
        activity.longRunning = true;
      }
      if (
        control.type === "needs_attention" ||
        control.to === "needs_attention"
      ) {
        activity.longRunning = true;
        activity.error = "needs attention";
      }
      const currentTool =
        typeof control.currentTool === "string"
          ? control.currentTool
          : undefined;
      if (currentTool) {
        const where =
          typeof control.currentPath === "string" && control.currentPath
            ? `: ${shortenPath(control.currentPath)}`
            : "";
        activity.tool = redact(`${currentTool}${where}`);
        activity.toolName = currentTool;
        activity.toolStartedAt =
          number(control.currentToolStartedAt) ?? observedAt;
      }
      return;
    }
    case "subagent.step.completed": {
      const exitCode = number(record.exitCode);
      if (exitCode !== undefined && exitCode !== 0)
        activity.error = `exit code ${exitCode}`;
      return;
    }
    case "subagent.run.completed": {
      const status = typeof record.status === "string" ? record.status : "";
      if (status && status !== "complete" && status !== "completed") {
        activity.error ??= `run ${status}`;
      }
      return;
    }
    default:
      return;
  }
}

/** Parse one raw JSONL line into an event record; malformed lines are ignored. */
const TRUNCATED_TYPE = /"type"\s*:\s*"([A-Za-z0-9_.-]{1,64})"/;
const TRUNCATED_TOOL = /"toolName"\s*:\s*"([^"\\]{1,128})"/;
const TRUNCATED_STEP = /"subagentStepIndex"\s*:\s*(\d{1,6})/;

/**
 * The tailer keeps only a bounded prefix of an over-long line, so that prefix no
 * longer parses. `type`, `toolName` and `subagentStepIndex` sit at the head of
 * every event, and recovering them is enough to close a tool whose
 * `tool_execution_end` carried a huge result, on the step it belongs to.
 */
function recoverTruncatedEvent(
  line: string,
): Record<string, unknown> | undefined {
  const type = TRUNCATED_TYPE.exec(line)?.[1];
  if (!type) return undefined;
  const toolName = TRUNCATED_TOOL.exec(line)?.[1];
  const step = TRUNCATED_STEP.exec(line)?.[1];
  return {
    type,
    ...(toolName ? { toolName } : {}),
    ...(step !== undefined ? { subagentStepIndex: Number(step) } : {}),
    truncated: true,
  };
}

export function parseEventLine(
  line: string,
): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return recoverTruncatedEvent(line);
  }
  return asRecord(parsed);
}

/** Which step of its run an event belongs to (`subagentStepIndex`, default 0). */
export function eventStepIndex(event: Record<string, unknown>): number {
  const value = event.subagentStepIndex ?? event.stepIndex;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

/** Apply one raw JSONL line; malformed lines are ignored. */
export function applyEventLine(activity: Activity, line: string): void {
  const event = parseEventLine(line);
  if (event) applyEvent(activity, event);
}

/**
 * The current thinking text, or undefined when later activity (a tool start, a
 * tool end or assistant text) has superseded it. Without timestamps the thought
 * keeps its old priority.
 */
export function currentThought(activity: Activity): string | undefined {
  if (!activity.thought) return undefined;
  if (activity.thoughtAt === undefined) return activity.thought;
  if (
    activity.toolStartedAt !== undefined &&
    activity.toolStartedAt > activity.thoughtAt
  )
    return undefined;
  if (
    activity.lastActivityAt !== undefined &&
    activity.lastActivityAt > activity.thoughtAt
  )
    return undefined;
  return activity.thought;
}

/** Bubble text, or undefined when the child has nothing to say yet. */
export function bubbleText(activity: Activity): string | undefined {
  const thought = currentThought(activity);
  if (thought) return thought;
  if (activity.text) return activity.text;
  return undefined;
}
