import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerSnapshot } from "@tsukaima/contracts";
import { createApp } from "../src/app.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

describe("MCP OAuth HTTP callback route", () => {
	test("completes pending OAuth authorization via /api/mcp/oauth/callback and connects the MCP server", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-mcp-oauth-cb-"));
		directories.push(directory);

		const accessToken = "example-oauth-token";
		const authCode = "synthetic-e2e-auth-code";
		let expectedChallenge = "";
		let expectedRedirectUri = "";

		const mcpServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request): Promise<Response> {
				const url = new URL(request.url);
				const origin = url.origin;
				if (url.pathname === "/.well-known/oauth-authorization-server") {
					return Response.json({
						authorization_endpoint: `${origin}/authorize`,
						code_challenge_methods_supported: ["S256"],
						issuer: origin,
						registration_endpoint: `${origin}/register`,
						response_types_supported: ["code"],
						token_endpoint: `${origin}/token`,
						token_endpoint_auth_methods_supported: ["none"],
					});
				}
				if (url.pathname === "/register" && request.method === "POST") {
					return Response.json(
						{
							client_id: "e2e-dcr-client",
							grant_types: ["authorization_code", "refresh_token"],
							redirect_uris: ["http://127.0.0.1:7420/api/mcp/oauth/callback"],
							response_types: ["code"],
							token_endpoint_auth_method: "none",
						},
						{ status: 201 },
					);
				}
				if (url.pathname === "/token" && request.method === "POST") {
					const form = new URLSearchParams(await request.text());
					const verifier = form.get("code_verifier") ?? "";
					const challenge = createHash("sha256").update(verifier).digest("base64url");
					if (
						form.get("code") !== authCode ||
						challenge !== expectedChallenge ||
						form.get("redirect_uri") !== expectedRedirectUri
					) {
						return Response.json({ error: "invalid_grant" }, { status: 400 });
					}
					return Response.json({
						access_token: accessToken,
						expires_in: 3600,
						token_type: "Bearer",
					});
				}
				if (url.pathname === "/mcp") {
					if (request.headers.get("authorization") !== `Bearer ${accessToken}`) {
						return new Response("Unauthorized", { status: 401 });
					}
					if (request.method === "GET") return new Response(null, { status: 405 });
					const body = (await request.json()) as { id?: string | number; method: string };
					if (body.method === "initialize") {
						return Response.json({
							id: body.id,
							jsonrpc: "2.0",
							result: {
								capabilities: { tools: {} },
								protocolVersion: "2025-03-26",
								serverInfo: { name: "synthetic-e2e-mcp", version: "1.0.0" },
							},
						});
					}
					if (body.method === "notifications/initialized") {
						return new Response(null, { status: 202 });
					}
					if (body.method === "tools/list") {
						return Response.json({
							id: body.id,
							jsonrpc: "2.0",
							result: {
								tools: [
									{
										description: "Echo OAuth tool",
										inputSchema: { properties: {}, type: "object" },
										name: "hello",
									},
								],
							},
						});
					}
				}
				return new Response("Not found", { status: 404 });
			},
		});

		const { app, lifecycle } = createApp({
			TSUKAIMA_DATA_DIR: directory,
			TSUKAIMA_PORT: "7420",
			TSUKAIMA_PUBLIC_URL: "http://127.0.0.1:7420",
		});
		await lifecycle.start();
		try {
			const created = (await lifecycle.pluginHost.invokeRpc(
				"mcp.create",
				{
					deferred: true,
					enabled: true,
					id: "synthetic-e2e-oauth",
					name: "Synthetic E2E OAuth",
					surface: "both",
					timeoutMs: 5_000,
					transport: {
						auth: { grantType: "authorization_code", type: "oauth" },
						type: "http",
						url: `${mcpServer.url.origin}/mcp`,
					},
				},
				"mcp",
			)) as McpServerSnapshot;
			expect(created.state).toBe("auth_required");
			const authUrl = new URL(created.oauth?.authorizationUrl ?? "");
			expectedChallenge = authUrl.searchParams.get("code_challenge") ?? "";
			expectedRedirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
			const state = authUrl.searchParams.get("state") ?? "";

			const callbackResponse = await app.handle(
				new Request(
					`http://localhost/api/mcp/oauth/callback?code=${encodeURIComponent(authCode)}&state=${encodeURIComponent(state)}`,
				),
			);
			expect(callbackResponse.status).toBe(200);
			expect(callbackResponse.headers.get("content-type")).toContain("text/html");
			const html = await callbackResponse.text();
			expect(html).toContain("tsukaima:mcp-oauth-callback");
			expect(html).toContain("MCP Authorization Complete");

			const listResult = (await lifecycle.pluginHost.invokeRpc("mcp.list", undefined, "mcp")) as {
				servers: McpServerSnapshot[];
			};
			expect(listResult.servers[0]?.state).toBe("connected");
			expect(listResult.servers[0]?.tools.map((tool) => tool.name)).toEqual(["hello"]);

			// Unknown or replayed state returns 400 HTML error response.
			const badResponse = await app.handle(
				new Request(
					`http://localhost/api/mcp/oauth/callback?code=${encodeURIComponent(authCode)}&state=${encodeURIComponent(state)}`,
				),
			);
			expect(badResponse.status).toBe(400);
			expect(await badResponse.text()).toContain("MCP Authorization Failed");
		} finally {
			await lifecycle.stop();
			await mcpServer.stop(true);
		}
	});
});
