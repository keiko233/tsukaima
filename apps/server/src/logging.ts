import { mkdirSync, readdirSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { logLevels, type LogLevel } from "@tsukaima/contracts";

export { logLevels, type LogLevel };
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
	readonly capacity?: number;
	readonly color?: boolean;
	readonly level?: LogLevel;
	readonly sink?: LogSink;
	readonly sinks?: readonly LogSink[];
	readonly target?: string;
}

export interface DailyFileLogSinkOptions {
	readonly dir: string;
	readonly prefix?: string;
	readonly retentionDays?: number;
}

export interface DailyFileLogSink {
	readonly sink: LogSink;
	readonly currentPath: () => string | undefined;
	close(): void;
}

interface LoggerRuntime {
	readonly buffer: LogBuffer;
	readonly sinks: Set<LogSink>;
	level: LogLevel;
}

export const DEFAULT_LOG_CAPACITY = 5_000;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_VALUE_LENGTH = 800;
const MAX_FIELD_DEPTH = 4;
const MAX_FIELD_ENTRIES = 40;
const DEFAULT_PREVIEW_LENGTH = 120;
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
	/(?:api|private)[-_]?key|(?:access|refresh|auth)[-_]?token|^token$|secret|password|passwd|authorization|cookie|credential/i;
const LEVEL_PRIORITY: Record<LogLevel, number> = {
	trace: 0,
	debug: 1,
	info: 2,
	warn: 3,
	error: 4,
};
const ANSI = {
	bold: "\u001b[1m",
	boldBlue: "\u001b[1;34m",
	boldGreen: "\u001b[1;32m",
	boldRed: "\u001b[1;31m",
	boldYellow: "\u001b[1;33m",
	cyan: "\u001b[36m",
	dim: "\u001b[2m",
	gray: "\u001b[90m",
	reset: "\u001b[0m",
} as const;
const LEVEL_ANSI: Record<LogLevel, string> = {
	trace: ANSI.gray,
	debug: ANSI.boldBlue,
	error: ANSI.boldRed,
	info: ANSI.boldGreen,
	warn: ANSI.boldYellow,
};

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(1, maxLength) - 1)}…`;
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

export function previewText(value: string, maxLength = DEFAULT_PREVIEW_LENGTH): string {
	return truncate(singleLine(value), Math.max(1, maxLength));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	if (value instanceof Error || value instanceof Date) return false;
	const proto = Object.getPrototypeOf(value) as object | null;
	return proto === Object.prototype || proto === null;
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

function normalizeFields(fields: unknown): LogFields {
	if (fields === undefined) return {};
	if (fields instanceof Error) {
		return { error: normalizeValue(fields, 0, new WeakSet()) };
	}
	if (!isPlainRecord(fields)) {
		return { detail: normalizeValue(fields, 0, new WeakSet()) };
	}
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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function pruneExpiredDailyLogFiles(
	dir: string,
	prefix: string,
	currentDate: string,
	retentionDays: number,
): void {
	const cutoffMs = Date.parse(`${currentDate}T00:00:00.000Z`) - retentionDays * 86_400_000;
	if (!Number.isFinite(cutoffMs)) return;
	const pattern = new RegExp(`^${escapeRegExp(prefix)}-(\\d{4}-\\d{2}-\\d{2})\\.log$`, "u");
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return;
	}
	for (const file of files) {
		const match = pattern.exec(file);
		if (!match?.[1]) continue;
		const fileDateMs = Date.parse(`${match[1]}T00:00:00.000Z`);
		if (Number.isFinite(fileDateMs) && fileDateMs <= cutoffMs) {
			try {
				rmSync(join(dir, file), { force: true });
			} catch {}
		}
	}
}

export function createDailyFileLogSink(options: DailyFileLogSinkOptions): DailyFileLogSink {
	const prefix = options.prefix ?? "tsukaima";
	let dirEnsured = false;
	let closed = false;
	let currentDate: string | undefined;
	let currentFilePath: string | undefined;

	return {
		currentPath: () => currentFilePath,
		close() {
			closed = true;
		},
		sink(entry: LogEntry) {
			if (closed) return;
			const date = entry.timestamp.slice(0, 10);
			if (date !== currentDate) {
				if (!dirEnsured) {
					mkdirSync(options.dir, { recursive: true });
					dirEnsured = true;
				}
				currentDate = date;
				currentFilePath = join(options.dir, `${prefix}-${date}.log`);
				if (options.retentionDays !== undefined && options.retentionDays > 0) {
					pruneExpiredDailyLogFiles(options.dir, prefix, date, options.retentionDays);
				}
			}
			if (currentFilePath === undefined) return;
			appendFileSync(currentFilePath, `${entry.text}\n`, "utf8");
		},
	};
}

export class LogBuffer {
	readonly #capacity: number;
	readonly #entries: LogEntry[] = [];
	readonly #subscribers = new Set<LogSubscriber>();
	#dropped = 0;
	#nextId = 1;

	constructor(capacity = DEFAULT_LOG_CAPACITY) {
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
		const buffer = options.buffer ?? new LogBuffer(options.capacity);
		const sinks = new Set<LogSink>();
		if (options.sinks !== undefined) {
			for (const sink of options.sinks) sinks.add(sink);
		} else if (options.sink !== undefined) {
			sinks.add(options.sink);
		} else {
			sinks.add(createConsoleSink(options.color));
		}
		const runtime: LoggerRuntime = {
			buffer,
			level: options.level ?? "info",
			sinks,
		};
		return new Logger(runtime, options.target ?? "tsukaima::server");
	}

	get buffer(): LogBuffer {
		return this.#runtime.buffer;
	}

	get level(): LogLevel {
		return this.#runtime.level;
	}

	get target(): string {
		return this.#target;
	}

	setLevel(level: LogLevel): void {
		this.#runtime.level = level;
	}

	addSink(sink: LogSink): () => void {
		this.#runtime.sinks.add(sink);
		return () => {
			this.#runtime.sinks.delete(sink);
		};
	}

	child(target: string, fields?: unknown): Logger {
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

	withFields(fields: unknown): Logger {
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

	span(name: string, fields?: unknown): Logger {
		return new Logger(this.#runtime, this.#target, this.#boundFields, {
			fields: normalizeFields(fields),
			name: singleLine(name),
		});
	}

	trace(message: string, fields?: unknown): void {
		this.#write("trace", message, fields);
	}

	debug(message: string, fields?: unknown): void {
		this.#write("debug", message, fields);
	}

	info(message: string, fields?: unknown): void {
		this.#write("info", message, fields);
	}

	warn(message: string, fields?: unknown): void {
		this.#write("warn", message, fields);
	}

	error(message: string, fields?: unknown): void {
		this.#write("error", message, fields);
	}

	#write(level: LogLevel, message: string, fields?: unknown): void {
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
		for (const sink of this.#runtime.sinks) {
			try {
				sink(entry);
			} catch {}
		}
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
		else if (entry.level === "debug" || entry.level === "trace") console.debug(line);
		else console.log(line);
	};
}

export function createLogger(options: LoggerOptions = {}): Logger {
	return Logger.create(options);
}
