import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createRegistry,
	defineDocFamily,
	Harness,
	type ConversationId,
	type Harness as DurableHarness,
	type JsonObject,
} from "@earendil-works/pi-durable";
import {
	type ActivityAggregationPolicy,
	type ConversationPolicy,
	defaultConversationPolicy,
	durableDocumentKinds,
	type MessageEnvelope,
} from "@elaina/contracts";
import type { SqliteStorage } from "@elaina/durable";
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

export interface DurableConversationHostOptions {
	readonly model?: ModelPort;
	readonly policy?: ActivityAggregationPolicy;
	readonly storage: SqliteStorage;
}

export class PiDurableConversationHost {
	private harness?: DurableHarness;
	private readonly model: ModelPort;
	private readonly policy: ActivityAggregationPolicy;
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
		submittedAtMs: number;
		whenBusy?: "steer" | "follow-up";
	}): Promise<{
		readonly activityId: string;
		readonly messageId: string;
		readonly status: string;
	}> {
		const harness = await this.openHarness();
		const conversationId = Number(input.conversationId) as ConversationId;
		const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
		if (!conversation) throw new Error(`Conversation not found: ${input.conversationId}`);
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
			nextEnvelopes.length >= this.policy.maxMessages ||
			shouldCloseActivityWindow(
				nextEnvelopes[0]?.source.timestampMs ?? input.envelope.source.timestampMs,
				input.submittedAtMs,
				this.policy,
			);
		const whenBusy = input.whenBusy ?? (shouldSubmit ? policy.followUpWhenBusy : "follow-up");
		const submissionId = await conversation.commit(async (tx) => {
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
		return { activityId, messageId: input.envelope.id, status: record?.status ?? "unknown" };
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
		if (this.harness) await this.harness.close(BACKGROUND_CONTEXT);
	}
}
