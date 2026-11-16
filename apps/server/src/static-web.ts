import { stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

/**
 * The production image serves the built WebUI from the same origin as the API. Development keeps
 * Vite on its own port, so a missing dist directory is a normal 404 rather than a startup error.
 */
export interface StaticWebOptions {
	/** Absolute or process-relative path to `apps/web/dist`. */
	readonly distDir: string;
}

const IMMUTABLE_PREFIX = "/assets/";

function isInside(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function cacheControl(pathname: string): string {
	return pathname.startsWith(IMMUTABLE_PREFIX) ? "public, max-age=31536000, immutable" : "no-cache";
}

/**
 * Minimal SPA file server. It intentionally has no directory listing and never escapes the dist
 * root: unknown asset paths stay 404, while extensionless navigation paths fall back to
 * `index.html` for TanStack Router.
 */
export class StaticWebServer {
	readonly #root: string;

	constructor(options: StaticWebOptions) {
		this.#root = resolve(options.distDir);
	}

	async response(pathname: string): Promise<Response | undefined> {
		let decoded: string;
		try {
			decoded = decodeURIComponent(pathname);
		} catch {
			return undefined;
		}
		if (decoded.includes("\0") || !decoded.startsWith("/")) return undefined;

		const requested = decoded === "/" ? "/index.html" : decoded;
		const candidate = resolve(this.#root, `.${requested}`);
		if (!isInside(this.#root, candidate)) return undefined;

		const file = await this.#file(candidate, requested);
		if (file !== undefined) return file;

		// A request for a concrete file (favicon.ico, chunk, source map) must not return HTML.
		if (extname(decoded) !== "" || decoded.startsWith(IMMUTABLE_PREFIX)) return undefined;

		return this.#file(join(this.#root, "index.html"), "/index.html");
	}

	async #file(path: string, pathname: string): Promise<Response | undefined> {
		const info = await stat(path).catch(() => undefined);
		if (info === undefined || !info.isFile()) return undefined;
		const file = Bun.file(path);
		return new Response(file, {
			headers: {
				"cache-control": cacheControl(pathname),
				"content-length": String(info.size),
			},
		});
	}
}
