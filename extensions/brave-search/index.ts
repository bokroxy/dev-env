import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  SEARCH_PARAMETER_DESCRIPTIONS,
  SEARCH_PROMPT_GUIDELINES,
  SEARCH_PROMPT_SNIPPET,
  SEARCH_TOOL_DESCRIPTION,
} from "./prompt.ts";

const BRAVE_API_BASE_URL = "https://api.search.brave.com";
const DEFAULT_LIMIT = 5;
const DEFAULT_TIMEOUT_MS = 30_000;

const SearchParameters = Type.Object({
  query: Type.String({
    description: SEARCH_PARAMETER_DESCRIPTIONS.query,
    minLength: 1,
    maxLength: 400,
  }),
  limit: Type.Optional(
    Type.Integer({
      description: SEARCH_PARAMETER_DESCRIPTIONS.limit,
      minimum: 1,
      maximum: 20,
    }),
  ),
  source: Type.Optional(StringEnum(["web", "news", "images"] as const)),
  includeContent: Type.Optional(
    Type.Boolean({
      description: SEARCH_PARAMETER_DESCRIPTIONS.includeContent,
    }),
  ),
  country: Type.Optional(
    Type.String({
      description: SEARCH_PARAMETER_DESCRIPTIONS.country,
      minLength: 2,
      maxLength: 3,
    }),
  ),
  searchLanguage: Type.Optional(
    Type.String({
      description: SEARCH_PARAMETER_DESCRIPTIONS.searchLanguage,
      minLength: 2,
      maxLength: 10,
    }),
  ),
  freshness: Type.Optional(StringEnum(["pd", "pw", "pm", "py"] as const)),
  safeSearch: Type.Optional(StringEnum(["off", "moderate", "strict"] as const)),
  timeout: Type.Optional(
    Type.Integer({
      description: SEARCH_PARAMETER_DESCRIPTIONS.timeout,
      minimum: 1_000,
      maximum: 120_000,
    }),
  ),
});

export type BraveSearchParameters = Static<typeof SearchParameters>;
export type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type BraveSearchDetails = {
  provider: "brave";
  source: "web" | "news" | "images";
  includeContent: boolean;
  response: unknown;
  fullOutputPath?: string;
};

function readEnvValue(name: string) {
  const processValue = process.env[name]?.trim();
  if (processValue) return processValue;

  const envPath = join(
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
    ".env",
  );
  let envText = "";

  try {
    envText = readFileSync(envPath, "utf8");
  } catch {
    return undefined;
  }

  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match || match[1] !== name) continue;

    const rawValue = match[2].trim();
    const value =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ? rawValue.slice(1, -1)
        : rawValue.replace(/\s+#.*$/, "");

    return value.trim() || undefined;
  }

  return undefined;
}

function validateSearchParameters(params: BraveSearchParameters) {
  const query = params.query.trim();
  if (!query) throw new Error("Brave Search query cannot be empty");
  if (query.split(/\s+/).length > 50) {
    throw new Error("Brave Search queries cannot exceed 50 words");
  }

  const source = params.source ?? "web";
  if (params.includeContent && source !== "web") {
    throw new Error(
      "Brave LLM Context is only available when source is set to web",
    );
  }
  if (source === "images" && params.freshness) {
    throw new Error("Brave image search does not support freshness filters");
  }
  if (source === "images" && params.safeSearch === "moderate") {
    throw new Error(
      "Brave image search supports safeSearch values off or strict, not moderate",
    );
  }
  if (params.includeContent && params.safeSearch) {
    throw new Error("Brave LLM Context does not support safeSearch filters");
  }
}

export function buildSearchUrl(params: BraveSearchParameters) {
  validateSearchParameters(params);

  const source = params.source ?? "web";
  const path = params.includeContent
    ? "/res/v1/llm/context"
    : `/res/v1/${source}/search`;
  const url = new URL(path, BRAVE_API_BASE_URL);
  const limit = params.limit ?? DEFAULT_LIMIT;

  url.searchParams.set("q", params.query.trim());
  url.searchParams.set("count", String(limit));

  if (params.includeContent) {
    url.searchParams.set("maximum_number_of_urls", String(limit));
  }
  if (params.country) {
    url.searchParams.set("country", params.country.toUpperCase());
  }
  if (params.searchLanguage) {
    url.searchParams.set("search_lang", params.searchLanguage.toLowerCase());
  }
  if (params.freshness) {
    url.searchParams.set("freshness", params.freshness);
  }
  if (params.safeSearch) {
    url.searchParams.set("safesearch", params.safeSearch);
  }
  if (source === "web" && !params.includeContent) {
    url.searchParams.set("text_decorations", "false");
  }

  return url;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function requestBraveSearch(
  params: BraveSearchParameters,
  apiKey: string,
  signal?: AbortSignal,
  fetcher: Fetcher = fetch,
) {
  const timeoutSignal = AbortSignal.timeout(
    params.timeout ?? DEFAULT_TIMEOUT_MS,
  );
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  let response: Response;
  try {
    response = await fetcher(buildSearchUrl(params), {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal: requestSignal,
    });
  } catch (cause) {
    if (signal?.aborted) {
      throw new Error("Brave Search request cancelled", { cause });
    }
    if (timeoutSignal.aborted) {
      throw new Error(
        `Brave Search request timed out after ${params.timeout ?? DEFAULT_TIMEOUT_MS}ms`,
        { cause },
      );
    }
    throw new Error(`Brave Search request failed: ${errorMessage(cause)}`, {
      cause,
    });
  }

  const body = await response.text();
  if (!response.ok) {
    const detail = body.trim().slice(0, 4_000);
    throw new Error(
      `Brave Search API returned ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
    );
  }

  try {
    const result: unknown = JSON.parse(body);
    return result;
  } catch (cause) {
    throw new Error("Brave Search API returned invalid JSON", { cause });
  }
}

function stringify(value: unknown) {
  return JSON.stringify(value, null, 2) ?? String(value);
}

async function formatOutput(value: unknown) {
  const output = stringify(value);
  const truncation = truncateHead(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncation.truncated) {
    return { text: output, fullOutputPath: undefined };
  }

  const outputDirectory = await mkdtemp(join(tmpdir(), "pi-brave-search-"));
  const outputPath = join(outputDirectory, "search.json");
  await writeFile(outputPath, output, "utf8");

  return {
    text: `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${outputPath}]`,
    fullOutputPath: outputPath,
  };
}

async function runBraveSearch(
  params: BraveSearchParameters,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<BraveSearchDetails | undefined> | undefined,
) {
  const apiKey = readEnvValue("BRAVE_API_KEY");
  if (!apiKey) {
    throw new Error(
      "Missing BRAVE_API_KEY in the environment or ~/.pi/agent/.env",
    );
  }

  const source = params.source ?? "web";
  const includeContent = params.includeContent ?? false;
  onUpdate?.({
    content: [
      {
        type: "text",
        text: includeContent
          ? `Searching Brave LLM Context for: ${params.query}`
          : `Searching Brave ${source} for: ${params.query}`,
      },
    ],
    details: undefined,
  });

  const response = await requestBraveSearch(params, apiKey, signal);
  const formatted = await formatOutput(response);
  const details: BraveSearchDetails = {
    provider: "brave",
    source,
    includeContent,
    response,
    ...(formatted.fullOutputPath
      ? { fullOutputPath: formatted.fullOutputPath }
      : {}),
  };

  return {
    content: [{ type: "text" as const, text: formatted.text }],
    details,
  } satisfies AgentToolResult<BraveSearchDetails>;
}

export default function braveSearch(pi: ExtensionAPI) {
  pi.registerTool({
    name: "search",
    label: "Brave Search",
    description: SEARCH_TOOL_DESCRIPTION,
    promptSnippet: SEARCH_PROMPT_SNIPPET,
    promptGuidelines: SEARCH_PROMPT_GUIDELINES,
    parameters: SearchParameters,
    execute: (_toolCallId, params, signal, onUpdate) =>
      runBraveSearch(params, signal, onUpdate),
  });
}
