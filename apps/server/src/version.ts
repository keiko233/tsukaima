import { readFileSync } from "node:fs";
import { join } from "node:path";

const FALLBACK_VERSION = "0.1.0";

/**
 * Release builds inject `TSUKAIMA_VERSION` from the mainline tag. Source checkouts fall back to
 * the root VERSION file so `/healthz` never reports a version that disagrees with the release.
 */
export function runtimeVersion(env: Record<string, string | undefined> = process.env): string {
	const injected = env.TSUKAIMA_VERSION?.trim();
	if (injected !== undefined && injected.length > 0) return injected;
	try {
		const fileVersion = readFileSync(join(process.cwd(), "VERSION"), "utf8").trim();
		if (fileVersion.length > 0) return fileVersion;
	} catch {
		// A packaged build without VERSION still needs a stable health payload.
	}
	return FALLBACK_VERSION;
}
