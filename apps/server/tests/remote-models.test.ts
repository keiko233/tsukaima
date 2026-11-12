import { describe, expect, test } from "bun:test";
import { listRemoteModels } from "../src/remote-models.ts";

describe("remote model discovery", () => {
	test("fetches, deduplicates, and sorts models without returning credentials", async () => {
		let requestedUrl = "";
		let authorization = "";
		const fetchModels = (async (input: string | URL | Request, init?: RequestInit) => {
			requestedUrl = input instanceof Request ? input.url : String(input);
			authorization = new Headers(init?.headers).get("authorization") ?? "";
			return Response.json({
				data: [
					{ id: "model-b", owned_by: "vendor" },
					"model-a",
					{ id: "model-b", owned_by: "updated-vendor" },
					{ id: "  " },
				],
				object: "list",
			});
		}) as typeof fetch;

		const result = await listRemoteModels(
			{ apiKey: "provider-secret", baseUrl: "https://models.example/v1/" },
			{ fetch: fetchModels },
		);

		expect(requestedUrl).toBe("https://models.example/v1/models");
		expect(authorization).toBe("Bearer provider-secret");
		expect(result).toEqual({
			baseUrl: "https://models.example/v1",
			models: [{ id: "model-a" }, { id: "model-b", ownedBy: "updated-vendor" }],
		});
		expect(JSON.stringify(result)).not.toContain("provider-secret");
	});

	test("reports provider failures without exposing request credentials", async () => {
		const fetchModels = (async () =>
			Response.json(
				{ error: { message: "model access denied" } },
				{ status: 403 },
			)) as unknown as typeof fetch;

		let message = "";
		try {
			await listRemoteModels(
				{ apiKey: "provider-secret", baseUrl: "https://models.example/v1" },
				{ fetch: fetchModels },
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toBe("Model provider request failed (403): model access denied");
		expect(message).not.toContain("provider-secret");
	});

	test("rejects responses that are not model lists", async () => {
		const fetchModels = (async () => Response.json({ models: [] })) as unknown as typeof fetch;

		await expect(
			listRemoteModels(
				{ apiKey: "provider-secret", baseUrl: "https://models.example/v1" },
				{ fetch: fetchModels },
			),
		).rejects.toThrow("Model provider returned an invalid model list");
	});
});
