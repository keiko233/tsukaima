export interface CompressionInput {
	readonly conversationId: string;
	readonly text: string;
	readonly maxChars: number;
}

export interface CompressionResult {
	readonly conversationId: string;
	readonly summary: string;
	readonly model: string;
	readonly promptVersion: string;
	readonly confidence: number;
	readonly sourceRange: { readonly start: number; readonly end: number };
}

export interface Compressor {
	compress(input: CompressionInput): Promise<CompressionResult>;
}

export class FakeCompressor implements Compressor {
	async compress(input: CompressionInput): Promise<CompressionResult> {
		const sentences = input.text
			.split(/(?<=[.!?。！？])\s+/)
			.filter((sentence) => sentence.trim().length > 0)
			.slice(0, 3)
			.join(" ");
		const summary = sentences.length > input.maxChars
			? `${sentences.slice(0, input.maxChars)}…`
			: sentences || `Conversation ${input.conversationId}`;
		return {
			conversationId: input.conversationId,
			summary,
			model: "fake-compressor",
			promptVersion: "migration.summarize.v1",
			confidence: 1,
			sourceRange: { start: 0, end: Math.max(0, input.text.length) },
		};
	}
}
