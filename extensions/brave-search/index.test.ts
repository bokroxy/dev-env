import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchUrl, requestBraveSearch, type Fetcher } from "./index.ts";

test("builds a Brave web search request", () => {
  const url = buildSearchUrl({
    query: "pi coding agent",
    limit: 7,
    country: "gb",
    searchLanguage: "en-gb",
    freshness: "pw",
    safeSearch: "strict",
  });

  assert.equal(url.pathname, "/res/v1/web/search");
  assert.equal(url.searchParams.get("q"), "pi coding agent");
  assert.equal(url.searchParams.get("count"), "7");
  assert.equal(url.searchParams.get("country"), "GB");
  assert.equal(url.searchParams.get("search_lang"), "en-gb");
  assert.equal(url.searchParams.get("freshness"), "pw");
  assert.equal(url.searchParams.get("safesearch"), "strict");
  assert.equal(url.searchParams.get("text_decorations"), "false");
});

test("uses Brave LLM Context when page content is requested", () => {
  const url = buildSearchUrl({
    query: "Brave Search API",
    limit: 3,
    includeContent: true,
  });

  assert.equal(url.pathname, "/res/v1/llm/context");
  assert.equal(url.searchParams.get("count"), "3");
  assert.equal(url.searchParams.get("maximum_number_of_urls"), "3");
  assert.equal(url.searchParams.has("text_decorations"), false);
});

test("sends the Brave subscription token without putting it in the URL", async () => {
  let requestedUrl = "";
  let token: string | null = null;
  const fetcher: Fetcher = async (input, init) => {
    requestedUrl = input instanceof Request ? input.url : String(input);
    token = new Headers(init?.headers).get("X-Subscription-Token");
    return new Response(JSON.stringify({ web: { results: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await requestBraveSearch(
    { query: "test" },
    "brave-secret",
    undefined,
    fetcher,
  );

  assert.equal(token, "brave-secret");
  assert.equal(requestedUrl.includes("brave-secret"), false);
  assert.deepEqual(result, { web: { results: [] } });
});

test("reports Brave API errors", async () => {
  const fetcher: Fetcher = async () =>
    new Response(
      JSON.stringify({ error: { code: "SUBSCRIPTION_TOKEN_INVALID" } }),
      {
        status: 401,
        statusText: "Unauthorized",
      },
    );

  await assert.rejects(
    requestBraveSearch({ query: "test" }, "bad-key", undefined, fetcher),
    /401 Unauthorized.*SUBSCRIPTION_TOKEN_INVALID/,
  );
});

test("rejects unsupported image search filters before requesting", () => {
  assert.throws(
    () =>
      buildSearchUrl({
        query: "mountains",
        source: "images",
        safeSearch: "moderate",
      }),
    /supports safeSearch values off or strict/,
  );
});
