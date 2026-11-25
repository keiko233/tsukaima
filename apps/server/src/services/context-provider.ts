import { and, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { compact, uniq } from "es-toolkit";
import {
	detectOverusedPhrases,
	detectRigidRhythm,
	formatLocalClock,
	formatLocalDateTime,
	LURK_MARKER,
	needsRepetitionRewrite,
	TURN_MEMORIES_KEY,
	type ChatCompactionRequest,
	type ContextPromptProvider,
	type TurnContextRequest,
	type TurnContextSection,
} from "@tsukaima/core";
import {
	SKILLS_TURN_CONTEXT_MAX_CHARS,
	type ConversationPolicy,
	type PersonaSummary,
	type WarmStatePayload,
} from "@tsukaima/contracts";
import {
	chatSnapshots,
	conversationMembers,
	conversations,
	memories,
	messages,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import type { Logger } from "../logging.ts";
import {
	ConversationPolicyService,
	DEFAULT_PERSONA_BEHAVIOR,
	type PersonaBehavior,
} from "./conversation-policy.ts";
import { queryCrossSession, renderCrossSession } from "./cross-session.ts";
import { renderWarmStateLines } from "./memory-consolidation.ts";
import { MemoryService, type RankedMemory } from "./memory-service.ts";
import { ADMIN_SETTINGS_TOOL_NAMES } from "./admin-settings-tools.ts";
import { detectQuietFeedback, isLowSubstanceReaction } from "./social-profile.ts";

/**
 * Persona character ceiling for the static system prefix. Personas are the single most
 * important part of a chat agent's voice, so the ceiling is generous and a truncation note
 * appears only when it is actually exceeded.
 */
export const DEFAULT_PERSONA_BUDGET_CHARS = 12_000;
/**
 * Character budget for the budgeted part of the ephemeral turn context (observation window and
 * recalled memories). Clock, prompt hooks, and the soft cue are budget-exempt core blocks.
 */
export const DEFAULT_TURN_BUDGET_CHARS = 6_000;
/** Messages in the recent chat window. */
const DEFAULT_OBSERVATION_LIMIT = 20;
const OBSERVATION_SNIPPET_LIMIT = 200;
/** Output budget of one chat compaction summary. */
const COMPACTION_MAX_TOKENS = 2_048;
const DEFAULT_MEMORY_TOP_K = 10;
/**
 * Number of latest messages used as the lexical recall query seed.
 */
const RECALL_QUERY_MESSAGE_LIMIT = 6;
const MEMORY_SNIPPET_LIMIT = 180;
const QA_SNIPPET_LIMIT = 200;
const PERSONA_TRUNCATION_NOTE = "[persona truncated to fit the context budget]";
const MEMORY_TRUNCATION_NOTE = "[memories truncated to fit the context budget]";
const WARM_HEADER = "Conversation state:";
const ADMIN_TOOL_NAMES = [
	"admin_exec",
	"admin_file_read",
	"admin_file_write",
	"admin_file_list",
	"skill_install",
	"skill_remove",
	"skill_rescan",
	"mcp_list",
	"mcp_install",
	"mcp_update",
	"mcp_toggle",
	"mcp_reconnect",
	"mcp_remove",
	"mcp_start_oauth",
	"mcp_complete_oauth",
	"mcp_clear_oauth",
	"workspace_spawn",
	"prompt_list",
	"prompt_update",
	"persona_prompt_update",
] as const;
const ADMIN_CAPABILITIES_TEXT = [
	"The current speaker is an authenticated administrator. Deferred administrator tools are available:",
	ADMIN_TOOL_NAMES.map((name) => `- ${name}`).join("\n"),
	`- Settings & config: ${ADMIN_SETTINGS_TOOL_NAMES.join(", ")}`,
	"Load the tool you need with tool_search first, then call it. Confirm destructive intent before running commands, writing files, installing skills or MCP servers, or spawning workspaces.",
].join("\n");
const QA_HEADER = "You answered similar questions here before; stay consistent:";
const LONG_TERM_HEADER = "Known memories, most relevant first:";
const OBSERVATION_HEADER = "Recent messages in this group, oldest first (you = your own messages):";
const CHAT_OBSERVATION_HEADER =
	"Recent messages in this chat, oldest first (you = your own messages):";
const SELF_LABEL = "(you)";
/** One canonical speaker of the current run, used for cross-session and consistency lookup. */
interface RunSpeaker {
	readonly name?: string;
	readonly userId: string;
}
interface RunSpeakers {
	readonly name: string | undefined;
	readonly speakers: readonly RunSpeaker[];
	readonly text: string;
	readonly userId: string | undefined;
}
const STICKER_HINTS_HEADER =
	"Sticker captions you can send (call sticker-meme.send with query or emotion when one fits; never write sticker markers in your reply):";
const STICKER_HINT_MAX_ITEMS = 3;
const STICKER_CAPTION_MAX_CHARS = 32;
const STICKER_PROMPT_MAX_CHARS = 1_000;
/** Ephemeral nudge for when a chat turn may speak mid-turn instead of waiting silently. */
const LIVE_REPLY_GUIDE =
	"While working, you may send one short natural line before a slow or external tool call. Stay silent for background memory, sticker lookup, and todo tools, and never repeat a mid-turn line in the final reply.";

/** One host-model completion for chat compaction, on the conversation's own model. */
export interface ContextCompletionRequest {
	readonly maxTokens: number;
	readonly model?: { readonly modelId: string; readonly providerId: string };
	readonly prompt: string;
	readonly signal?: AbortSignal;
	readonly system: string;
}

/**
 * Resolves the persona and memory text for one durable conversation and keeps it inside a
 * character budget. Every failure degrades to `undefined` (the section is omitted) — prompt
 * rendering must never break a model run — and memory content is never written to logs.
 *
 * Memory retrieval is tiered: the merged structured warm state written by background
 * consolidation (`kind = 'summary'`), then hybrid-ranked long-term memories. Recent messages
 * only seed the recall query. Conversation policy gates recall and prevents private/group
 * scope leakage.
 */
export interface DrizzleContextProviderOptions {
	readonly renderSystem?: (conversationId: string) => Promise<string | undefined>;
	/** Shared prompt text (Settings -> Prompts); required for chat-native compaction. */
	readonly renderPrompt?: (key: "chat-compaction") => Promise<string>;
	/** Host model completion; required for chat-native compaction. */
	readonly completeText?: (request: ContextCompletionRequest) => Promise<string | undefined>;
	readonly database: () => TsukaimaDatabase | undefined;
	readonly logger: Logger;
	/** Persona ceiling in characters; defaults to {@link DEFAULT_PERSONA_BUDGET_CHARS}. */
	readonly personaBudgetChars?: number;
	/** Turn-context budget in characters; defaults to {@link DEFAULT_TURN_BUDGET_CHARS}. */
	readonly turnBudgetChars?: number;
	/**
	 * @deprecated Pre-Batch-1 memory budget override, kept for existing tests. It now sets the
	 * memory budget used by {@link DrizzleContextProvider.renderMemories} only.
	 */
	readonly budgetChars?: number;
	/** Ambient observation window size; mainly for tests. */
	readonly observationLimit?: number;
	/** IANA zone for clock labels; defaults to the host process zone. */
	readonly timeZone?: string;
	/** Maximum memories injected per request; mainly for tests. */
	readonly memoryTopK?: number;
	/** Shared policy resolution; a database-backed service is created when omitted. */
	readonly policyService?: ConversationPolicyService;
	/** Shared memory service (hybrid recall, warm state); created internally when omitted. */
	readonly memoryService?: MemoryService;
	/** Optional bounded sticker captions for the ephemeral turn context. */
	readonly stickerCaptions?: () => Promise<readonly string[] | undefined>;
	/** Optional bounded sticker hints (packs + captions) for the ephemeral turn context. */
	readonly stickerHints?: () => Promise<StickerHintsPayload | undefined>;
	/** Optional pre-rendered Agent Skills catalog for the turn's execution surface and caller role. */
	readonly skillCatalog?: (
		surface: "chat" | "workspace",
		isAdmin: boolean,
	) => Promise<string | undefined>;
	/** Fail-closed check for an authenticated administrator speaker on this turn. */
	readonly resolveAdminCaller?: (conversationId: string) => Promise<boolean>;
}

export interface StickerHintsPayload {
	readonly captions?: readonly string[];
	readonly packs?: readonly { readonly itemCount: number; readonly name: string }[];
	readonly prompt?: string;
}

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

function truncateChars(text: string, max: number, note: string): string {
	if (text.length <= max) return text;
	const suffix = `\n${note}`;
	if (suffix.length >= max) return suffix.slice(0, max);
	return `${text.slice(0, max - suffix.length)}${suffix}`;
}

function personaText(persona: {
	readonly name: string;
	readonly prompt: string;
	readonly summary: string;
}): string | undefined {
	const prompt = persona.prompt.trim();
	if (prompt.length > 0) return prompt;
	const summary = persona.summary.trim();
	if (summary.length > 0) return `${persona.name}: ${summary}`;
	return persona.name.trim().length > 0 ? persona.name.trim() : undefined;
}

function snippet(text: string, limit: number): string {
	return text.replace(/\s+/gu, " ").trim().slice(0, limit);
}

/** Raw notice metadata identifies a poke addressed to the bot. */
function isSelfPokeNotice(rawRefJson: string | null): boolean {
	if (rawRefJson === null) return false;
	try {
		const parsed: unknown = JSON.parse(rawRefJson);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
		const notice = parsed as { isSelfTarget?: unknown; noticeType?: unknown };
		return notice.noticeType === "poke" && notice.isSelfTarget === true;
	} catch {
		return false;
	}
}

function observationSpeaker(displayName: string | null, platformId: string | null): string {
	const id = platformId?.trim();
	const name = displayName?.trim() || id || "Unknown";
	return id === undefined || id.length === 0 || id === name ? name : `${name}(${id})`;
}

function combine(conditions: readonly (SQL | undefined)[]): SQL {
	const filtered = conditions.filter((condition): condition is SQL => condition !== undefined);
	if (filtered.length === 0) return sql`1 = 1`;
	return and(...filtered) ?? sql`1 = 1`;
}

export interface ContextMemoryInspectionItem {
	readonly id: string | null;
	readonly kind: string;
	readonly scope: string;
	readonly summary: string;
	readonly tier: "recent" | "warm" | "long-term";
}

export interface ContextInspectionDetails {
	readonly memories: {
		readonly enabled: boolean;
		readonly items: ContextMemoryInspectionItem[];
		readonly recentCount: number;
		readonly warmTopics: string[];
	};
	readonly personaName: string | null;
}

export class DrizzleContextProvider implements ContextPromptProvider {
	readonly refreshTurnContext = true;
	readonly #completeText: DrizzleContextProviderOptions["completeText"];
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #logger: Logger;
	readonly #memoryBudget: number;
	readonly #memoryService: MemoryService;
	readonly #memoryTopK: number;
	readonly #observationLimit: number;
	readonly #personaBudget: number;
	readonly #policyService: ConversationPolicyService;
	readonly #renderPrompt: DrizzleContextProviderOptions["renderPrompt"];
	readonly #renderSystem: DrizzleContextProviderOptions["renderSystem"];
	readonly #skillCatalog: DrizzleContextProviderOptions["skillCatalog"];
	readonly #resolveAdminCaller: DrizzleContextProviderOptions["resolveAdminCaller"];
	readonly #stickerCaptions: DrizzleContextProviderOptions["stickerCaptions"];
	readonly #stickerHints: DrizzleContextProviderOptions["stickerHints"];
	readonly #timeZone: string | undefined;
	readonly #turnBudget: number;

	constructor(options: DrizzleContextProviderOptions) {
		this.#renderSystem = options.renderSystem;
		this.#skillCatalog = options.skillCatalog;
		this.#resolveAdminCaller = options.resolveAdminCaller;
		this.#renderPrompt = options.renderPrompt;
		this.#stickerCaptions = options.stickerCaptions;
		this.#stickerHints = options.stickerHints;
		this.#completeText = options.completeText;
		this.#database = options.database;
		this.#logger = options.logger.child("tsukaima::server::context");
		this.#personaBudget = options.personaBudgetChars ?? DEFAULT_PERSONA_BUDGET_CHARS;
		this.#turnBudget = options.turnBudgetChars ?? DEFAULT_TURN_BUDGET_CHARS;
		this.#memoryBudget = options.budgetChars ?? this.#turnBudget;
		this.#memoryTopK = options.memoryTopK ?? DEFAULT_MEMORY_TOP_K;
		this.#observationLimit = options.observationLimit ?? DEFAULT_OBSERVATION_LIMIT;
		this.#timeZone = options.timeZone;
		this.#policyService =
			options.policyService ??
			new ConversationPolicyService({
				database: options.database,
				host: () => undefined,
				logger: options.logger,
			});
		this.#memoryService =
			options.memoryService ??
			new MemoryService({
				database: options.database,
				logger: options.logger,
				policyService: this.#policyService,
			});
	}

	/**
	 * Shared base prompt (`chat-system` / `coding-system`). A chat persona marked `complete` is a
	 * full system prompt of its own, so the shared chat base is omitted for it.
	 */
	async renderSystem(durableConversationId: string): Promise<string | undefined> {
		const render = this.#renderSystem;
		if (render === undefined) return undefined;
		try {
			const profile = await this.#personaProfile(durableConversationId);
			if (profile?.behavior.complete) {
				return undefined;
			}
			return await render(durableConversationId);
		} catch (error) {
			this.#logger.warn("system prompt unavailable", { error: errorMessage(error) });
			return undefined;
		}
	}

	async renderPersona(durableConversationId: string): Promise<string | undefined> {
		try {
			const profile = await this.#personaProfile(durableConversationId);
			if (profile === undefined) return undefined;
			const text = personaText(profile.persona);
			if (text === undefined) return undefined;
			const rendered = truncateChars(text, this.#personaBudget, PERSONA_TRUNCATION_NOTE);
			this.#logger.debug("rendered persona context", {
				durableConversationId,
				personaName: profile.persona.name,
				renderedChars: rendered.length,
				truncated: rendered.length < text.length,
			});
			return rendered;
		} catch (error) {
			this.#logger.warn("persona context unavailable", { error: errorMessage(error) });
			return undefined;
		}
	}

	/**
	 * Static, model-actionable chat behavior rules. Transport settings (pacing, cooldowns,
	 * markdown stripping, access modes, wake keywords) are enforced by the runtime and never
	 * shown to the model. The text depends only on persona and chat kind, so it stays
	 * byte-stable across turns. Workspace sessions get their rules from the coding prompt.
	 */
	async renderPolicy(durableConversationId: string): Promise<string | undefined> {
		try {
			const database = this.#database();
			if (database === undefined) return undefined;
			const session = await this.#resolveSession(database, durableConversationId);
			if (session === undefined || session.chatKind === "workspace") return undefined;
			const [policy, persona] = await Promise.all([
				this.#policyService.effectivePolicy(session.sessionId),
				this.#policyService.personaForSession({ ...session, conversationId: session.sessionId }),
			]);
			const lines: string[] = [];
			if (persona !== undefined) lines.push(`- You are ${persona.name}; stay in character.`);
			const aliases = uniq([...policy.trigger.selfAliases, ...(persona?.selfAliases ?? [])]);
			if (aliases.length > 0) lines.push(`- People may also call you: ${aliases.join(", ")}.`);
			if (session.chatKind === "group") {
				lines.push(
					"- This is a group chat. Keep track of who is talking to whom; not every message is meant for you.",
					"- Join in only when you are addressed or genuinely have something natural to add; never force a reply or awkwardly chime in when you cannot connect to the topic or when the exchange has naturally ended.",
					"- You can self-adjust your chat rhythm and quietness for this conversation with chat_settings_adjust, and leave durable context notes for upcoming turns with chat_context_note, whenever someone asks you to talk less, quiet down, or follow a room preference. Never mention these tools in chat.",
				);
			} else if (session.chatKind === "private") {
				lines.push(
					"- This is a private one-on-one chat.",
					"- You can adjust your own chat rhythm and quietness for this conversation with chat_settings_adjust or leave context notes for upcoming turns with chat_context_note when helpful, without mentioning these tools in chat.",
				);
			}
			lines.push("- Every line break in your reply is sent as a separate chat message.");
			if (policy.memoryEnabled) {
				lines.push(
					"- Proactively use memory tools without mentioning them: save durable facts, preferences, people, glossary/memes, and commitments; recall when needed; update or forget records with [id:...]. Never mention memory tools or internals in chat.",
				);
			}
			const rendered = lines.join("\n");
			this.#logger.debug("rendered policy context", {
				aliasCount: aliases.length,
				durableConversationId,
				renderedChars: rendered.length,
				sessionId: session.sessionId,
			});
			return rendered;
		} catch (error) {
			this.#logger.warn("policy context unavailable", { error: errorMessage(error) });
			return undefined;
		}
	}

	/**
	 * Ephemeral per-run context. Clock, prompt hooks, and the soft cue are budget-exempt; the
	 * observation window takes the turn budget first and recalled memories use what remains.
	 * Every section degrades independently. Must stay read-only: prompt hooks were already
	 * consumed at admission and arrive through `request.triggers`.
	 */
	async renderTurnContext(request: TurnContextRequest): Promise<readonly TurnContextSection[]> {
		const database = this.#database();
		if (database === undefined) return [];
		let session: { chatKind: string; chatObjectId: string | null; sessionId: string } | undefined;
		let behavior: PersonaBehavior = DEFAULT_PERSONA_BEHAVIOR;
		try {
			session = await this.#resolveSession(database, request.conversationId);
			behavior = (await this.#personaProfile(request.conversationId))?.behavior ?? behavior;
		} catch (error) {
			this.#logger.warn("turn context session unavailable", { error: errorMessage(error) });
		}
		const chat = session !== undefined && session.chatKind !== "workspace";
		const chatHistory =
			session?.chatKind === "group" ||
			session?.chatKind === "private" ||
			session?.chatKind === "webui";

		const clock =
			chat && behavior.includeRuntimeContext
				? `Local time: ${formatLocalDateTime(request.nowMs, this.#timeZoneOptions())}`
				: undefined;
		let isAdminCaller = session?.chatKind === "workspace";
		let adminCapabilities: string | undefined;
		if (chat && this.#resolveAdminCaller !== undefined) {
			try {
				if (await this.#resolveAdminCaller(request.conversationId)) {
					isAdminCaller = true;
					adminCapabilities = ADMIN_CAPABILITIES_TEXT;
				}
			} catch (error) {
				this.#logger.warn("admin caller check unavailable", { error: errorMessage(error) });
			}
		}
		const hooks = compact(
			uniq(
				request.triggers
					.map((trigger) => trigger.promptHooks?.trim())
					.filter((value): value is string => value !== undefined && value.length > 0),
			),
		).join("\n\n");
		// A run is soft only when none of its inputs addressed the assistant directly.
		const soft =
			request.triggers.length > 0 &&
			request.triggers.every((trigger) => trigger.classification === "soft");
		const cue = soft
			? request.triggers.findLast((trigger) => trigger.cue !== undefined)?.cue
			: undefined;

		let remaining = this.#turnBudget;
		let observation: string | undefined;
		if (chatHistory && session !== undefined) {
			try {
				const ownInputs = new Set<string>();
				for (const input of request.inputs ?? []) {
					if (input.envelopeId !== undefined) ownInputs.add(input.envelopeId);
					if (input.platformMessageId !== undefined) ownInputs.add(input.platformMessageId);
				}
				observation = await this.#observationWindow(
					database,
					session,
					Math.floor(remaining * 0.75),
					ownInputs,
				);
				remaining -= observation?.length ?? 0;
			} catch (error) {
				this.#logger.warn("observation window unavailable", { error: errorMessage(error) });
			}
		}
		let speaker: RunSpeakers | undefined;
		if (chat && session !== undefined) {
			try {
				speaker = await this.#currentSpeaker(database, session.sessionId, request);
			} catch (error) {
				this.#logger.warn("current speaker unavailable", { error: errorMessage(error) });
			}
		}
		let recalled: string | undefined;
		if (chat && session !== undefined && remaining > 0) {
			try {
				const collected = await this.#collectMemories(
					request.conversationId,
					session,
					request.inputs,
				);
				if (collected !== undefined && collected.enabled) {
					recalled = this.#format(
						{ ranked: collected.longTerm, warm: collected.warm?.state },
						remaining,
						speaker?.speakers.flatMap((entry) =>
							entry.name === undefined ? [entry.userId] : [entry.userId, entry.name],
						) ?? [],
					);
					remaining -= recalled?.length ?? 0;
				}
			} catch (error) {
				this.#logger.warn("memory context unavailable", { error: errorMessage(error) });
			}
		}
		let stickerHints: string | undefined;
		if (chat && (this.#stickerHints !== undefined || this.#stickerCaptions !== undefined)) {
			try {
				let hintsPayload: StickerHintsPayload | undefined;
				if (this.#stickerHints !== undefined) {
					hintsPayload = await this.#stickerHints();
				} else if (this.#stickerCaptions !== undefined && remaining > 0) {
					const captions = await this.#stickerCaptions();
					hintsPayload = captions === undefined ? undefined : { captions };
				}
				const promptText =
					typeof hintsPayload?.prompt === "string"
						? hintsPayload.prompt.trim().slice(0, STICKER_PROMPT_MAX_CHARS)
						: "";
				let detailText: string | undefined;
				if (remaining > 0) {
					const captions = hintsPayload?.captions;
					const packs = hintsPayload?.packs;
					const cleanedCaptions = [
						...new Set(
							(captions ?? [])
								.map((caption) =>
									caption
										.replace(/[\][\r\n]+/gu, " ")
										.trim()
										.slice(0, STICKER_CAPTION_MAX_CHARS),
								)
								.filter((caption) => caption.length > 0),
						),
					].slice(0, STICKER_HINT_MAX_ITEMS);

					const packOverview =
						packs !== undefined && packs.length > 0
							? `Available sticker packs: ${packs.map((pack) => `${pack.name} (${pack.itemCount})`).join(", ")}`
							: undefined;

					const lines: string[] = [];
					if (packOverview !== undefined) {
						lines.push(packOverview);
					}
					if (cleanedCaptions.length > 0) {
						lines.push(STICKER_HINTS_HEADER, ...cleanedCaptions.map((caption) => `- ${caption}`));
					}
					if (lines.length > 0) {
						const text = lines.join("\n");
						if (text.length <= remaining) {
							detailText = text;
							remaining -= text.length;
						} else if (packOverview !== undefined && packOverview.length <= remaining) {
							detailText = packOverview;
							remaining -= packOverview.length;
						}
					}
				}
				const sectionLines = [
					...(promptText.length > 0 ? [promptText] : []),
					...(detailText === undefined ? [] : [detailText]),
				];
				if (sectionLines.length > 0) {
					stickerHints = sectionLines.join("\n");
				}
			} catch (error) {
				this.#logger.debug("sticker captions unavailable", { error: errorMessage(error) });
			}
		}

		let skillCatalog: string | undefined;
		if (this.#skillCatalog !== undefined) {
			try {
				const surface = session?.chatKind === "workspace" ? "workspace" : "chat";
				const rendered = await this.#skillCatalog(surface, isAdminCaller);
				if (rendered !== undefined && rendered.trim().length > 0) {
					skillCatalog =
						rendered.length > SKILLS_TURN_CONTEXT_MAX_CHARS
							? rendered.slice(0, SKILLS_TURN_CONTEXT_MAX_CHARS)
							: rendered;
				}
			} catch (error) {
				this.#logger.debug("skill catalog unavailable", { error: errorMessage(error) });
			}
		}

		let crossSession: string | undefined;
		let consistency: string | undefined;
		let styleAvoid: string | undefined;
		let rhythmNudge: string | undefined;
		let participation: string | undefined;
		if (chat && session !== undefined) {
			try {
				const policy = await this.#policyService.effectivePolicy(session.sessionId);
				participation = await this.#renderParticipationGuidance(
					database,
					session,
					policy,
					request,
					soft,
				);
				if (speaker !== undefined && remaining > 0 && policy.memoryEnabled) {
					crossSession = await this.#crossSession(
						database,
						session,
						policy,
						speaker,
						request.nowMs,
						remaining,
					);
					remaining -= crossSession?.length ?? 0;
					if (policy.memoryConsolidation.qaRecallEnabled && remaining > 0) {
						consistency = await this.#qaConsistency(session.sessionId, speaker.text, remaining);
					}
				}
				if (policy.humanization.antiRepetitionEnabled || policy.humanization.rhythmVarietyEnabled) {
					const replyWindow = Math.max(
						policy.humanization.antiRepetitionWindow,
						policy.humanization.rhythmWindow,
					);
					const botReplies = await this.#recentOutboundReplies(
						database,
						session.sessionId,
						replyWindow,
					);
					if (policy.humanization.antiRepetitionEnabled) {
						const report = detectOverusedPhrases(
							botReplies.slice(-policy.humanization.antiRepetitionWindow),
							{ threshold: policy.humanization.antiRepetitionThreshold },
						);
						styleAvoid = report.avoidListText;
					}
					if (policy.humanization.rhythmVarietyEnabled) {
						const rhythm = detectRigidRhythm(botReplies, {
							window: policy.humanization.rhythmWindow,
						});
						rhythmNudge = rhythm.nudgeText;
					}
				}
			} catch (error) {
				this.#logger.warn("turn enrichment context unavailable", { error: errorMessage(error) });
			}
		}

		const sections: TurnContextSection[] = [];
		const push = (key: string, text: string | undefined) => {
			if (text !== undefined && text.trim().length > 0) sections.push({ key, text });
		};
		push("clock", clock);
		push("observation", observation);
		push(TURN_MEMORIES_KEY, recalled);
		push("cross-session", crossSession);
		push("consistency", consistency);
		push("style-avoid", styleAvoid);
		push("rhythm-nudge", rhythmNudge);
		push("stickers", stickerHints);
		push("skills", skillCatalog);
		// Budget-exempt: the administrator needs the deferred tool list even in a tight turn.
		push("admin-capabilities", adminCapabilities);
		if (chat) push("live-replies", LIVE_REPLY_GUIDE);
		push("participation", participation);
		push("prompt-hooks", hooks);
		push("cue", cue);
		this.#logger.debug("rendered turn context", {
			durableConversationId: request.conversationId,
			keys: sections.map((entry) => entry.key).join(","),
			renderedChars: sections.reduce((sum, entry) => sum + entry.text.length, 0),
			triggerCount: request.triggers.length,
		});
		return sections;
	}

	/**
	 * Chat-native compaction summary on the conversation's own model and the editable
	 * `chat-compaction` prompt. Workspace sessions return `undefined` so pi-durable keeps its
	 * coding summary format.
	 */
	async summarizeCompaction(request: ChatCompactionRequest): Promise<string | undefined> {
		if (this.#completeText === undefined || this.#renderPrompt === undefined) return undefined;
		const database = this.#database();
		if (database === undefined) return undefined;
		const session = await this.#resolveSession(database, request.conversationId);
		if (session === undefined || session.chatKind === "workspace") return undefined;
		if (request.transcript.trim().length === 0) return undefined;
		const system = (await this.#renderPrompt("chat-compaction")).trim();
		if (system.length === 0) return undefined;
		const extra = request.instructions?.trim();
		const previousSummary = request.previousSummary?.trim();
		const prompt = [
			...(previousSummary === undefined || previousSummary.length === 0
				? []
				: [
						"Earlier summary to carry forward (preserve still-relevant facts and fold in the new messages):",
						"<previous-summary>",
						previousSummary,
						"</previous-summary>",
						"",
					]),
			"<chat-transcript>",
			request.transcript,
			"</chat-transcript>",
			...(extra === undefined || extra.length === 0 ? [] : ["", "Additional instructions:", extra]),
		].join("\n");
		const summary = await this.#completeText({
			maxTokens: COMPACTION_MAX_TOKENS,
			prompt,
			system,
			...(request.model === undefined ? {} : { model: request.model }),
			...(request.signal === undefined ? {} : { signal: request.signal }),
		});
		const trimmed = summary?.trim();
		if (trimmed === undefined || trimmed.length === 0) {
			// An empty result is a failed chat summary, not a reason to emit a coding checklist.
			throw new Error("Chat compaction returned an empty summary");
		}
		this.#logger.debug("chat compaction summarized", {
			durableConversationId: request.conversationId,
			hadPreviousSummary: previousSummary !== undefined && previousSummary.length > 0,
			reason: request.reason,
			summaryChars: trimmed.length,
			transcriptChars: request.transcript.length,
		});
		return trimmed;
	}

	/** Ordinary chat surfaces never fall back to the coding compaction format. */
	async isChatConversation(durableConversationId: string): Promise<boolean> {
		const database = this.#database();
		if (database === undefined) return false;
		try {
			const session = await this.#resolveSession(database, durableConversationId);
			return session !== undefined && session.chatKind !== "workspace";
		} catch (error) {
			this.#logger.warn("conversation kind unavailable", { error: errorMessage(error) });
			return false;
		}
	}

	async renderMemories(durableConversationId: string): Promise<string | undefined> {
		try {
			const collected = await this.#collectMemories(durableConversationId);
			if (collected === undefined || !collected.enabled) {
				this.#logger.debug("memory context skipped", {
					durableConversationId,
					enabled: collected?.enabled ?? false,
				});
				return undefined;
			}
			const rendered = this.#format(
				{ ranked: collected.longTerm, warm: collected.warm?.state },
				this.#memoryBudget,
			);
			this.#logger.debug("rendered memory context", {
				durableConversationId,
				hasWarm: collected.warm !== undefined,
				longTermCount: collected.longTerm.length,
				recentCount: collected.recent.length,
				renderedChars: rendered?.length ?? 0,
			});
			return rendered;
		} catch (error) {
			this.#logger.warn("memory context unavailable", { error: errorMessage(error) });
			return undefined;
		}
	}

	/**
	 * Read-only inspection of the persona binding and memory recall tiers for a durable
	 * conversation, matching the exact filters used by {@link renderPersona} and {@link renderMemories}.
	 */
	async inspectContext(durableConversationId: string): Promise<ContextInspectionDetails> {
		const empty: ContextInspectionDetails = {
			memories: { enabled: false, items: [], recentCount: 0, warmTopics: [] },
			personaName: null,
		};
		try {
			const database = this.#database();
			if (database === undefined) return empty;
			const session = await this.#resolveSession(database, durableConversationId);
			if (session?.chatKind === "workspace") return empty;
			const persona =
				session === undefined
					? undefined
					: await this.#policyService.personaForSession({
							...session,
							conversationId: session.sessionId,
						});
			const personaName = persona?.name ?? null;
			const collected = await this.#collectMemories(durableConversationId, session);
			if (collected === undefined || !collected.enabled) {
				return {
					memories: { enabled: false, items: [], recentCount: 0, warmTopics: [] },
					personaName,
				};
			}

			const warmTopics = collected.warm?.state?.topics ?? [];

			const items: ContextMemoryInspectionItem[] = [];
			if (collected.warm !== undefined) {
				const warmSummary =
					collected.warm.memory.summary.trim() ||
					collected.warm.memory.content.trim() ||
					warmTopics.join(", ");
				if (warmSummary.length > 0) {
					items.push({
						id: collected.warm.memory.id,
						kind: collected.warm.memory.kind,
						scope: collected.warm.memory.scope,
						summary: warmSummary.replace(/\s+/gu, " ").slice(0, MEMORY_SNIPPET_LIMIT),
						tier: "warm",
					});
				}
			}
			for (const entry of collected.longTerm.slice(0, this.#memoryTopK)) {
				const summary = (entry.memory.summary.trim() || entry.memory.content.trim())
					.replace(/\s+/gu, " ")
					.slice(0, MEMORY_SNIPPET_LIMIT);
				if (summary.length === 0) continue;
				items.push({
					id: entry.memory.id,
					kind: entry.memory.kind,
					scope: entry.memory.scope,
					summary,
					tier: "long-term",
				});
			}
			const nonEmptyRecent = collected.recent.filter(
				(row) => (row.contentText ?? "").trim().length > 0,
			);
			// Recent messages only seed the recall query; they are no longer an injected tier.

			return {
				memories: {
					enabled: true,
					items,
					recentCount: nonEmptyRecent.length,
					warmTopics,
				},
				personaName,
			};
		} catch (error) {
			this.#logger.warn("context inspection unavailable", { error: errorMessage(error) });
			return empty;
		}
	}

	#timeZoneOptions() {
		return this.#timeZone === undefined ? {} : { timeZone: this.#timeZone };
	}

	async #personaProfile(durableConversationId: string): Promise<
		| {
				readonly behavior: PersonaBehavior;
				readonly persona: PersonaSummary;
		  }
		| undefined
	> {
		const database = this.#database();
		if (database === undefined) return undefined;
		const session = await this.#resolveSession(database, durableConversationId);
		if (session === undefined || session.chatKind === "workspace") return undefined;
		return this.#policyService.personaProfileForSession({
			...session,
			conversationId: session.sessionId,
		});
	}

	/**
	 * Named, timestamped window of the latest chat messages (ambient included), newest lines
	 * kept first when the budget runs out. The assistant's own messages carry a self marker, and
	 * the run's own newly submitted inputs are filtered so the model never sees them twice.
	 */
	async #observationWindow(
		database: TsukaimaDatabase,
		session: { chatKind: string; sessionId: string },
		budget: number,
		excludeIds: ReadonlySet<string>,
	): Promise<string | undefined> {
		const rows = await this.#recentMessages(
			database,
			session.sessionId,
			this.#observationLimit + excludeIds.size,
		);
		const group = session.chatKind === "group";
		const header = group ? OBSERVATION_HEADER : CHAT_OBSERVATION_HEADER;
		let observePokes = false;
		try {
			observePokes =
				group && (await this.#policyService.effectivePolicy(session.sessionId)).notices.pokeObserve;
		} catch {}
		const visible = rows
			.filter((row) => {
				if (excludeIds.size > 0) {
					if (row.id.length > 0 && excludeIds.has(row.id)) return false;
					if (row.platformMessageId !== null && excludeIds.has(row.platformMessageId)) {
						return false;
					}
				}
				if (row.direction !== "system") return true;
				// A self-poke is the only system notice the model may observe, and only while the
				// conversation policy enables poke observation.
				return observePokes && row.kind === "notice" && isSelfPokeNotice(row.rawRefJson);
			})
			.slice(-this.#observationLimit);
		const lines: string[] = [];
		let used = header.length + 1;
		for (const row of visible.toReversed()) {
			const text = snippet(row.contentText ?? "", OBSERVATION_SNIPPET_LIMIT);
			if (text.length === 0) continue;
			const at = Date.parse(row.occurredAt);
			const clock = Number.isFinite(at)
				? `[${formatLocalClock(at, this.#timeZoneOptions())}] `
				: "";
			const speaker =
				row.direction === "outbound" && row.senderExternalId !== "webui-admin"
					? SELF_LABEL
					: observationSpeaker(row.senderDisplayName, row.senderExternalId ?? row.senderUserId);
			const msgRef =
				row.direction === "inbound" &&
				row.platformMessageId !== null &&
				row.platformMessageId.trim().length > 0
					? ` [msg:${row.platformMessageId.trim()}]`
					: "";
			const line = `${clock}${speaker}: ${text}${msgRef}`;
			if (used + line.length + 1 > budget) break;
			lines.push(line);
			used += line.length + 1;
		}
		if (lines.length === 0) return undefined;
		return [header, ...lines.toReversed()].join("\n");
	}

	async #collectMemories(
		durableConversationId: string,
		resolvedSession?: { chatKind: string; chatObjectId: string | null; sessionId: string },
		inputs: TurnContextRequest["inputs"] = [],
	) {
		const database = this.#database();
		if (database === undefined) return undefined;
		const session =
			resolvedSession ?? (await this.#resolveSession(database, durableConversationId));
		const policy =
			session === undefined
				? await this.#policyService.effectivePolicy()
				: await this.#policyService.effectivePolicy(session.sessionId);
		if (policy.memoryEnabled === false) {
			return { enabled: false as const, policy };
		}
		const recent = await this.#recentMessages(database, session?.sessionId);
		const warm =
			session === undefined || session.chatKind === "workspace"
				? undefined
				: await this.#memoryService.warmState(session.sessionId);
		const scopeFilter = await this.#scopeFilter(database, session, policy);
		const query = compact(
			uniq([
				...inputs.slice(-RECALL_QUERY_MESSAGE_LIMIT).map((input) => snippet(input.text ?? "", 600)),
				...recent.map((row) => snippet(row.contentText ?? "", 600)),
				...(warm?.state?.topics ?? []),
			]),
		).join("\n");
		this.#logger.trace("collecting memories for context", {
			durableConversationId,
			hasScopeFilter: scopeFilter !== undefined,
			recentCount: recent.length,
			sessionId: session?.sessionId,
		});
		const ranked =
			scopeFilter === undefined
				? []
				: await this.#memoryService.recall({
						...(session === undefined ? {} : { conversationId: session.sessionId }),
						limit: Math.max(this.#memoryTopK * 3, this.#memoryTopK),
						query,
						scopeFilter,
					});
		const longTerm = ranked.filter((entry) => entry.memory.id !== warm?.memory.id);
		return { enabled: true as const, longTerm, policy, recent, warm };
	}

	async #scopeFilter(
		database: TsukaimaDatabase,
		session: { chatKind: string; chatObjectId: string | null; sessionId: string } | undefined,
		policy: ConversationPolicy,
	): Promise<SQL | undefined> {
		const scopes: SQL[] = [eq(memories.scope, "global")];
		if (session !== undefined) {
			// Workspace coding sessions are isolated execution surfaces: no shared chat memories
			// may leak into a repository-mutating agent, and coding work must not write into the
			// chat memory graph either.
			if (session.chatKind === "workspace") return undefined;
			scopes.push(
				combine([
					eq(memories.scope, "conversation"),
					eq(memories.conversationId, session.sessionId),
				]),
			);
			if (
				(await this.#policyService.personaForSession({
					...session,
					conversationId: session.sessionId,
				})) !== undefined
			) {
				scopes.push(
					combine([
						eq(memories.scope, "persona"),
						or(eq(memories.conversationId, session.sessionId), isNull(memories.conversationId)),
					]),
				);
			}
			const participants = await this.#resolveParticipants(database, session.sessionId);
			if (participants.length > 0) {
				scopes.push(
					combine([eq(memories.scope, "user"), inArray(memories.subjectUserId, participants)]),
				);
			}
		}
		const scopeCondition = or(...scopes);
		if (scopeCondition === undefined) return undefined;
		if (policy.sharedMemoryEnabled === false) {
			return and(scopeCondition, ne(memories.visibility, "shared"));
		}
		return scopeCondition;
	}

	async #resolveSession(
		database: TsukaimaDatabase,
		durableConversationId: string,
	): Promise<{ chatKind: string; chatObjectId: string | null; sessionId: string } | undefined> {
		const [session] = await database
			.select({
				chatKind: conversations.kind,
				chatObjectId: conversations.chatObjectId,
				id: conversations.id,
			})
			.from(conversations)
			.where(eq(conversations.durableConversationId, durableConversationId))
			.orderBy(desc(conversations.updatedAt))
			.limit(1);
		if (session === undefined) return undefined;
		return {
			chatKind: session.chatKind,
			chatObjectId: session.chatObjectId,
			sessionId: session.id,
		};
	}

	/**
	 * Conversation participants for `scope = 'user'` memories: recorded members plus recent
	 * inbound senders. Private chats have no member rows today, so the sender set carries them.
	 */
	async #resolveParticipants(database: TsukaimaDatabase, sessionId: string): Promise<string[]> {
		const [memberRows, senderRows] = await Promise.all([
			database
				.select({ userId: conversationMembers.userId })
				.from(conversationMembers)
				.where(eq(conversationMembers.conversationId, sessionId)),
			database
				.select({ userId: messages.senderUserId })
				.from(messages)
				.where(and(eq(messages.conversationId, sessionId), eq(messages.direction, "inbound")))
				.orderBy(desc(messages.occurredAt))
				.limit(50),
		]);
		const participants = new Set<string>();
		for (const row of [...memberRows, ...senderRows]) {
			if (row.userId !== null) participants.add(row.userId);
		}
		return [...participants];
	}

	async #recentMessages(
		database: TsukaimaDatabase,
		sessionId: string | undefined,
		limit = RECALL_QUERY_MESSAGE_LIMIT,
	): Promise<
		{
			contentText: string | null;
			direction: string;
			id: string;
			kind: string;
			occurredAt: string;
			platformMessageId: string | null;
			rawRefJson: string | null;
			senderDisplayName: string | null;
			senderExternalId: string | null;
			senderUserId: string | null;
		}[]
	> {
		if (sessionId === undefined) return [];
		const [restore] = await database
			.select({ appliedAt: chatSnapshots.appliedAt, payload: chatSnapshots.payloadJson })
			.from(chatSnapshots)
			.innerJoin(conversations, eq(conversations.id, chatSnapshots.conversationId))
			.where(
				and(
					eq(chatSnapshots.conversationId, sessionId),
					eq(chatSnapshots.status, "applied"),
					eq(chatSnapshots.durableConversationId, conversations.durableConversationId),
				),
			)
			.orderBy(desc(chatSnapshots.appliedAt))
			.limit(1);
		const restoreWindow = restore?.appliedAt
			? sql`(julianday(${messages.ingestedAt}) > julianday(${restore.appliedAt}) OR EXISTS (
				SELECT 1 FROM json_each(${restore.payload}, '$.messages') AS snapshot_message
				WHERE json_extract(snapshot_message.value, '$.id') = ${messages.id}
			))`
			: undefined;
		const recent = await database
			.select({
				contentText: messages.contentText,
				direction: messages.direction,
				id: messages.id,
				kind: messages.kind,
				occurredAt: messages.occurredAt,
				platformMessageId: messages.platformMessageId,
				rawRefJson: messages.rawRefJson,
				senderDisplayName: messages.senderDisplayName,
				senderExternalId: messages.senderExternalId,
				senderUserId: messages.senderUserId,
			})
			.from(messages)
			.where(
				and(
					eq(messages.conversationId, sessionId),
					ne(messages.kind, "tool"),
					ne(messages.kind, "reply-lurk"),
					restoreWindow,
				),
			)
			.orderBy(desc(messages.occurredAt), desc(messages.id))
			.limit(limit);
		return recent.toReversed();
	}

	#format(
		input: {
			readonly ranked: readonly RankedMemory[];
			readonly warm: WarmStatePayload | undefined;
		},
		memoryBudget: number,
		preferredSpeakerIds: readonly string[] = [],
	): string | undefined {
		const lines: string[] = [];
		let used = 0;
		const push = (line: string): boolean => {
			if (used + line.length + 1 > memoryBudget) return false;
			lines.push(line);
			used += line.length + 1;
			return true;
		};
		// Pre-Batch-5 regex warm rows carry no structured state and are deliberately not shown.
		const warmLines =
			input.warm === undefined
				? []
				: renderWarmStateLines(input.warm, {
						maxLineChars: Math.min(memoryBudget, 600),
						preferredPersonKeys: preferredSpeakerIds,
					});
		if (warmLines.length > 0 && push(WARM_HEADER)) {
			for (const line of warmLines) if (!push(line)) break;
		}
		const pool = input.ranked.slice(0, this.#memoryTopK);
		if (pool.length > 0) {
			if (push(LONG_TERM_HEADER)) {
				let shown = 0;
				for (const entry of pool) {
					const summary = (entry.memory.summary.trim() || entry.memory.content.trim())
						.replace(/\s+/gu, " ")
						.slice(0, MEMORY_SNIPPET_LIMIT);
					const idPrefix = memoryBudget >= 240 ? `[id:${entry.memory.id}] ` : "";
					if (!push(`- ${idPrefix}[${entry.memory.scope}/${entry.memory.kind}] ${summary}`)) break;
					shown += 1;
				}
				if (shown < pool.length) {
					push(`- (+${pool.length - shown} more not shown)`);
				}
			}
		}
		if (lines.length === 0) return undefined;
		const text = lines.join("\n");
		return text.length > memoryBudget
			? truncateChars(text, memoryBudget, MEMORY_TRUNCATION_NOTE)
			: text;
	}

	/**
	 * Resolve the canonical speakers of the run's own inputs. A burst may contain several
	 * speakers; cross-session covers each identified one (bounded), while unknown speakers
	 * contribute only their text to QA consistency and yield no cross-session context.
	 */
	async #currentSpeaker(
		database: TsukaimaDatabase,
		sessionId: string,
		request: TurnContextRequest,
	): Promise<RunSpeakers> {
		const inputIds = [
			...new Set(
				request.inputs.flatMap((input) =>
					[input.envelopeId, input.platformMessageId].filter(
						(id): id is string => id !== undefined,
					),
				),
			),
		];
		const inputText = request.inputs.flatMap((input) =>
			input.text === undefined ? [] : [input.text],
		);
		if (inputIds.length === 0) {
			return { name: undefined, speakers: [], text: inputText.join("\n"), userId: undefined };
		}
		const rows = await database
			.select({
				contentText: messages.contentText,
				senderDisplayName: messages.senderDisplayName,
				senderUserId: messages.senderUserId,
			})
			.from(messages)
			.where(
				and(
					eq(messages.conversationId, sessionId),
					eq(messages.direction, "inbound"),
					or(inArray(messages.id, inputIds), inArray(messages.platformMessageId, inputIds)),
				),
			)
			.orderBy(desc(messages.occurredAt))
			.limit(Math.max(1, request.inputs.length));
		const newest = rows[0];
		const speakerIds = new Set<string>();
		const speakers: RunSpeaker[] = [];
		for (const row of rows) {
			const userId = row.senderUserId ?? undefined;
			if (userId === undefined || speakerIds.has(userId)) continue;
			speakerIds.add(userId);
			const name = row.senderDisplayName?.trim() || undefined;
			speakers.push(name === undefined ? { userId } : { name, userId });
			if (speakers.length >= 3) break;
		}
		return {
			name: newest?.senderDisplayName?.trim() || undefined,
			speakers,
			text:
				inputText.length > 0
					? inputText.join("\n")
					: rows
							.map((row) => row.contentText ?? "")
							.toReversed()
							.join("\n"),
			userId: newest?.senderUserId ?? undefined,
		};
	}

	async #crossSession(
		database: TsukaimaDatabase,
		session: { chatKind: string; sessionId: string },
		policy: ConversationPolicy,
		speaker: RunSpeakers,
		nowMs: number,
		budget: number,
	): Promise<string | undefined> {
		if (speaker.speakers.length === 0) return undefined;
		const blocks: string[] = [];
		let remaining = Math.min(budget, policy.crossSession.maxChars);
		for (const entry of speaker.speakers) {
			if (remaining <= 0) break;
			const entries = await queryCrossSession(database, {
				currentKind: session.chatKind,
				currentSessionId: session.sessionId,
				nowMs,
				policy: policy.crossSession,
				sourceAllowed: async (conversationId) => {
					const source = await this.#policyService.effectivePolicy(conversationId);
					return source.memoryEnabled && source.crossSession.enabled;
				},
				speakerUserId: entry.userId,
			});
			if (entries.length === 0) continue;
			const block = renderCrossSession(entries, {
				formatTime: (iso) => {
					const at = Date.parse(iso);
					return Number.isFinite(at) ? formatLocalClock(at, this.#timeZoneOptions()) : iso;
				},
				maxChars: remaining,
				speakerName: entry.name ?? "This person",
			});
			if (block === undefined) continue;
			blocks.push(block);
			remaining -= block.length + 1;
		}
		return blocks.length === 0 ? undefined : blocks.join("\n");
	}

	async #qaConsistency(
		sessionId: string,
		query: string,
		budget: number,
	): Promise<string | undefined> {
		const answers = await this.#memoryService.recallAnsweredQuestions(sessionId, query);
		if (answers.length === 0) return undefined;
		const lines = [QA_HEADER];
		let used = QA_HEADER.length;
		for (const entry of answers) {
			const question = snippet(entry.question, QA_SNIPPET_LIMIT);
			const line = `- Q: ${question} A: ${snippet(entry.answer, QA_SNIPPET_LIMIT)}`;
			if (used + line.length + 1 > budget) break;
			lines.push(line);
			used += line.length + 1;
		}
		return lines.length > 1 ? lines.join("\n") : undefined;
	}

	async #renderParticipationGuidance(
		database: TsukaimaDatabase,
		session: { readonly chatKind: string; readonly sessionId: string },
		policy: ConversationPolicy,
		request: TurnContextRequest,
		soft: boolean,
	): Promise<string | undefined> {
		const notes: string[] = [];
		const nowMs = request.nowMs;
		const latestText = (request.inputs ?? [])
			.map((input) => input.text?.trim() ?? "")
			.filter((value) => value.length > 0)
			.join("\n");

		if (policy.pacing.quietUntilMs !== undefined && policy.pacing.quietUntilMs > nowMs) {
			const mins = Math.max(1, Math.ceil((policy.pacing.quietUntilMs - nowMs) / 60_000));
			notes.push(
				`Temporary quiet mode is active for ~${mins} more minute(s). Stay silent (${LURK_MARKER}) unless directly asked something substantive, and keep any reply very brief.`,
			);
		}

		if (latestText.length > 0 && detectQuietFeedback(latestText).quietRequested) {
			notes.push(
				`Someone in this chat is asking you to be quieter or stop interrupting. Respect it immediately without arguing or over-apologizing: consider calling chat_settings_adjust (e.g. posture="quiet" or quietMinutes) and/or chat_context_note, then reply very briefly or output ${LURK_MARKER} to stay silent.`,
			);
		}

		if (session.chatKind === "group") {
			if (latestText.length > 0 && isLowSubstanceReaction(latestText)) {
				notes.push(
					`The latest message looks like a brief reaction or acknowledgment ("${snippet(latestText, 30)}"). Do not force a follow-up if the exchange is naturally done; reply with ${LURK_MARKER}.`,
				);
			}
			const windowSize = Math.max(4, policy.social.selfRatioWindowMessages);
			const recent = await database
				.select({ direction: messages.direction })
				.from(messages)
				.where(
					and(
						eq(messages.conversationId, session.sessionId),
						ne(messages.direction, "system"),
						ne(messages.kind, "tool"),
					),
				)
				.orderBy(desc(messages.occurredAt), desc(messages.id))
				.limit(windowSize);
			if (recent.length >= 4) {
				const outbound = recent.filter((row) => row.direction === "outbound").length;
				const ratio = outbound / recent.length;
				if (ratio >= policy.social.maxSelfMessageRatio) {
					notes.push(
						`You sent ${outbound} of the last ${recent.length} messages in this group. Avoid dominating the room: stay brief or reply ${LURK_MARKER} unless directly needed.`,
					);
				}
			}
			let trailingBot = 0;
			for (const row of recent) {
				if (row.direction === "outbound") trailingBot += 1;
				else break;
			}
			if (trailingBot >= 2 && soft) {
				notes.push(
					`Your last ${trailingBot} messages here had no direct reply; prefer ${LURK_MARKER} over chiming in again.`,
				);
			}
		}

		return notes.length === 0 ? undefined : notes.join("\n");
	}

	async #recentOutboundReplies(
		database: TsukaimaDatabase,
		sessionId: string,
		limit: number,
	): Promise<string[]> {
		const rows = await database
			.select({ contentText: messages.contentText })
			.from(messages)
			.where(
				and(
					eq(messages.conversationId, sessionId),
					eq(messages.direction, "outbound"),
					ne(messages.kind, "tool"),
				),
			)
			.orderBy(desc(messages.occurredAt), desc(messages.id))
			.limit(Math.max(1, limit));
		return rows
			.toReversed()
			.map((row) => (row.contentText ?? "").trim())
			.filter((text) => text.length > 0);
	}

	/**
	 * Check whether a newly produced assistant reply severely repeats overused catchphrases from
	 * recent bot replies, for the optional bounded single-retry rewrite guard.
	 */
	async checkRepetitionRewrite(
		durableConversationId: string,
		replyText: string,
	): Promise<{ readonly matched: readonly string[]; readonly rewrite: boolean } | undefined> {
		const database = this.#database();
		if (database === undefined) return undefined;
		const session = await this.#resolveSession(database, durableConversationId);
		if (session === undefined || session.chatKind === "workspace") return undefined;
		const policy = await this.#policyService.effectivePolicy(session.sessionId);
		if (!policy.humanization.repetitionRewriteEnabled) return undefined;
		const replies = await this.#recentOutboundReplies(
			database,
			session.sessionId,
			policy.humanization.antiRepetitionWindow,
		);
		const report = detectOverusedPhrases(replies, {
			threshold: policy.humanization.antiRepetitionThreshold,
		});
		// A single phrase at the threshold is worth avoiding next turn, but only severe repetition
		// (multiple ticks or well above the threshold) justifies a bounded rewrite of the answer.
		if (!report.severe) return { matched: [], rewrite: false };
		return needsRepetitionRewrite(replyText, report.phrases);
	}

	/** Compact one-line persona anchor used by fast-lane busy interjections. */
	async personaAnchor(durableConversationId: string): Promise<string> {
		const profile = await this.#personaProfile(durableConversationId).catch(() => undefined);
		if (profile === undefined) return "You are Tsukaima, replying naturally in character.";
		const summary = snippet(profile.persona.summary, 140);
		return summary.length > 0
			? `You are ${profile.persona.name} (${summary}).`
			: `You are ${profile.persona.name}; stay in character.`;
	}
}
