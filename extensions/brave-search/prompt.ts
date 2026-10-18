/** Describes Brave Search and its model-context output limits. */
export const SEARCH_TOOL_DESCRIPTION =
  "Search the web with the Brave Search API. Returns web, news, or image results; includeContent uses Brave LLM Context to return extracted, relevance-ranked page excerpts for web searches. Output is limited to 50KB or 2000 lines; complete truncated output is saved to a temporary file.";

/** Adds Brave's current-information search capability to the model's tool prompt. */
export const SEARCH_PROMPT_SNIPPET =
  "Search the web, news, or images with Brave Search.";

/** Guides the model on selecting standard search or LLM Context. */
export const SEARCH_PROMPT_GUIDELINES = [
  "Use search when the user asks for current web information, discovery, or sources beyond the local workspace.",
  "Use search with source=news for current reporting and source=images for image discovery.",
  "Use search with includeContent=true when an answer needs extracted page excerpts rather than only links and descriptions.",
  "Brave search discovers and grounds web content but does not crawl an entire site or fetch an arbitrary known URL.",
];

/** Model-facing schema descriptions for Brave Search parameters. */
export const SEARCH_PARAMETER_DESCRIPTIONS = {
  query: "The search query, limited to 400 characters and 50 words.",
  limit: "Maximum number of results. Defaults to 5; maximum 20.",
  includeContent:
    "For web searches, use Brave LLM Context to return extracted, relevance-ranked page excerpts. Defaults to false.",
  country:
    "Optional two-letter country code used to localize results, such as US or GB.",
  searchLanguage:
    "Optional search language code, such as en, en-gb, fr, or de.",
  timeout: "Request timeout in milliseconds. Defaults to 30000.",
};
