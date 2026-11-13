# Search and fetch spec

## Outcome

The model can search and fetch the web through policy-controlled providers without exposing raw
credentials, browsing arbitrary local content, or bloating context.

## Current boundary

No runtime search/fetch tools exist. DSH uses `dsh-free-search` and web search/fetch plugins,
with a curated safe-fetch MCP.

## Plugin identity

`search-fetch` owns provider registration, result normalization, caching, and tools. Provider
API keys live in plugin secret config/environment and are never returned or logged.

## Provider contract

```ts
type SearchProvider = {
  id: string;
  capabilities: readonly ("web" | "news" | "time-range" | "domain" | "platform" | "multi")[];
  rateLimit: { perMinute: number; perHour: number };
  search(input: SearchInput): Promise<SearchResult[]>;
};
```

`SearchResult` includes title, URL, domain, snippet, publishedAt, language, score, provider ID,
and raw cache reference. Results are schema-validated and normalized.

## First providers

Implement in this order:

1. keyless fallback provider
2. multi-provider orchestration
3. domain-specific Chinese/slang provider
4. platform providers
5. optional keyed providers

Engine selection is policy-driven with language, recency, domain, failure-aware fallback,
cooldown, and explicit allow/deny lists.

## Tools

All tools register under `search-fetch.*` and enforce Phase 3 `ToolPolicy` (`timeoutMs`,
`maxConcurrent`, `maxPayloadBytes`, `visibility`):

| Tool | Input | Output |
| --- | --- | --- |
| `search-fetch.web` | query, engine/auto, language, timeRange, maxResults | normalized results |
| `search-fetch.multi` | query, providers, language, timeRange | merged/deduped results |
| `search-fetch.domain` | query, allowed domains, recency | normalized results |
| `search-fetch.fetch` | URL | safe extracted text/title/metadata |
| `search-fetch.snapshot` | fetchId | cached bounded content |

Inputs have hard limits. Output includes provider and cache metadata.

## Fetch safety

Default policy:

1. only HTTP/HTTPS
2. block private/link-local/multicast and non-public destinations
3. DNS rebinding protection
4. redirect limit and revalidation against IP policy
5. content-type allowlist
6. response size and timeout limits
7. HTML-to-text extraction
8. script/style/navigation removal
9. strip non-content payloads and unsafe metadata
10. domain block/allow policy
11. audit fetches without page body

Cache is bounded by size, TTL, and per-conversation retention. Cache content is still subject
to context budget and may be excluded from prompts.

## Model context

1. Choose engine/provider based on query class.
2. Prefer direct citations over long quotes.
3. If no useful result, return explicit not-found.
4. Search failures return model-visible errors without retry storms.
5. The bot-facing persona must not expose tool names unless policy allows.

## Admin UI

- provider list/enable/priority/fallbacks
- language pools and time-range support
- rate limits
- domain block/allow lists
- cache stats/clear
- test query with provider, status, result count, latency, and errors

## Tests

1. Provider normalization and malformed output.
2. Engine routing/fallback/cooldown.
3. Multi-provider merge and score.
4. SSRF, redirect, MIME, size, and timeout rejection.
5. HTML extraction and cache limits.
6. Tool policy, audit, and secrets redaction.

## Acceptance

Keyed and keyless providers can be configured safely; searches work with fallback; fetches are
SSRF-hardened; the WebUI can test providers and clear cache.
