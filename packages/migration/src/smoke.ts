import type { NormalizedConversation, NormalizedMessage } from "./normalize.ts";

export interface FakeOneBotEnvelope {
	readonly channelId: "onebot-napcat";
	readonly channelKind: "onebot-v11";
	readonly conversationKey: {
		readonly kind: "private" | "group" | "webui" | "task" | "plugin";
		readonly id: string;
	};
	readonly id: string;
	readonly mentions: readonly string[];
	readonly parts: readonly { readonly type: "text"; readonly text: string }[];
	readonly sender: {
		readonly displayName: string;
		readonly id: string;
		readonly platformId: string;
	};
	readonly source: { readonly timestampMs: number };
}

export interface FakeModelAdapter {
	complete(input: {
		readonly messages: readonly {
			readonly content: string;
			readonly role: "user" | "assistant" | "system";
		}[];
	}): Promise<string>;
}

export interface SmokeTurnResult {
	readonly ok: boolean;
	readonly envelope: FakeOneBotEnvelope | null;
	readonly modelText: string;
	readonly reason: string | null;
}

export function createFakeOneBotEnvelope(input: {
	readonly conversation: Pick<
		NormalizedConversation,
		"channelId" | "kind" | "platformConversationId" | "title"
	>;
	readonly message: Pick<
		NormalizedMessage,
		"platformMessageId" | "senderExternalId" | "senderDisplayName" | "content" | "occurredAt"
	>;
}): FakeOneBotEnvelope {
	return {
		channelId: "onebot-napcat",
		channelKind: "onebot-v11",
		conversationKey: {
			id: input.conversation.platformConversationId,
			kind: input.conversation.kind,
		},
		id: input.message.platformMessageId,
		mentions: [],
		parts: [{ text: input.message.content, type: "text" }],
		sender: {
			displayName: input.message.senderDisplayName ?? "Migrated user",
			id: input.message.senderExternalId ?? "migrated-user",
			platformId: input.message.senderExternalId ?? "migrated-user",
		},
		source: { timestampMs: new Date(input.message.occurredAt).getTime() },
	};
}

export function createDeterministicFakeModel(response = "migration smoke reply"): FakeModelAdapter {
	return {
		async complete() {
			return response;
		},
	};
}

export async function runFakeMigrationSmokeTurn(input: {
	readonly conversation: NormalizedConversation;
	readonly messages: readonly NormalizedMessage[];
	readonly model?: FakeModelAdapter;
	readonly response?: string;
}): Promise<SmokeTurnResult> {
	const lastInbound = [...input.messages]
		.toReversed()
		.find((message) => message.direction === "inbound");
	if (lastInbound === undefined) {
		return {
			envelope: null,
			modelText: "",
			ok: false,
			reason: "No imported inbound message is available for the smoke turn",
		};
	}
	const envelope = createFakeOneBotEnvelope({
		conversation: input.conversation,
		message: lastInbound,
	});
	const model = input.model ?? createDeterministicFakeModel(input.response);
	try {
		const text = await model.complete({
			messages: [
				{
					content: lastInbound.content,
					role: "user",
				},
			],
		});
		return {
			envelope,
			modelText: text,
			ok: text.trim().length > 0,
			reason: text.trim().length > 0 ? null : "Fake model returned an empty reply",
		};
	} catch (error) {
		return {
			envelope,
			modelText: "",
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}
