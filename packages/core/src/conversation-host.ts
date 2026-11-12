import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createRegistry,
	defineDocFamily,
	Harness,
	type ConversationId,
	type EntryRecord,
	type Harness as DurableHarness,
	type JsonObject,
} from "@earendil-works/pi-durable";
import {
	type ActivityAggregationPolicy,
	type ConversationPolicy,
	defaultConversationPolicy,
	durableDocumentKinds,
	type MessageEnvelope,
} from "@tsukaima/contracts";
import type { SqliteStorage } from "@tsukaima/durable";
import { createFakeModel, type ModelPort } from "./model.ts";
import { shouldCloseActivityWindow } from "./index.ts";

type StoredEnvelope = JsonObject & {
	readonly id: string;
	readonly source: JsonObject & { readonly timestampMs: number };
};

type ActivityWindowDocument = JsonObject & {
	closedAtMs: number | null;
	envelopes: StoredEnvelope[];
	openedAtMs: number;
	status: "collecting" | "submitted" | "closed";
};

type ActivityWindowSeed = JsonObject & {
	conversationId: number;
	envelopes: StoredEnvelope[];
	openedAtMs: number;
};

type StoredConversationPolicy = {
	enabled: boolean;
	followUpWhenBusy: "follow-up" | "reject";
	steerWhenBusy: "steer" | "follow-up" | "reject";
};

type MessageReceiptDocument = JsonObject & {
	activityId: string;
	acceptedAtMs: number;
	messageId: string;
};

type MessageReceiptSeed = JsonObject & {
	activityId: string;
	acceptedAtMs: number;
	messageId: string;
};

const conversationPolicyDefinition = {
	kind: durableDocumentKinds.activityPolicy,
	version: 1,
	family: true,
	scope: "conversation",
	fork: "current",
	history: "latest",
	checkpointWhen: () => true,
	initial: (seed: ConversationPolicy) => ({
		enabled: seed.enabled,
		followUpWhenBusy: seed.followUpWhenBusy,
		steerWhenBusy: seed.steerWhenBusy,
	}),
} as const;

const conversationPolicyDoc = defineDocFamily<StoredConversationPolicy, ConversationPolicy>(
	conversationPolicyDefinition,
);

const activityWindowDefinition = {
	kind: durableDocumentKinds.activityWindow,
	version: 1,
	family: true,
	scope: "conversation",
	fork: "current",
	history: "latest",
	checkpointWhen: () => true,
	initial: (seed: ActivityWindowSeed) => ({
		closedAtMs: null,
		envelopes: seed.envelopes,
		openedAtMs: seed.openedAtMs,
		status: "collecting" as const,
	}),
} as const;

const activityWindowDoc = defineDocFamily<ActivityWindowDocument, ActivityWindowSeed>(
	activityWindowDefinition,
);

const messageReceiptDefinition = {
	kind: "tsukaima.messageReceipt",
	version: 1,
	family: true,
	scope: "conversation",
	fork: "current",
	history: "latest",
	checkpointWhen: () => true,
	initial: (seed: MessageReceiptSeed) => ({
		activityId: seed.activityId,
		acceptedAtMs: seed.acceptedAtMs,
		messageId: seed.messageId,
	}),
} as const;

const messageReceiptDoc = defineDocFamily<MessageReceiptDocument, MessageReceiptSeed>(
	messageReceiptDefinition,
);

export type AppendConversationResult = {
	readonly activityId: string;
	readonly deduplicated: boolean;
	readonly messageId: string;
	readonly status: string;
};

export interface DurableConversationHostOptions {
	readonly model?: ModelPort;
	readonly policy?: ActivityAggregationPolicy;
	readonly storage: SqliteStorage;
}

export class PiDurableConversationHost {
	private harness?: DurableHarness;
	private readonly model: ModelPort;
	private readonly policy: ActivityAggregationPolicy;
	private readonly activityTimers = new Map<string, { timer: ReturnType<typeof setTimeout> }>();
	private readonly activityFlushes = new Set<string>();
	readonly registry = createRegistry();

	constructor(private readonly options: DurableConversationHostOptions) {
		this.model = options.model ?? createFakeModel();
		this.policy = options.policy ?? { maxMessages: 20, windowMs: 6_000 };
	}

	async createConversation(): Promise<string> {
		const harness = await this.openHarness();
		const conversation = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: { provider: this.model.providerId, modelId: this.model.modelId } },
			},
			BACKGROUND_CONTEXT,
		);
		return String(conversation.id);
	}

	async append(input: {
		conversationId: string;
		envelope: MessageEnvelope;
		forceSubmit?: boolean;
		submittedAtMs: number;
		whenBusy?: "steer" | "follow-up";
	}): Promise<AppendConversationResult> {
		const harness = await this.openHarness();
		const conversationId = Number(input.conversationId) as ConversationId;
		const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
		if (!conversation) throw new Error(`Conversation not found: ${input.conversationId}`);
		const existingReceipt = await harness.snapshot(
			messageReceiptDoc,
			conversationId,
			input.envelope.id,
			BACKGROUND_CONTEXT,
		);
		if (existingReceipt) {
			return {
				activityId: existingReceipt.activityId,
				deduplicated: true,
				messageId: existingReceipt.messageId,
				status: "duplicate",
			};
		}
		const policy = await this.readPolicy(conversationId);
		if (!policy.enabled) throw new Error(`Conversation disabled: ${input.conversationId}`);
		const activityId = `${conversationId}:activity`;
		const window = await harness.snapshot(
			activityWindowDoc,
			conversationId,
			activityId,
			BACKGROUND_CONTEXT,
		);
		const envelopes: StoredEnvelope[] = window?.envelopes ?? [];
		const shouldOpen = !window || window.status !== "collecting";
		const storedEnvelope = this.toStoredEnvelope(input.envelope);
		const nextEnvelopes = shouldOpen ? [storedEnvelope] : [...envelopes, storedEnvelope];
		const shouldSubmit =
			input.forceSubmit === true ||
			nextEnvelopes.length >= this.policy.maxMessages ||
			shouldCloseActivityWindow(
				nextEnvelopes[0]?.source.timestampMs ?? input.envelope.source.timestampMs,
				input.submittedAtMs,
				this.policy,
			);
		const whenBusy = input.whenBusy ?? (shouldSubmit ? policy.followUpWhenBusy : "follow-up");
		if (shouldSubmit) this.clearActivityTimer(input.conversationId);
		const submissionId = await conversation.commit(async (tx) => {
			const receipt = await tx.doc(messageReceiptDoc, conversationId, input.envelope.id, {
				activityId,
				acceptedAtMs: input.submittedAtMs,
				messageId: input.envelope.id,
			});
			receipt.activityId = activityId;
			receipt.acceptedAtMs = input.submittedAtMs;
			receipt.messageId = input.envelope.id;
			const document = await tx.doc(activityWindowDoc, conversationId, activityId, {
				conversationId,
				envelopes: nextEnvelopes,
				openedAtMs: input.submittedAtMs,
			});
			document.envelopes = nextEnvelopes;
			document.openedAtMs = shouldOpen ? input.submittedAtMs : window.openedAtMs;
			document.status = shouldSubmit ? "submitted" : "collecting";
			const entry = {
				kind: durableDocumentKinds.activityWindow,
				data: {
					activityId,
					envelopes: nextEnvelopes,
				},
			};
			return conversation.submit(
				tx,
				shouldSubmit
					? {
							type: "input",
							content: this.envelopeToText(input.envelope),
							entry,
							requestId: activityId,
							whenBusy: whenBusy === "follow-up" ? "followUp" : whenBusy,
						}
					: {
							type: "write",
							entry,
							requestId: `${activityId}:${input.envelope.id}`,
						},
			);
		}, BACKGROUND_CONTEXT);
		const submission = await harness.submission(submissionId, BACKGROUND_CONTEXT);
		const record = await submission?.status(BACKGROUND_CONTEXT);
		if (!shouldSubmit) {
			this.scheduleActivityFlush(input.conversationId);
		}
		return {
			activityId,
			deduplicated: false,
			messageId: input.envelope.id,
			status: record?.status ?? "unknown",
		};
	}

	private scheduleActivityFlush(conversationId: string, delayMs = this.policy.windowMs): void {
		this.clearActivityTimer(conversationId);
		const timer = setTimeout(() => {
			this.activityTimers.delete(conversationId);
			void this.flushActivity(conversationId).catch((error) => {
				console.error("Failed to flush activity window", error);
			});
		}, delayMs);
		this.activityTimers.set(conversationId, { timer });
	}

	private clearActivityTimer(conversationId: string): void {
		const scheduled = this.activityTimers.get(conversationId);
		if (scheduled === undefined) return;
		clearTimeout(scheduled.timer);
		this.activityTimers.delete(conversationId);
	}

	private async flushActivity(conversationId: string): Promise<void> {
		if (this.activityFlushes.has(conversationId)) return;
		this.activityFlushes.add(conversationId);
		try {
			const harness = await this.openHarness();
			const numericId = Number(conversationId) as ConversationId;
			const conversation = await harness.conversation(numericId, BACKGROUND_CONTEXT);
			if (!conversation) return;
			const activityId = `${numericId}:activity`;
			const window = await harness.snapshot(
				activityWindowDoc,
				numericId,
				activityId,
				BACKGROUND_CONTEXT,
			);
			if (!window || window.status !== "collecting" || window.envelopes.length === 0) {
				return;
			}
			const policy = await this.readPolicy(numericId);
			if (!policy.enabled) return;
			const envelopes = window.envelopes;
			await conversation.commit(async (tx) => {
				const document = await tx.doc(activityWindowDoc, numericId, activityId, {
					conversationId: numericId,
					envelopes,
					openedAtMs: window.openedAtMs,
				});
				document.envelopes = envelopes;
				document.status = "submitted";
				document.closedAtMs = Date.now();
				const entry = {
					kind: durableDocumentKinds.activityWindow,
					data: {
						activityId,
						envelopes,
					},
				};
				return conversation.submit(tx, {
					content: this.envelopesToText(envelopes),
					entry,
					requestId: activityId,
					type: "input",
					whenBusy: policy.followUpWhenBusy === "follow-up" ? "followUp" : "reject",
				});
			}, BACKGROUND_CONTEXT);
		} finally {
			this.activityFlushes.delete(conversationId);
		}
	}

	async listEntries(conversationId: string, limit = 500): Promise<EntryRecord[]> {
		const harness = await this.openHarness();
		const conversation = await harness.conversation(
			Number(conversationId) as ConversationId,
			BACKGROUND_CONTEXT,
		);
		if (!conversation) return [];
		const page = await conversation.entries(
			{ order: "descending" },
			Math.min(Math.max(limit, 1), 1_000),
			undefined,
			BACKGROUND_CONTEXT,
		);
		return [...page.items].toReversed();
	}

	async resumeActivityWindow(conversationId: string): Promise<void> {
		const harness = await this.openHarness();
		const numericId = Number(conversationId) as ConversationId;
		const window = await harness.snapshot(
			activityWindowDoc,
			numericId,
			`${numericId}:activity`,
			BACKGROUND_CONTEXT,
		);
		if (!window || window.status !== "collecting" || window.envelopes.length === 0) return;
		const latest = window.envelopes.at(-1)?.source.timestampMs ?? window.openedAtMs;
		const remainingMs = this.policy.windowMs - (Date.now() - latest);
		this.scheduleActivityFlush(conversationId, Math.max(0, remainingMs));
	}

	private async readPolicy(conversationId: ConversationId): Promise<ConversationPolicy> {
		const harness = await this.openHarness();
		const document = await harness.snapshot(
			conversationPolicyDoc,
			conversationId,
			"policy",
			BACKGROUND_CONTEXT,
		);
		if (!document) return defaultConversationPolicy;
		return {
			enabled: document.enabled,
			followUpWhenBusy: document.followUpWhenBusy,
			steerWhenBusy: document.steerWhenBusy,
		};
	}

	private envelopeToText(envelope: MessageEnvelope): string {
		return envelope.parts
			.map((part) => {
				if (part.type === "text") return part.text;
				return `[${part.type}]`;
			})
			.join(" ");
	}

	private envelopesToText(envelopes: readonly StoredEnvelope[]): string {
		const text = envelopes
			.map((envelope) => {
				const parts = Array.isArray(envelope.parts) ? envelope.parts : [];
				const content = parts
					.map((part) => {
						if (
							typeof part === "object" &&
							part !== null &&
							"type" in part &&
							part.type === "text" &&
							"text" in part &&
							typeof part.text === "string"
						) {
							return part.text;
						}
						return typeof part === "object" && part !== null && "type" in part
							? `[${String(part.type)}]`
							: "";
					})
					.filter(Boolean)
					.join(" ");
				const sender =
					typeof envelope.sender === "object" &&
					envelope.sender !== null &&
					"displayName" in envelope.sender &&
					typeof envelope.sender.displayName === "string"
						? envelope.sender.displayName
						: "Unknown";
				return `${sender}: ${content}`;
			})
			.join("\n");
		return envelopes.length === 1 ? text.replace(/^[^:]+:\s/, "") : text;
	}

	private toStoredEnvelope(envelope: MessageEnvelope): StoredEnvelope {
		return JSON.parse(JSON.stringify(envelope)) as StoredEnvelope;
	}

	private async openHarness(): Promise<DurableHarness> {
		if (this.harness) return this.harness;
		this.harness = await Harness.open(
			this.options.storage,
			{ models: this.model.models, registry: this.registry },
			BACKGROUND_CONTEXT,
		);
		return this.harness;
	}

	async close(): Promise<void> {
		for (const scheduled of this.activityTimers.values()) clearTimeout(scheduled.timer);
		this.activityTimers.clear();
		if (this.harness) await this.harness.close(BACKGROUND_CONTEXT);
	}
}
