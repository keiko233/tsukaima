import { readFileSync } from "node:fs";
import { join } from "node:path";

const FALLBACK_VERSION = "0.1.0";

/**
 * The image bakes `TSUKAIMA_VERSION` in at container creation, so it goes stale after an
 * in-container upgrade. The checkout's VERSION file is the live answer and takes precedence;
 * the injected value only covers packaged builds whose VERSION was not shipped.
 */
export function runtimeVersion(
	env: Record<string, string | undefined> = process.env,
	repositoryRoot = process.cwd(),
): string {
	try {
		const fileVersion = readFileSync(join(repositoryRoot, "VERSION"), "utf8").trim();
		if (fileVersion.length > 0) return fileVersion;
	} catch {
		// A packaged build without VERSION still needs a stable health payload.
	}
	const injected = env.TSUKAIMA_VERSION?.trim();
	if (injected !== undefined && injected.length > 0) return injected;
	return FALLBACK_VERSION;
}
