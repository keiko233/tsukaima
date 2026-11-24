import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** Reports the environment a spawned stdio MCP server actually receives. */
const server = new Server(
	{ name: "mcp-env-fixture", version: "1.0.0" },
	{ capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			description: "Report the spawned process environment",
			inputSchema: { properties: {}, type: "object" },
			name: "environment",
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async () => ({
	content: [
		{
			text: JSON.stringify({
				custom: process.env.MCP_SYNTHETIC_FLAG ?? "",
				cwd: process.cwd(),
				home: process.env.HOME ?? "",
				path: process.env.PATH ?? "",
			}),
			type: "text",
		},
	],
}));

await server.connect(new StdioServerTransport());
