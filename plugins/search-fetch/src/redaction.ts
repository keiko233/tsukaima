const SECRET_KEY =
	/(?:api|private)[-_]?key|(?:access|refresh|auth)[-_]?token|^token$|secret|password|passwd|authorization|cookie|credential/iu;

/** Remove any configured secret value from free-form text before it can be logged or returned. */
export function redactSecretText(value: string, secrets: readonly string[]): string {
	let output = value;
	for (const secret of secrets) {
		if (secret.trim().length < 4) continue;
		output = output.split(secret).join("[REDACTED]");
	}
	return output;
}

/** Recursively redact sensitive keys and configured secret values from an RPC/audit payload. */
export function redactSecrets(value: unknown, secrets: readonly string[], depth = 0): unknown {
	if (depth > 6) return "[Object]";
	if (typeof value === "string") return redactSecretText(value, secrets);
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) {
		return value.map((entry) => redactSecrets(entry, secrets, depth + 1));
	}
	const output: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		output[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactSecrets(entry, secrets, depth + 1);
	}
	return output;
}
