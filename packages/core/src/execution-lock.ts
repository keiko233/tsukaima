/**
 * Per-conversation async mutex. Different conversation ids never block each other, which keeps
 * one noisy group from delaying every other chat while still serializing inbound turns,
 * steering/follow-ups, outbound pacing, and future proactive turns for the same conversation.
 */
export class ConversationExecutionLock {
	readonly #tails = new Map<string, Promise<void>>();

	async run<T>(conversationId: string, task: () => Promise<T> | T): Promise<T> {
		const previous = this.#tails.get(conversationId) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.catch(() => undefined).then(() => gate);
		this.#tails.set(conversationId, tail);
		await previous.catch(() => undefined);
		try {
			return await task();
		} finally {
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
