/**
 * Resolves a WebUI HTTP path against the page origin.
 *
 * oRPC's RPCLink calls `new URL()` on its `url` option, which rejects a bare path such as
 * `/rpc` ("Failed to construct 'URL': Invalid URL"). EventSource accepts relative paths, but
 * using one resolver for every WebUI transport keeps development, production, and
 * reverse-proxied deployments on the same contract.
 */
export function resolveRuntimeUrl(path: string, origin: string | undefined): string {
	if (origin === undefined || origin === "") {
		throw new Error(`Cannot resolve ${path}: the browser origin is unavailable`);
	}
	return new URL(path, origin).toString();
}

/** Browser entry point. Kept separate so the resolver above stays testable without a DOM. */
export function runtimeUrl(path: string): string {
	return resolveRuntimeUrl(path, globalThis.location?.origin);
}
