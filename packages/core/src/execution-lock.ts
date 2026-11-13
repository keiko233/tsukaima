import { AsyncLocalStorage } from "node:async_hooks";

interface HeldConversationLock {
	readonly conversationId: string;
	active: boolean;
}

const heldConversations = new AsyncLocalStorage<readonly HeldConversationLock[]>();

function activeFrame(
	frames: readonly HeldConversationLock[] | undefined,
	conversationId: string,
): HeldConversationLock | undefined {
	return frames?.find((frame) => frame.active && frame.conversationId === conversationId);
}

/**
 * Per-conversation async mutex. Different conversation ids never block each other, which keeps
 * one noisy group from delaying every other chat while still serializing inbound turns,
 * steering/follow-ups, outbound pacing, and future proactive turns for the same conversation.
 *
 * The lock is reentrant only while the outer acquisition is still active: a scheduled/background
 * task can call the conversation host or reply dispatcher without deadlocking, while detached
 * work inherited through AsyncLocalStorage re-acquires the lock normally once the outer frame
 * has released it.
 */
export class ConversationExecutionLock {
	readonly #tails = new Map<string, Promise<void>>();

	async run<T>(conversationId: string, task: () => Promise<T> | T): Promise<T> {
		const held = heldConversations.getStore();
		if (activeFrame(held, conversationId) !== undefined) return await task();
		const previous = this.#tails.get(conversationId) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.catch(() => undefined).then(() => gate);
		this.#tails.set(conversationId, tail);
		await previous.catch(() => undefined);
		const frame: HeldConversationLock = { active: true, conversationId };
		try {
			const active = (held ?? []).filter((entry) => entry.active);
			return await heldConversations.run([...active, frame], task);
		} finally {
			frame.active = false;
			release();
			if (this.#tails.get(conversationId) === tail) this.#tails.delete(conversationId);
		}
	}

	/** True while a task for this conversation is queued or running. */
	isBusy(conversationId: string): boolean {
		return this.#tails.has(conversationId);
	}
}

/** The host-wide lock shared by every conversation execution path. */
export const defaultConversationExecutionLock = new ConversationExecutionLock();

export function withConversationLock<T>(
	conversationId: string,
	task: () => Promise<T> | T,
	lock: ConversationExecutionLock = defaultConversationExecutionLock,
): Promise<T> {
	return lock.run(conversationId, task);
}
