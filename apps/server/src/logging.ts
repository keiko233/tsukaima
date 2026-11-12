export const logLevels = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof logLevels)[number];
export type LogValue = string | number | boolean | null | LogValue[] | { [key: string]: LogValue };
export type LogFields = Record<string, LogValue>;
export type LogInputFields = Record<string, unknown>;

export interface LogSpan {
	readonly fields: LogFields;
	readonly name: string;
}

export interface LogEntry {
	readonly ansi: string;
	readonly fields: LogFields;
	readonly id: number;
	readonly level: LogLevel;
	readonly message: string;
	readonly span: LogSpan | null;
	readonly target: string;
	readonly text: string;
	readonly timestamp: string;
}

export interface LogQuery {
	readonly afterId?: number;
	readonly level?: LogLevel;
	readonly limit?: number;
}

export interface LogSnapshot {
	readonly capacity: number;
	readonly dropped: number;
	readonly entries: readonly LogEntry[];
}

export type LogSubscriber = (entry: LogEntry) => void;
export type LogSink = (entry: LogEntry) => void;

export interface LoggerOptions {
	readonly buffer?: LogBuffer;
	readonly color?: boolean;
	readonly level?: LogLevel;
	readonly sink?: LogSink;
	readonly target?: string;
}

interface LoggerRuntime {
	readonly buffer: LogBuffer;
	readonly sink: LogSink | undefined;
	level: LogLevel;
}

const DEFAULT_CAPACITY = 2_000;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_VALUE_LENGTH = 800;
const MAX_FIELD_DEPTH = 4;
const MAX_FIELD_ENTRIES = 40;
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
	/(?:api|private)[-_]?key|(?:access|refresh|auth)[-_]?token|^token$|secret|password|passwd|authorization|cookie|credential/i;
const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	error: 3,
	info: 1,
	warn: 2,
};
const ANSI = {
	bold: "\u001b[1m",
	boldBlue: "\u001b[1;34m",
	boldGreen: "\u001b[1;32m",
	boldRed: "\u001b[1;31m",
	boldYellow: "\u001b[1;33m",
	cyan: "\u001b[36m",
	dim: "\u001b[2m",
	reset: "\u001b[0m",
} as const;
const LEVEL_ANSI: Record<LogLevel, string> = {
	debug: ANSI.boldBlue,
	error: ANSI.boldRed,
	info: ANSI.boldGreen,
	warn: ANSI.boldYellow,
};

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength - 1)}…`;
}

function singleLine(value: string): string {
	let output = "";
	for (const character of value.replace(/\r\n|\r|\n/g, "\\n")) {
		const code = character.codePointAt(0) ?? 0;
		output +=
			code < 0x20 || (code >= 0x7f && code <= 0x9f)
				? `\\u${code.toString(16).padStart(4, "0")}`
				: character;
	}
	return output;
}

function normalizeValue(value: unknown, depth: number, seen: WeakSet<object>): LogValue {
	if (value === null) return null;
	if (typeof value === "string") return truncate(singleLine(value), MAX_MESSAGE_LENGTH);
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "undefined") return null;
	if (typeof value === "function" || typeof value === "symbol") return String(value);
	if (value instanceof Date) return value.toISOString();
	if (value instanceof Error) {
		return {
			message: truncate(singleLine(value.message), MAX_MESSAGE_LENGTH),
			name: value.name,
			...(value.stack === undefined
				? {}
				: { stack: truncate(singleLine(value.stack), MAX_MESSAGE_LENGTH) }),
		};
	}
	if (depth >= MAX_FIELD_DEPTH) return Array.isArray(value) ? "[Array]" : "[Object]";
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	if (Array.isArray(value)) {
		return value.slice(0, MAX_FIELD_ENTRIES).map((item) => normalizeValue(item, depth + 1, seen));
	}
	const entries = Object.entries(value).slice(0, MAX_FIELD_ENTRIES);
	return Object.fromEntries(
		entries.map(([key, item]) => [
			singleLine(key),
			SENSITIVE_KEY.test(key) ? REDACTED : normalizeValue(item, depth + 1, seen),
		]),
	);
}

function normalizeFields(fields: LogInputFields | undefined): LogFields {
	if (fields === undefined) return {};
	return Object.fromEntries(
		Object.entries(fields).map(([key, value]) => [
			singleLine(key),
			SENSITIVE_KEY.test(key) ? REDACTED : normalizeValue(value, 0, new WeakSet()),
		]),
	);
}

function renderValue(value: LogValue): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (value === null) return "null";
	if (typeof value === "object") {
		return truncate(JSON.stringify(value), MAX_VALUE_LENGTH);
	}
	return String(value);
}

function renderFields(fields: LogFields, color: boolean): string {
	return Object.entries(fields)
		.map(([key, value]) => {
			const safeKey = singleLine(key);
			return color
				? `${ANSI.cyan}${safeKey}${ANSI.reset}=${renderValue(value)}`
				: `${safeKey}=${renderValue(value)}`;
		})
		.join(" ");
}

function renderLogEntry(entry: Omit<LogEntry, "ansi" | "id" | "text">, color: boolean): string {
	const timestamp = color ? `${ANSI.dim}${entry.timestamp}${ANSI.reset}` : entry.timestamp;
	const level = entry.level.toUpperCase().padStart(5);
	const renderedLevel = color ? `${LEVEL_ANSI[entry.level]}${level}${ANSI.reset}` : level;
	const span =
		entry.span === null
			? ""
			: `${
					color
						? `${ANSI.boldBlue}${entry.span.name}${ANSI.reset}${ANSI.dim}{`
						: `${entry.span.name}{`
				}${renderFields(entry.span.fields, color)}${color ? `${ANSI.dim}}${ANSI.reset}` : "}"}: `;
	const target = color ? `${ANSI.bold}${entry.target}${ANSI.reset}` : entry.target;
	const fields = renderFields(entry.fields, color);
	return `${timestamp} ${renderedLevel} ${span}${target}: ${entry.message}${
		fields.length === 0 ? "" : ` ${fields}`
	}`;
}

export function encodeSseEvent(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class LogBuffer {
	readonly #capacity: number;
	readonly #entries: LogEntry[] = [];
	readonly #subscribers = new Set<LogSubscriber>();
	#dropped = 0;
	#nextId = 1;

	constructor(capacity = DEFAULT_CAPACITY) {
		this.#capacity = Math.max(1, Math.floor(capacity));
	}

	get capacity(): number {
		return this.#capacity;
	}

	get dropped(): number {
		return this.#dropped;
	}

	get size(): number {
		return this.#entries.length;
	}

	append(entry: Omit<LogEntry, "id">): LogEntry {
		const complete = { ...entry, id: this.#nextId };
		this.#nextId += 1;
		this.#entries.push(complete);
		while (this.#entries.length > this.#capacity) {
			this.#entries.shift();
			this.#dropped += 1;
		}
		for (const subscriber of this.#subscribers) {
			try {
				subscriber(complete);
			} catch {}
		}
		return complete;
	}

	clear(): number {
		const cleared = this.#entries.length;
		this.#entries.length = 0;
		this.#dropped = 0;
		return cleared;
	}

	list(query: LogQuery = {}): readonly LogEntry[] {
		let entries = this.#entries;
		if (query.afterId !== undefined) {
			entries = entries.filter((entry) => entry.id > query.afterId!);
		}
		if (query.level !== undefined) {
			entries = entries.filter((entry) => entry.level === query.level);
		}
		if (query.limit !== undefined) {
			entries = entries.slice(-Math.max(0, Math.floor(query.limit)));
		}
		return entries;
	}

	snapshot(): LogSnapshot {
		return {
			capacity: this.#capacity,
			dropped: this.#dropped,
			entries: this.list(),
		};
	}

	subscribe(subscriber: LogSubscriber): () => void {
		this.#subscribers.add(subscriber);
		return () => {
			this.#subscribers.delete(subscriber);
		};
	}
}

export class Logger {
	readonly #boundFields: LogFields;
	readonly #runtime: LoggerRuntime;
	readonly #span: LogSpan | null;
	readonly #target: string;

	private constructor(
		runtime: LoggerRuntime,
		target: string,
		boundFields: LogFields = {},
		span: LogSpan | null = null,
	) {
		this.#runtime = runtime;
		this.#target = target;
		this.#boundFields = boundFields;
		this.#span = span;
	}

	static create(options: LoggerOptions = {}): Logger {
		const buffer = options.buffer ?? new LogBuffer();
		const runtime: LoggerRuntime = {
			buffer,
			level: options.level ?? "info",
			sink: options.sink ?? createConsoleSink(options.color),
		};
		return new Logger(runtime, options.target ?? "tsukaima::server");
	}

	get buffer(): LogBuffer {
		return this.#runtime.buffer;
	}

	get level(): LogLevel {
		return this.#runtime.level;
	}

	setLevel(level: LogLevel): void {
		this.#runtime.level = level;
	}

	child(target: string, fields?: LogInputFields): Logger {
		return new Logger(
			this.#runtime,
			target,
			{
				...this.#boundFields,
				...normalizeFields(fields),
			},
			this.#span,
		);
	}

	withFields(fields: LogInputFields): Logger {
		return new Logger(
			this.#runtime,
			this.#target,
			{
				...this.#boundFields,
				...normalizeFields(fields),
			},
			this.#span,
		);
	}

	span(name: string, fields?: LogInputFields): Logger {
		return new Logger(this.#runtime, this.#target, this.#boundFields, {
			fields: normalizeFields(fields),
			name: singleLine(name),
		});
	}

	debug(message: string, fields?: LogInputFields): void {
		this.#write("debug", message, fields);
	}

	info(message: string, fields?: LogInputFields): void {
		this.#write("info", message, fields);
	}

	warn(message: string, fields?: LogInputFields): void {
		this.#write("warn", message, fields);
	}

	error(message: string, fields?: LogInputFields): void {
		this.#write("error", message, fields);
	}

	#write(level: LogLevel, message: string, fields?: LogInputFields): void {
		if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.#runtime.level]) return;
		const body = {
			fields: {
				...this.#boundFields,
				...normalizeFields(fields),
			},
			level,
			message: truncate(singleLine(message), MAX_MESSAGE_LENGTH),
			span: this.#span,
			target: singleLine(this.#target),
			timestamp: new Date().toISOString(),
		};
		const entry = this.#runtime.buffer.append({
			...body,
			ansi: renderLogEntry(body, true),
			text: renderLogEntry(body, false),
		});
		try {
			this.#runtime.sink?.(entry);
		} catch {}
	}
}

function createConsoleSink(colorOption?: boolean): LogSink {
	const color =
		colorOption ??
		(process.stdout.isTTY === true &&
			process.env.NO_COLOR === undefined &&
			process.env.FORCE_COLOR !== "0");
	return (entry) => {
		const line = color ? entry.ansi : entry.text;
		if (entry.level === "error") console.error(line);
		else if (entry.level === "warn") console.warn(line);
		else console.log(line);
	};
}

export function createLogger(options: LoggerOptions = {}): Logger {
	return Logger.create(options);
}
