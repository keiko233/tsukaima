import type { TsukaimaPlugin, PluginContext, PluginLogger } from "@tsukaima/sdk";
import { SnapshotCache } from "./cache.ts";
import { recordValue, type SearchProvider } from "./domain.ts";
import { SearchEngine } from "./engine.ts";
import {
	DEFAULT_FETCH_POLICY,
	SafeFetcher,
	createDefaultFetchTransport,
	type FetchTransport,
} from "./fetch.ts";
import { ProviderGovernor } from "./governor.ts";
import { childLogger } from "./logging.ts";
import {
	SEARCH_FETCH_PLUGIN_ID,
	SEARCH_FETCH_TRANSPORT_BINDING,
	searchFetchManifest,
} from "./manifest.ts";
import { normalizeSearchPolicy, type SearchPolicy } from "./policy.ts";
import {
	createBraveProvider,
	createChineseProvider,
	createGithubProvider,
	createKeylessProvider,
	createNewsProvider,
	createSerperProvider,
	createTavilyProvider,
	createWikipediaProvider,
} from "./providers.ts";
import { registerSearchFetchRpc } from "./rpc.ts";
import { SearchFetchService } from "./service.ts";
import { registerSearchFetchTools } from "./tools.ts";

export {
	SEARCH_FETCH_PLUGIN_ID,
	SEARCH_FETCH_RPC_PREFIX,
	SEARCH_FETCH_TRANSPORT_BINDING,
	searchFetchManifest,
} from "./manifest.ts";
export {
	DEFAULT_PRIORITY,
	DEFAULT_LANGUAGE_POOLS,
	DEFAULT_SEARCH_POLICY,
	normalizeSearchPolicy,
} from "./policy.ts";
export type { CachePolicy, SearchPolicy } from "./policy.ts";
export {
	SEARCH_CAPABILITIES,
	TIME_RANGES,
	MAX_FETCH_URL_LENGTH,
	MAX_QUERY_LENGTH,
	MAX_RESULTS,
	MAX_SNAPSHOT_CHARS,
	ProviderOutputError,
	normalizeProviderResults,
	normalizeSearchResult,
	normalizeUrlForDedupe,
	searchInputSchema,
	searchResultSchema,
	timeRangeSchema,
} from "./domain.ts";
export type {
	ProviderRateLimit,
	SearchCapability,
	SearchInput,
	SearchProvider,
	SearchProviderContext,
	SearchRequest,
	SearchResult,
	TimeRange,
} from "./domain.ts";
export {
	createBraveProvider,
	createChineseProvider,
	createGithubProvider,
	createKeylessProvider,
	createNewsProvider,
	parseDuckDuckGoHtml,
	parseRssResults,
	createSerperProvider,
	createTavilyProvider,
	createWikipediaProvider,
} from "./providers.ts";
export { SearchEngine, type SearchAttempt, type SearchOutcome } from "./engine.ts";
export { ProviderGovernor } from "./governor.ts";
export { SnapshotCache } from "./cache.ts";
export { htmlToText, extractHtmlContent, decodeEntities } from "./html.ts";
export {
	DEFAULT_FETCH_POLICY,
	SafeFetcher,
	createDefaultFetchTransport,
	type FetchPolicy,
	type FetchTransport,
	type SafeFetchResult,
} from "./fetch.ts";
export {
	SafeFetchError,
	assertNoDnsRebinding,
	hostMatches,
	isHostAllowed,
	isNonPublicIp,
	isNonPublicIPv4,
	isNonPublicIPv6,
	normalizeHost,
	resolvePublicAddresses,
	validateHttpUrl,
} from "./url-policy.ts";
export {
	SearchFetchService,
	type ProviderRow,
	type SearchFetchOverview,
	type TestQueryResult,
} from "./service.ts";
export { registerSearchFetchRpc } from "./rpc.ts";
export { registerSearchFetchTools } from "./tools.ts";
export { redactSecretText, redactSecrets } from "./redaction.ts";
export {
	LOG_PREVIEW_CHARS,
	childLogger,
	elapsedMs,
	errorSummary,
	hostOf,
	previewText,
	sanitizedUrl,
} from "./logging.ts";

export interface SearchFetchTransportBinding {
	readonly fetch?: typeof fetch;
	readonly resolve?: FetchTransport["resolve"];
}

interface SearchFetchRuntime {
	unsubscribe?: (() => void) | undefined;
}

const POLICY_KEY = "search-policy";
const runtimes = new WeakMap<PluginContext, SearchFetchRuntime>();

interface SecretState {
	readonly secrets: readonly string[];
	brave: string;
	serper: string;
	tavily: string;
}

function readSecrets(config: Record<string, unknown>): SecretState {
	const brave = typeof config.braveApiKey === "string" ? config.braveApiKey.trim() : "";
	const tavily = typeof config.tavilyApiKey === "string" ? config.tavilyApiKey.trim() : "";
	const serper = typeof config.serperApiKey === "string" ? config.serperApiKey.trim() : "";
	return {
		brave,
		secrets: [brave, tavily, serper].filter((secret) => secret.length > 0),
		serper,
		tavily,
	};
}

function resolvePolicy(config: Record<string, unknown>, stored: unknown): SearchPolicy {
	const storedRecord = recordValue(stored);
	return normalizeSearchPolicy({
		...config,
		...storedRecord,
		cache: { ...recordValue(config.cache), ...recordValue(storedRecord.cache) },
		languagePools: {
			...recordValue(config.languagePools),
			...recordValue(storedRecord.languagePools),
		},
		rateLimits: { ...recordValue(config.rateLimits), ...recordValue(storedRecord.rateLimits) },
	});
}

function resolveTransport(context: PluginContext): FetchTransport {
	const injected = context.dependencies?.get<SearchFetchTransportBinding>(
		SEARCH_FETCH_TRANSPORT_BINDING,
	);
	const fallback = createDefaultFetchTransport();
	return {
		fetch: injected?.fetch ?? fallback.fetch,
		resolve: injected?.resolve ?? fallback.resolve,
	};
}

function buildProviders(
	secrets: { brave: string; serper: string; tavily: string },
	transport: FetchTransport,
): SearchProvider[] {
	const providerTransport = { fetch: transport.fetch };
	return [
		createKeylessProvider(providerTransport),
		createChineseProvider(providerTransport),
		createWikipediaProvider(providerTransport),
		createGithubProvider(providerTransport),
		createNewsProvider(providerTransport),
		createBraveProvider(providerTransport, () => secrets.brave),
		createTavilyProvider(providerTransport, () => secrets.tavily),
		createSerperProvider(providerTransport, () => secrets.serper),
	];
}

interface PluginLoggers {
	readonly cache: PluginLogger;
	readonly engine: PluginLogger;
	readonly fetch: PluginLogger;
	readonly governor: PluginLogger;
	readonly rpc: PluginLogger;
	readonly service: PluginLogger;
	readonly tools: PluginLogger;
}

/** One labelled child per layer so host logs attribute every line to its component. */
function pluginLoggers(logger: PluginLogger): PluginLoggers {
	return {
		cache: childLogger(logger, "cache") ?? logger,
		engine: childLogger(logger, "engine") ?? logger,
		fetch: childLogger(logger, "fetch") ?? logger,
		governor: childLogger(logger, "governor") ?? logger,
		rpc: childLogger(logger, "rpc") ?? logger,
		service: childLogger(logger, "service") ?? logger,
		tools: childLogger(logger, "tools") ?? logger,
	};
}

export const searchFetchPlugin: TsukaimaPlugin = {
	manifest: searchFetchManifest,
	async setup(context) {
		const config = recordValue((await context.settings?.get()) ?? {});
		const stored = await context.storage.global.get<unknown>(POLICY_KEY);
		const policy = resolvePolicy(config, stored);
		const transport = resolveTransport(context);
		const secretState = readSecrets(config);
		const providers = buildProviders(secretState, transport);
		const loggers = pluginLoggers(context.logger);
		const governor = new ProviderGovernor({
			cooldownMs: policy.cooldownMs,
			failureThreshold: policy.failureThreshold,
			logger: loggers.governor,
		});
		const cache = new SnapshotCache({ ...policy.cache, logger: loggers.cache });
		const engine = new SearchEngine({
			fetch: transport.fetch,
			governor,
			logger: loggers.engine,
			policy,
			providers,
		});
		const fetcher = new SafeFetcher({
			logger: loggers.fetch,
			policy: {
				...DEFAULT_FETCH_POLICY,
				allowDomains: policy.allowDomains,
				blockDomains: policy.blockDomains,
			},
			transport,
		});
		const reportStatus = (): void => {
			const rows = service.providers().providers;
			const enabled = rows.filter((row) => row.enabled).length;
			context.ui.setStatus({
				code: enabled > 0 ? "ready" : "unconfigured",
				level: enabled > 0 ? "ok" : "warning",
				metrics: {
					cacheBytes: cache.stats().bytes,
					cacheEntries: cache.stats().entries,
					enabled,
					providers: rows.length,
				},
				summary: `${enabled}/${rows.length} search providers enabled`,
			});
		};
		const service = new SearchFetchService({
			...(context.audit === undefined ? {} : { audit: context.audit }),
			cache,
			engine,
			fetcher,
			governor,
			logger: loggers.service,
			async onPolicyChange(next) {
				await context.storage.global.set(POLICY_KEY, next);
				reportStatus();
			},
			policy,
			secrets: secretState.secrets,
		});
		registerSearchFetchTools(context, service, loggers.tools);
		registerSearchFetchRpc(context, service, loggers.rpc);
		const runtime: SearchFetchRuntime = {};
		runtimes.set(context, runtime);
		runtime.unsubscribe = context.settings?.onChange(async (next) => {
			const nextSecrets = readSecrets(recordValue(next));
			secretState.brave = nextSecrets.brave;
			secretState.tavily = nextSecrets.tavily;
			secretState.serper = nextSecrets.serper;
			service.updateSecrets(nextSecrets.secrets);
			context.logger.debug("search-fetch configuration changed", {
				providers: [
					nextSecrets.brave.length > 0 ? "brave:on" : "brave:off",
					nextSecrets.tavily.length > 0 ? "tavily:on" : "tavily:off",
					nextSecrets.serper.length > 0 ? "serper:on" : "serper:off",
				],
				configuredKeyCount: nextSecrets.secrets.length,
			});
			reportStatus();
		});
		reportStatus();
		context.logger.info("search-fetch ready", {
			policy: {
				allowDomains: policy.allowDomains.length,
				blockDomains: policy.blockDomains.length,
				maxProviders: policy.maxProviders,
				maxResults: policy.maxResults,
			},
			providers: providers.length,
			configuredKeyCount: readSecrets(config).secrets.length,
		});
	},
	teardown(context) {
		const runtime = runtimes.get(context);
		const unsubscribed = runtime?.unsubscribe !== undefined;
		runtime?.unsubscribe?.();
		runtimes.delete(context);
		context.ui.setStatus(null);
		context.logger.info("search-fetch torn down", { unsubscribed });
	},
};

export default searchFetchPlugin;
export { SEARCH_FETCH_PLUGIN_ID as PLUGIN_ID };
