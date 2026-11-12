import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createRegistry,
	defineDocFamily,
	Harness,
	type AgentChange,
	type Conversation,
	type ConversationId,
	type EntryRecord,
	type Extension,
	type Harness as DurableHarness,
	type JsonObject,
	type Submission,
} from "@earendil-works/pi-durable";
import {
	type ActivityAggregationPolicy,
	type ConversationPolicy,
	defaultConversationPolicy,
	durableDocumentKinds,
	type MessageEnvelope,
} from "@tsukaima/contracts";
import type { SqliteStorage } from "@tsukaima/durable";
import { createContextExtension, type ContextPromptProvider } from "./context.ts";
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

/**
 * One durable conversation has one activity document, but every submitted window is a
 * distinct input. `pi-durable` deduplicates submissions by `requestId`, so the request id
 * must change per window while the activity id stays stable for receipts and the UI.
 */
const ACTIVITY_REQUEST_SEPARATOR = "#";

export function activitySubmissionRequestId(activityId: string, envelopeId: string): string {
	return `${activityId}${ACTIVITY_REQUEST_SEPARATOR}${envelopeId}`;
}

export function activityIdFromSubmissionRequestId(requestId: string): string {
	const separator = requestId.lastIndexOf(ACTIVITY_REQUEST_SEPARATOR);
	return separator < 0 ? requestId : requestId.slice(0, separator);
}

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

/**
 * One settled assistant answer. Emitted by the host after an input run produced an
 * assistant entry, so the server can deliver it to the origin channel.
 */
export interface ConversationAnswer {
	/** Durable activity (submission request id) the answer belongs to. */
	readonly activityId: string;
	/** Durable conversation the answer was produced in. */
	readonly conversationId: string;
	/** Entry id of the assistant entry holding the answer text. */
	readonly entryId: string;
	/** Concatenated text blocks of the assistant answer. */
	readonly text: string;
}

/**
 * Activity-window transition for host consumers (the server forwards these to plugin
 * hooks). Ids use the durable conversation id space, matching `AdminEvent`.
 */
export interface ActivityWindowEvent {
	/** Durable activity id (`<conversationId>:activity`). */
	readonly activityId: string;
	/** Durable conversation the activity belongs to. */
	readonly conversationId: string;
	/** Envelopes in the window when the event fired. */
	readonly envelopeCount: number;
	readonly type: "opened" | "closed";
}

export interface DurableConversationHostOptions {
	/**
	 * Persona and memory prompt sections for every conversation. Sections render before each
	 * request; conversations that predate the extension are backfilled on their next append.
	 */
	readonly contextProvider?: ContextPromptProvider;
	/**
	 * Additional extensions (for example plugin tools) selected with every conversation.
	 * Existing conversations are backfilled on their next append when their stored agent does
	 * not already select them.
	 */
	readonly extensions?: readonly Extension[];
	readonly model?: ModelPort;
	/** Convenience for tests: deterministic fake-model replies, ignored when `model` is set. */
	readonly responses?: readonly string[];
	/** Observe activity-window opens and closes. Errors never affect message processing. */
	readonly onActivityEvent?: (event: ActivityWindowEvent) => void;
	/**
	 * Observe settled assistant answers. Called detached from `append()`/activity flush so a
	 * slow consumer never blocks ingestion; rejections are caught and logged, never surfaced.
	 */
	readonly onAnswer?: (answer: ConversationAnswer) => Promise<void> | void;
	readonly policy?: ActivityAggregationPolicy;
	readonly storage: SqliteStorage;
}

/**
 * Text of an assistant entry, mirroring what a channel reply needs. `undefined` for other
 * entry kinds or an answer with no text blocks.
 */
function assistantEntryText(entry: EntryRecord): string | undefined {
	if (entry.kind !== "pi.assistant" || entry.model === undefined) return undefined;
	const texts: string[] = [];
	for (const message of entry.model as readonly unknown[]) {
		if (typeof message !== "object" || message === null) continue;
		if (!("content" in message) || !Array.isArray(message.content)) continue;
		for (const block of message.content as readonly unknown[]) {
			if (typeof block !== "object" || block === null) continue;
			if (!("type" in block) || block.type !== "text") continue;
			if (!("text" in block) || typeof block.text !== "string") continue;
			texts.push(block.text);
		}
	}
	const text = texts.join("\n").trim();
	return text.length === 0 ? undefined : text;
}

export class PiDurableConversationHost {
	private harness?: DurableHarness;
	private readonly model: ModelPort;
	private readonly policy: ActivityAggregationPolicy;
	private readonly activityTimers = new Map<string, { timer: ReturnType<typeof setTimeout> }>();
	private readonly activityFlushes = new Set<string>();
	private readonly contextExtension: Extension | undefined;
	private readonly extensions = new Map<string, Extension>();
	private readonly dynamicExtensions = new Set<string>();
	private readonly extensionsEnsured = new Set<string>();
	private closed = false;
	readonly registry = createRegistry();

	constructor(private readonly options: DurableConversationHostOptions) {
		this.model =
			options.model ??
			createFakeModel(options.responses === undefined ? {} : { responses: options.responses });
		this.policy = options.policy ?? { maxMessages: 20, windowMs: 6_000 };
		this.contextExtension =
			options.contextProvider === undefined
				? undefined
				: createContextExtension(options.contextProvider);
		if (this.contextExtension !== undefined) {
			this.extensions.set(this.contextExtension.name, this.contextExtension);
			this.registry.install(this.contextExtension);
		}
		if (options.extensions !== undefined) this.installExtensions(options.extensions);
	}

	async createConversation(): Promise<string> {
		const harness = await this.openHarness();
		const extensions = [...this.extensions.values()];
		const agent: AgentChange = {
			model: { modelId: this.model.modelId, provider: this.model.providerId },
			...(extensions.length === 0 ? {} : { extensions: { add: extensions } }),
		};
		const conversation = await harness.createConversation(
			{
				agent,
				ownership: { kind: "ownerless" },
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
		await this.ensureExtensions(conversation, input.conversationId);
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
							requestId: activitySubmissionRequestId(activityId, input.envelope.id),
							whenBusy: whenBusy === "follow-up" ? "followUp" : whenBusy,
						}
					: {
							type: "write",
							entry,
							requestId: `${activityId}:${input.envelope.id}`,
						},
			);
		}, BACKGROUND_CONTEXT);
		if (shouldOpen) {
			this.emitActivityEvent({
				activityId,
				conversationId: input.conversationId,
				envelopeCount: nextEnvelopes.length,
				type: "opened",
			});
		}
		if (shouldSubmit) {
			this.emitActivityEvent({
				activityId,
				conversationId: input.conversationId,
				envelopeCount: nextEnvelopes.length,
				type: "closed",
			});
		}
		const submission = await harness.submission(submissionId, BACKGROUND_CONTEXT);
		const record = await submission?.status(BACKGROUND_CONTEXT);
		if (!shouldSubmit) {
			this.scheduleActivityFlush(input.conversationId);
		} else {
			this.observeAnswer(harness, input.conversationId, submission);
		}
		return {
			activityId,
			deduplicated: false,
			messageId: input.envelope.id,
			status: record?.status ?? "unknown",
		};
	}

	/**
	 * Watch one input submission to settlement and forward the assistant answer. Runs
	 * detached: `append()` and the activity flush return without waiting for the model run.
	 */
	private observeAnswer(
		harness: DurableHarness,
		conversationId: string,
		submission: Submission | undefined,
	): void {
		const onAnswer = this.options.onAnswer;
		if (onAnswer === undefined || submission === undefined) return;
		void (async () => {
			try {
				const settled = await submission.wait(BACKGROUND_CONTEXT);
				if (settled.type !== "input" || settled.status !== "done") return;
				const answerId = settled.answer;
				const entry = await harness.commit((tx) => tx.entry(answerId), BACKGROUND_CONTEXT);
				if (entry === undefined) return;
				const text = assistantEntryText(entry);
				if (text === undefined) return;
				await onAnswer({
					activityId: activityIdFromSubmissionRequestId(settled.requestId ?? ""),
					conversationId,
					entryId: String(answerId),
					text,
				});
			} catch (error) {
				if (this.closed) return;
				console.error("Failed to observe conversation answer", error);
			}
		})();
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
			await this.ensureExtensions(conversation, conversationId);
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
			const submissionId = await conversation.commit(async (tx) => {
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
					requestId: activitySubmissionRequestId(activityId, envelopes[0]?.id ?? "window"),
					type: "input",
					whenBusy: policy.followUpWhenBusy === "follow-up" ? "followUp" : "reject",
				});
			}, BACKGROUND_CONTEXT);
			this.emitActivityEvent({
				activityId,
				conversationId,
				envelopeCount: envelopes.length,
				type: "closed",
			});
			const submission = await harness.submission(submissionId, BACKGROUND_CONTEXT);
			this.observeAnswer(harness, conversationId, submission);
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

	/**
	 * Replace the host-installed dynamic extensions, leaving the context extension in place.
	 * Idempotent by extension name; existing conversations are checked again on their next
	 * append so an explicitly stored extension list gains the new extension.
	 */
	installExtensions(next: readonly Extension[]): void {
		const incoming = new Map(next.map((extension) => [extension.name, extension]));
		for (const name of this.dynamicExtensions) {
			if (incoming.has(name)) continue;
			const installed = this.extensions.get(name);
			if (installed !== undefined) {
				this.registry.uninstall(installed);
				this.extensions.delete(name);
				this.clearExtensionChecks(name);
			}
		}
		for (const [name, extension] of incoming) {
			if (name === this.contextExtension?.name) {
				throw new Error(`Extension ${name} is reserved by the conversation context`);
			}
			this.extensions.set(name, extension);
			this.registry.install(extension);
			this.clearExtensionChecks(name);
		}
		this.dynamicExtensions.clear();
		for (const name of incoming.keys()) this.dynamicExtensions.add(name);
	}

	/**
	 * Make sure every installed extension is selected by this conversation. New and default
	 * conversations resolve every installed extension automatically; this covers conversations
	 * whose stored selection explicitly lists extensions. Each extension is checked once per
	 * conversation per process, and failures only log: extensions must never block messages.
	 */
	private async ensureExtensions(conversation: Conversation, durableId: string): Promise<void> {
		for (const extension of this.extensions.values()) {
			const key = `${durableId}\0${extension.name}`;
			if (this.extensionsEnsured.has(key)) continue;
			try {
				const agent = await conversation.agent(BACKGROUND_CONTEXT);
				if (!agent.extensions.some((candidate) => candidate.name === extension.name)) {
					await conversation.configure({ extensions: { add: [extension] } }, BACKGROUND_CONTEXT);
				}
				this.extensionsEnsured.add(key);
			} catch (error) {
				console.error(`Failed to ensure conversation extension ${extension.name}`, error);
			}
		}
	}

	private clearExtensionChecks(name: string): void {
		const suffix = `\0${name}`;
		for (const key of this.extensionsEnsured) {
			if (key.endsWith(suffix)) this.extensionsEnsured.delete(key);
		}
	}

	private emitActivityEvent(event: ActivityWindowEvent): void {
		const callback = this.options.onActivityEvent;
		if (callback === undefined) return;
		try {
			callback(event);
		} catch (error) {
			console.error("Activity event callback failed", error);
		}
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
		this.closed = true;
		for (const scheduled of this.activityTimers.values()) clearTimeout(scheduled.timer);
		this.activityTimers.clear();
		if (this.harness) await this.harness.close(BACKGROUND_CONTEXT);
	}
}
