import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ERROR_BODY_LENGTH = 500;

export const remoteModelsInputSchema = z.object({
	apiKey: z.string().min(1).optional(),
	baseUrl: z.string().url().optional(),
});

export type RemoteModelsInput = z.infer<typeof remoteModelsInputSchema>;

export interface RemoteModel {
	readonly id: string;
	readonly ownedBy?: string;
}

export interface RemoteModelList {
	readonly baseUrl: string;
	readonly models: readonly RemoteModel[];
}

export interface RemoteModelProvider {
	readonly apiKey: string;
	readonly baseUrl: string;
}

interface RemoteModelOptions {
	readonly fetch?: typeof fetch;
	readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new Error("Model base URL is not configured");
	const url = new URL(trimmed);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Model base URL must use http:// or https://");
	}
	return trimmed.replace(/\/+$/, "");
}

function providerErrorMessage(payload: unknown): string | undefined {
	if (!isRecord(payload)) return undefined;
	const error = isRecord(payload.error) ? payload.error : undefined;
	const message = error?.message ?? payload.message;
	return typeof message === "string" && message.trim().length > 0
		? message.trim().slice(0, MAX_ERROR_BODY_LENGTH)
		: undefined;
}

async function responseError(response: Response): Promise<Error> {
	const fallback = `Model provider request failed (${response.status})`;
	const raw = await response.text().catch(() => "");
	if (raw.trim().length === 0) return new Error(fallback);
	try {
		const detail = providerErrorMessage(JSON.parse(raw) as unknown);
		return new Error(detail === undefined ? fallback : `${fallback}: ${detail}`);
	} catch {
		return new Error(`${fallback}: ${raw.trim().slice(0, MAX_ERROR_BODY_LENGTH)}`);
	}
}

function parseRemoteModels(payload: unknown): RemoteModel[] {
	const candidates = Array.isArray(payload)
		? payload
		: isRecord(payload) && Array.isArray(payload.data)
			? payload.data
			: undefined;
	if (candidates === undefined) {
		throw new Error("Model provider returned an invalid model list");
	}

	const models = new Map<string, RemoteModel>();
	for (const candidate of candidates) {
		if (typeof candidate === "string") {
			const id = candidate.trim();
			if (id.length > 0) models.set(id, { id });
			continue;
		}
		if (!isRecord(candidate) || typeof candidate.id !== "string") continue;
		const id = candidate.id.trim();
		if (id.length === 0) continue;
		const ownedBy =
			typeof candidate.owned_by === "string"
				? candidate.owned_by.trim()
				: typeof candidate.ownedBy === "string"
					? candidate.ownedBy.trim()
					: "";
		models.set(id, {
			id,
			...(ownedBy.length > 0 ? { ownedBy } : {}),
		});
	}

	return [...models.values()].toSorted((left, right) => left.id.localeCompare(right.id));
}

export async function listRemoteModels(
	provider: RemoteModelProvider,
	options: RemoteModelOptions = {},
): Promise<RemoteModelList> {
	const baseUrl = normalizeBaseUrl(provider.baseUrl);
	const apiKey = provider.apiKey.trim();
	if (apiKey.length === 0) throw new Error("Provider API key is not configured");

	let response: Response;
	try {
		response = await (options.fetch ?? fetch)(`${baseUrl}/models`, {
			headers: {
				accept: "application/json",
				authorization: `Bearer ${apiKey}`,
			},
			method: "GET",
			signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
	} catch (error) {
		if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
			throw new Error("Timed out fetching models from the model provider", { cause: error });
		}
		throw new Error(
			`Could not reach the model provider: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}

	if (!response.ok) throw await responseError(response);

	let payload: unknown;
	try {
		payload = (await response.json()) as unknown;
	} catch (error) {
		throw new Error(
			`Model provider returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}

	return { baseUrl, models: parseRemoteModels(payload) };
}
