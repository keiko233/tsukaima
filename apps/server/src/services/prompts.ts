import { eq, inArray } from "drizzle-orm";
import { chatObjects, conversations, meta, type TsukaimaDatabase } from "@tsukaima/db";
import {
	promptKeySchema,
	type PersonaSummary,
	type PromptKey,
	type promptUpdateSchema,
} from "@tsukaima/contracts";
import type { AuditEntry } from "@tsukaima/sdk";
import type { z } from "zod";
import { DEFAULT_PROMPTS } from "./prompt-defaults.ts";

const AGENT_ACCESS_KEY = "prompt-agent-access";
const storageKey = (key: PromptKey) => `prompt-override:${key}`;

export class PromptConflictError extends Error {
	constructor() {
		super("The prompt changed. Reload it before saving.");
	}
}

export class PromptService {
	constructor(
		private readonly database: () => TsukaimaDatabase | undefined,
		private readonly audit: (entry: AuditEntry) => Promise<void>,
	) {}

	private db() {
		const database = this.database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}

	list() {
		const rows = new Map(
			this.db()
				.select()
				.from(meta)
				.where(inArray(meta.key, promptKeySchema.options.map(storageKey)))
				.all()
				.map(({ key, value }) => [key, value]),
		);
		return promptKeySchema.options.map((key) => ({
			defaultText: DEFAULT_PROMPTS[key],
			key,
			override: rows.get(storageKey(key)) ?? null,
		}));
	}

	render(key: PromptKey): Promise<string> {
		const row = this.database()
			?.select()
			.from(meta)
			.where(eq(meta.key, storageKey(key)))
			.get();
		return Promise.resolve(row?.value ?? DEFAULT_PROMPTS[key]);
	}

	async renderSystem(conversationId: string) {
		const session = this.session(conversationId);
		return session === undefined
			? undefined
			: this.render(session.kind === "workspace" ? "coding-system" : "chat-system");
	}

	async update(input: z.infer<typeof promptUpdateSchema>, actorKind: "user" | "agent") {
		const key = storageKey(input.key);
		this.db().transaction((tx) => {
			const row = tx.select().from(meta).where(eq(meta.key, key)).get();
			if ((row?.value ?? null) !== input.expectedOverride) throw new PromptConflictError();
			if (input.override === null) tx.delete(meta).where(eq(meta.key, key)).run();
			else
				tx.insert(meta)
					.values({ key, value: input.override })
					.onConflictDoUpdate({ target: meta.key, set: { value: input.override } })
					.run();
		});
		await this.audit({
			action: "prompt.update",
			actorKind,
			payload: { reset: input.override === null },
			result: "ok",
			targetId: input.key,
			targetKind: "prompt",
		});
		return { defaultText: DEFAULT_PROMPTS[input.key], key: input.key, override: input.override };
	}

	agentAccess() {
		return (
			this.db().select().from(meta).where(eq(meta.key, AGENT_ACCESS_KEY)).get()?.value === "true"
		);
	}

	async setAgentAccess(enabled: boolean) {
		const value = String(enabled);
		this.db()
			.insert(meta)
			.values({ key: AGENT_ACCESS_KEY, value })
			.onConflictDoUpdate({ target: meta.key, set: { value } })
			.run();
		await this.audit({
			action: "prompt.agent-access",
			actorKind: "user",
			payload: { enabled },
			result: "ok",
			targetKind: "prompt",
		});
		return enabled;
	}

	async auditPersona(persona: PersonaSummary, actorKind: "user" | "agent") {
		await this.audit({
			action: "persona.update-prompt",
			actorKind,
			payload: { version: persona.version },
			result: "ok",
			targetId: persona.id,
			targetKind: "persona",
		});
	}

	session(conversationId: string) {
		const row = this.database()
			?.select({
				id: conversations.id,
				chatKind: chatObjects.kind,
				sessionKind: conversations.kind,
			})
			.from(conversations)
			.leftJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
			.where(eq(conversations.durableConversationId, conversationId))
			.get();
		return row === undefined
			? undefined
			: {
					id: row.id,
					kind: row.chatKind ?? row.sessionKind,
				};
	}
}
