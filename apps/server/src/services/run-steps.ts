import type { RunStep } from "@tsukaima/contracts";

/** Compact single-line JSON, so an argument object reads as one row. */
function argumentsText(value: unknown): string {
	if (value === undefined || value === null) return "";
	let json: string;
	try {
		json = JSON.stringify(value);
	} catch {
		return "";
	}
	return json;
}

function toolOutput(message: Record<string, unknown>): string {
	const blocks: readonly unknown[] = Array.isArray(message.content) ? message.content : [];
	const parts = blocks.map((block) => {
		if (
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "text" &&
			"text" in block &&
			typeof block.text === "string"
		)
			return block.text;
		return JSON.stringify(block, null, 2);
	});
	if (message.details !== undefined) parts.push(JSON.stringify(message.details, null, 2));
	return parts.join("\n");
}

/**
 * Minimal shape this module needs from a durable entry. Deliberately looser than the durable
 * `EntryRecord` so the mapper stays testable without constructing provider messages.
 */
export interface StepEntry {
	readonly data?: unknown;
	readonly id: string;
	readonly kind: string;
	readonly model?: unknown;
}

/** First message of an entry's `model` array, or `undefined` when it has none. */
function firstMessage(model: unknown): Record<string, unknown> | undefined {
	if (!Array.isArray(model)) return undefined;
	const [first] = model as readonly unknown[];
	if (typeof first !== "object" || first === null) return undefined;
	return first as Record<string, unknown>;
}

interface ToolCallBlock {
	arguments?: unknown;
	id: string;
	name: string;
	type: "toolCall";
}

function isToolCall(block: unknown): block is ToolCallBlock {
	if (typeof block !== "object" || block === null) return false;
	if (!("type" in block) || block.type !== "toolCall") return false;
	if (!("name" in block) || typeof block.name !== "string") return false;
	if (!("id" in block) || typeof block.id !== "string") return false;
	return true;
}

/**
 * Whether the entry is a model round that handed over to tools instead of answering. A steered
 * input is placed after such a round, so its activity window continues the same answer rather
 * than starting a new turn.
 */
function isToolRound(entry: StepEntry | undefined): boolean {
	if (entry?.kind !== "pi.assistant") return false;
	const message = firstMessage(entry.model);
	if (message === undefined) return false;
	if (typeof message.stopReason === "string") return message.stopReason === "toolUse";
	if (!Array.isArray(message.content)) return false;
	return (message.content as readonly unknown[]).some(isToolCall);
}

/**
 * Whether the activity window at `index` continues the run already in progress. A steer is
 * appended mid-run, directly after the tool-call round it steers; the run's first window sits
 * after a completed answer (or at the start of the transcript).
 */
function continuesRun(entries: readonly StepEntry[], index: number): boolean {
	for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
		const entry = entries[cursor];
		if (entry === undefined) return false;
		if (entry.kind === "pi.tool-result") continue;
		if (entry.kind === "tsukaima.activityWindow") return false;
		if (entry.kind === "pi.assistant") return isToolRound(entry);
		// Context/system entries can land between a tool round and a steer; they neither start
		// nor end the turn, so keep walking back to the model round that owns the window.
	}
	return false;
}

/**
 * Turn the durable entries of one assistant turn into displayable steps.
 *
 * The live `pi.live` document is cleared when a run settles, so it cannot back a transcript that
 * keeps showing what the agent did. The durable transcript can: `pi.assistant` entries carry the
 * model's thinking, text, and tool calls, and `pi.tool-result` entries carry what each call
 * returned. This pairs a call with its result so the reader sees one row per tool, and keeps
 * ordering as the model produced it.
 *
 * Returns the steps for the turn that ends at `entryId`. Entries before the previous assistant
 * answer belong to an earlier turn and are skipped.
 */
export function runStepsFromEntries(entries: readonly StepEntry[], entryId: string): RunStep[] {
	return collectRunSteps(entries, entryId).steps;
}

/**
 * Steps plus the turn's total model and tool time. Duration is summed from the per-message
 * `durationMs` the provider reports; the transcript has no wall clock for the turn itself.
 */
export function collectRunSteps(
	entries: readonly StepEntry[],
	entryId: string,
): { durationSeconds?: number; steps: RunStep[] } {
	const endIndex = entries.findIndex((entry) => entry.id === entryId);
	if (endIndex === -1) return { steps: [] };
	// Walk back to the entry that started this turn. A turn is one activity window: the model
	// may answer several times within it (one entry per tool round), so the boundary is the
	// window, not the previous assistant entry. A steer can append another window in the middle
	// of the same run, so keep walking past windows that follow a tool round.
	let startIndex = 0;
	for (let index = endIndex; index >= 0; index -= 1) {
		if (entries[index]?.kind === "tsukaima.activityWindow") {
			startIndex = index;
			if (!continuesRun(entries, index)) break;
		}
	}

	const steps: RunStep[] = [];
	let durationMs = 0;
	let sawDuration = false;
	/** Results are paired onto their call, so a result alone still shows up. */
	const pendingCalls = new Map<string, { index: number }>();

	for (let index = startIndex; index <= endIndex; index += 1) {
		const entry = entries[index];
		if (entry === undefined) continue;

		if (entry.kind === "pi.assistant") {
			const message = firstMessage(entry.model);
			if (typeof message !== "object" || message === null) continue;
			if (typeof message.durationMs === "number") {
				durationMs += message.durationMs;
				sawDuration = true;
			}
			if (!("content" in message) || !Array.isArray(message.content)) continue;
			for (const block of message.content as readonly unknown[]) {
				if (typeof block !== "object" || block === null) continue;
				if ("type" in block && block.type === "thinking") {
					const thinking =
						"thinking" in block && typeof block.thinking === "string" ? block.thinking : "";
					if (thinking.trim().length > 0) {
						steps.push({ kind: "thinking", text: thinking });
					}
					continue;
				}
				if ("type" in block && block.type === "text") {
					const text = "text" in block && typeof block.text === "string" ? block.text : "";
					if (text.trim().length > 0) steps.push({ kind: "text", text: text.trim() });
					continue;
				}
				if (isToolCall(block)) {
					pendingCalls.set(block.id, { index: steps.length });
					steps.push({
						argumentsText: argumentsText(block.arguments),
						isError: false,
						kind: "tool",
						output: "",
						toolName: block.name,
					});
				}
			}
			continue;
		}

		if (entry.kind === "pi.tool-result") {
			const message = firstMessage(entry.model);
			if (typeof message !== "object" || message === null) continue;
			if (typeof message.durationMs === "number") {
				durationMs += message.durationMs;
				sawDuration = true;
			}
			const callId =
				"toolCallId" in message && typeof message.toolCallId === "string"
					? message.toolCallId
					: undefined;
			if (callId === undefined) continue;
			const pending = pendingCalls.get(callId);
			const existing = pending === undefined ? undefined : steps[pending.index];
			const toolName = existing?.kind === "tool" ? existing.toolName : message.toolName;
			if (typeof toolName !== "string") continue;
			const result: RunStep = {
				argumentsText: existing?.kind === "tool" ? existing.argumentsText : "",
				isError: message.isError === true,
				kind: "tool",
				output: toolOutput(message),
				toolName,
			};
			if (pending === undefined) steps.push(result);
			else steps[pending.index] = result;
			pendingCalls.delete(callId);
		}
	}

	return sawDuration
		? { durationSeconds: Math.round((durationMs / 1_000) * 10) / 10, steps }
		: { steps };
}
