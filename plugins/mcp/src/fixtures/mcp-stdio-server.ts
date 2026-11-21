import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** 1x1 opaque PNG used to prove image content survives the MCP → plugin tool boundary. */
const SAMPLE_PNG_BASE64 = Buffer.from(
	[
		"89504e470d0a1a0a0000000d4948445200000001",
		"0000000108060000001f15c4890000000d494441",
		"5478da63fccfc0500f000485018084a98c210000",
		"000049454e44ae426082",
	].join(""),
	"hex",
).toString("base64");

const delayMs = Number(process.env.MCP_MOCK_DELAY_MS ?? "5000");

const tools = [
	{
		description: "Echo the supplied text",
		inputSchema: {
			properties: { text: { type: "string" } },
			required: ["text"],
			type: "object",
		},
		name: "echo",
	},
	{
		description: "Return a synthetic image",
		inputSchema: { properties: {}, type: "object" },
		name: "picture",
	},
	{
		description: "Sleep longer than a short caller timeout",
		inputSchema: { properties: {}, type: "object" },
		name: "slow",
	},
	{
		description: "Return a tool-level error",
		inputSchema: { properties: {}, type: "object" },
		name: "fail",
	},
] as const;

const server = new Server(
	{ name: "mcp-fixture", version: "1.0.0" },
	{ capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools] }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const name = request.params.name;
	const args = request.params.arguments ?? {};
	if (name === "echo") {
		return { content: [{ text: String(args.text ?? ""), type: "text" }] };
	}
	if (name === "picture") {
		return {
			content: [{ data: SAMPLE_PNG_BASE64, mimeType: "image/png", type: "image" }],
		};
	}
	if (name === "slow") {
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		return { content: [{ text: "late", type: "text" }] };
	}
	if (name === "fail") {
		return {
			content: [{ text: "synthetic tool failure", type: "text" }],
			isError: true,
		};
	}
	throw new Error(`Unknown mock tool ${name}`);
});

await server.connect(new StdioServerTransport());
