import { messageEnvelopeSchema, type MessageEnvelope } from "@tsukaima/contracts";

export class InvalidEnvelopeError extends Error {
	constructor(message = "Invalid message envelope") {
		super(message);
		this.name = "InvalidEnvelopeError";
	}
}

export class EnvelopeValidationError extends InvalidEnvelopeError {
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(`Invalid message envelope: ${issues.join("; ")}`);
		this.name = "EnvelopeValidationError";
		this.issues = issues;
	}
}

export class OversizeMessageError extends Error {
	readonly actualBytes: number;
	readonly maxBytes: number;

	constructor(actualBytes: number, maxBytes: number) {
		super(`Message envelope exceeds ${maxBytes} bytes`);
		this.name = "OversizeMessageError";
		this.actualBytes = actualBytes;
		this.maxBytes = maxBytes;
	}
}

export interface AbuseGuardOptions {
	readonly maxBytes?: number;
}

export interface AbuseGuardResult {
	readonly actualBytes: number;
	readonly envelope: MessageEnvelope;
	readonly maxBytes: number;
}

const defaultMaxBytes = 64 * 1024;

export class AbuseGuard {
	private readonly maxBytes: number;

	constructor(options: AbuseGuardOptions = {}) {
		const maxBytes = options.maxBytes ?? defaultMaxBytes;
		if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
			throw new RangeError("maxBytes must be a positive safe integer");
		}
		this.maxBytes = maxBytes;
	}

	check(envelope: unknown): AbuseGuardResult {
		const actualBytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
		if (actualBytes > this.maxBytes) {
			throw new OversizeMessageError(actualBytes, this.maxBytes);
		}
		const parsed = messageEnvelopeSchema.safeParse(envelope);
		if (!parsed.success) {
			throw new EnvelopeValidationError(
				parsed.error.issues.map(
					(issue) => `${issue.path.join(".") || "envelope"}: ${issue.message}`,
				),
			);
		}
		return { actualBytes, envelope: parsed.data, maxBytes: this.maxBytes };
	}
}
