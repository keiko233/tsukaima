import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, type ConversationId, defineEntry } from "@earendil-works/pi-durable";
import type { ChaoticStorageOptions } from "./open-chaotic-storage.ts";
import { openChaoticStorage } from "./open-chaotic-storage.ts";

const restartDrillEntry = defineEntry<{ readonly reason: string }>("elaina.restartDrill");

export interface RestartDrillResult {
	readonly committedBeforeRestart: boolean;
	readonly conversationId: number;
	readonly entryId: number;
	readonly observedAfterRestart: boolean;
}

export async function runRestartDrill(
	path: string,
	options: ChaoticStorageOptions = {},
): Promise<RestartDrillResult> {
	let conversationId: ConversationId | undefined;
	let entryId: string | undefined;
	let committedBeforeRestart = false;
	let injectedFailures = 0;

	const first = await openChaoticStorage(path, {
		...options,
		fail: (operation) => operation === "mintId" && ++injectedFailures < 2,
	});
	{
		const session = createSession(first.storage, { documentRetentionMs: Number.POSITIVE_INFINITY });
		const committed = await session.commit(async (transaction) => {
			const conversation = await transaction.createConversation({ ownership: { kind: "ownerless" } });
			const entry = await transaction.appendEntry(conversation.id, {
				data: { reason: "restart-drill" },
				kind: restartDrillEntry.kind,
			});
			return { conversationId: conversation.id, entryId: entry.id };
		}, BACKGROUND_CONTEXT);
		conversationId = committed.conversationId;
		entryId = committed.entryId;
		committedBeforeRestart = true;
		await session.close(BACKGROUND_CONTEXT);
	}

	const second = await openChaoticStorage(path, options);
	{
		if (conversationId === undefined || entryId === undefined) {
			throw new Error("Restart drill did not persist a conversation");
		}
		const storage = second.storage;
		const conversation = await storage.conversation(conversationId, BACKGROUND_CONTEXT);
		const entry = await storage.entry(entryId, BACKGROUND_CONTEXT);
		return {
			committedBeforeRestart,
			conversationId,
			entryId,
			observedAfterRestart: conversation !== undefined && entry !== undefined,
		};
	}
}
