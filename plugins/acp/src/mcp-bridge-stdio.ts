import { createInterface } from "node:readline";

const url = requireEnv("TSUKAIMA_ACP_MCP_URL");
const token = requireEnv("TSUKAIMA_ACP_MCP_TOKEN");

const reader = createInterface({ input: process.stdin, terminal: false });

reader.on("line", (line) => {
	if (line.trim().length === 0) return;
	void forward(line);
});

async function forward(line: string): Promise<void> {
	let request: unknown;
	try {
		request = JSON.parse(line);
	} catch {
		writeResponse({ error: { code: -32700, message: "Parse error" }, id: null, jsonrpc: "2.0" });
		return;
	}

	const hasId = isRecord(request) && Object.hasOwn(request, "id");
	try {
		const response = await fetch(url, {
			body: JSON.stringify(request),
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			method: "POST",
		});
		const text = (await response.text()).trim();
		if (hasId && text.length > 0) process.stdout.write(`${text}\n`);
	} catch {
		if (!hasId) return;
		writeResponse({
			error: { code: -32603, message: "MCP bridge request failed" },
			id: isRecord(request) && isJsonRpcId(request.id) ? request.id : null,
			jsonrpc: "2.0",
		});
	}
}

function writeResponse(response: unknown): void {
	process.stdout.write(`${JSON.stringify(response)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is string | number | null {
	return value === null || typeof value === "string" || typeof value === "number";
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) {
		process.stderr.write(`Missing ${name}\n`);
		process.exit(1);
	}
	return value;
}
