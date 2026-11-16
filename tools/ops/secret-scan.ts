#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";

export interface SecretFinding {
	readonly path: string;
	readonly line: number;
	readonly rule: string;
}

export interface PathAllowlistEntry {
	/** Repository-relative POSIX path or simple basename/glob such as `*.test.ts`. */
	readonly path: string;
	/** Human-readable reason shown only in documentation, never matched against file content. */
	readonly reason: string;
}

export interface ScanOptions {
	readonly root?: string;
	/** Explicit repository-relative paths; when absent, `git ls-files` supplies the list. */
	readonly files?: readonly string[];
	readonly pathAllowlist?: readonly PathAllowlistEntry[];
}

export interface ScanResult {
	readonly filesScanned: number;
	readonly findings: readonly SecretFinding[];
}

/**
 * Tracked paths that are intentionally allowed. Keep this list empty by default: inline
 * `secret-scan:allow` markers and runtime-constructed fixtures are safer than broad path
 * exemptions. Embedders may pass a documented list through `ScanOptions.pathAllowlist`.
 */
export const DEFAULT_PATH_ALLOWLIST: readonly PathAllowlistEntry[] = [];

const FORBIDDEN_FILES: readonly { readonly pattern: RegExp; readonly rule: string }[] = [
	{ pattern: /^\.env$/u, rule: "forbidden-sensitive-file:.env" },
	{ pattern: /^\.env\.(?!example$).+/u, rule: "forbidden-sensitive-file:env-variant" },
	{
		pattern: /\.(?:pem|key|p12|pfx|jks|keystore|sqlite|sqlite-wal|sqlite-shm)$/u,
		rule: "forbidden-sensitive-file:key-or-database",
	},
	{
		pattern: /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials|secrets)$/u,
		rule: "forbidden-sensitive-file:credential",
	},
];

const TOKEN_PATTERNS: readonly { readonly pattern: RegExp; readonly rule: string }[] = [
	{
		pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/u,
		rule: "private-key",
	},
	{ pattern: /\bAKIA[0-9A-Z]{16}\b/u, rule: "aws-access-key" },
	{ pattern: /\bASIA[0-9A-Z]{16}\b/u, rule: "aws-temporary-access-key" },
	{ pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/u, rule: "github-token" },
	{ pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u, rule: "github-fine-grained-token" },
	{ pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u, rule: "slack-token" },
	{ pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/u, rule: "anthropic-api-key" },
	{ pattern: /\bsk-(?:live|test)_[A-Za-z0-9]{16,}\b/u, rule: "stripe-secret-key" },
	{ pattern: /\bsk-[A-Za-z0-9]{20,}\b/u, rule: "openai-api-key" },
	{ pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/u, rule: "google-api-key" },
	{
		pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
		rule: "jwt",
	},
	{
		pattern: /\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/u,
		rule: "bearer-token",
	},
];

const CONNECTION_STRING_PATTERN =
	/\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|mssql):\/\/[^\s:@/]+:([^@\s/]+)@/giu;

const ASSIGNMENT_PATTERN =
	/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*(['"])([^'"]{8,})\1/giu;

const ENV_ASSIGNMENT_PATTERN =
	/^\s*(?:[A-Z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY)[A-Z0-9_]*)\s*=\s*([^\s#]{8,})\s*$/u;

const KNOWN_SECRET_ENV_PATTERN =
	/^\s*(?:TSUKAIMA_(?:ADMIN_PASSWORD|AUTH_SECRET|ONEBOT_ACCESS_TOKEN|OPENAI_API_KEY|SEMANTIC_API_KEY|TELEGRAM_BOT_TOKEN)|BETTER_AUTH_SECRET)\s*=\s*([^\s#]+)\s*$/u;

const DEPLOYMENT_SSH_TARGET_PATTERN = /\b(?:root|admin|deploy|ubuntu)@(?:\d{1,3}\.){3}\d{1,3}\b/u;

const ALLOW_MARKER = /secret-scan:allow\b/u;

const PLACEHOLDER_VALUES = new Set([
	"changeme",
	"change-me",
	"dummy",
	"example",
	"fake",
	"placeholder",
	"password",
	"passwd",
	"redacted",
	"sample",
	"secret",
	"test",
	"token",
	"xxx",
]);

function isPlaceholder(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	if (normalized.length === 0) return true;
	if (PLACEHOLDER_VALUES.has(normalized)) return true;
	if (
		/^(?:\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*|<[^>]+>|process\.env\.|env\.|your[-_])/u.test(
			normalized,
		)
	) {
		return true;
	}
	if (/^(?:\*+|x+|-+)$/u.test(normalized)) return true;
	return /example|placeholder|changeme|change-me|redacted|dummy|fake|sample/iu.test(normalized);
}

function entropy(value: string): number {
	const classes = new Set<CharacterClass>();
	for (const character of value) {
		if (/[a-z]/u.test(character)) classes.add("lower");
		else if (/[A-Z]/u.test(character)) classes.add("upper");
		else if (/[0-9]/u.test(character)) classes.add("digit");
		else classes.add("symbol");
	}
	return classes.size;
}

type CharacterClass = "digit" | "lower" | "symbol" | "upper";

function looksLikeSecret(value: string): boolean {
	const trimmed = value.trim();
	if (isPlaceholder(trimmed)) return false;
	if (trimmed.length < 16) return false;
	return entropy(trimmed) >= 3 || (entropy(trimmed) >= 2 && trimmed.length >= 32);
}

function globPattern(pattern: string): RegExp {
	const escaped = pattern
		.split("*")
		.map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`, "u");
}

function matchPathAllowlist(
	relativePath: string,
	allowlist: readonly PathAllowlistEntry[],
): boolean {
	return allowlist.some((entry) => globPattern(entry.path).test(relativePath));
}

function scanLine(path: string, line: number, text: string): SecretFinding[] {
	if (ALLOW_MARKER.test(text)) return [];
	const findings: SecretFinding[] = [];
	const add = (rule: string) => findings.push({ line, path, rule });
	for (const token of TOKEN_PATTERNS) {
		if (token.pattern.test(text)) add(token.rule);
	}
	if (DEPLOYMENT_SSH_TARGET_PATTERN.test(text)) add("deployment-ssh-target");
	for (const match of text.matchAll(CONNECTION_STRING_PATTERN)) {
		const password = match[1] ?? "";
		if (!isPlaceholder(password)) add("connection-string-with-password");
	}
	for (const match of text.matchAll(ASSIGNMENT_PATTERN)) {
		const value = match[2] ?? "";
		if (looksLikeSecret(value)) add("credential-assignment");
	}
	const env = ENV_ASSIGNMENT_PATTERN.exec(text);
	if (env !== null && looksLikeSecret(env[1] ?? "")) add("env-credential-assignment");
	const knownEnv = KNOWN_SECRET_ENV_PATTERN.exec(text);
	if (knownEnv !== null && !isPlaceholder(knownEnv[1] ?? "")) add("known-secret-env-assignment");
	return findings;
}

export function scanContent(
	path: string,
	content: string,
	pathAllowlist: readonly PathAllowlistEntry[] = DEFAULT_PATH_ALLOWLIST,
): SecretFinding[] {
	if (matchPathAllowlist(path, pathAllowlist)) return [];
	const name = basename(path);
	const findings: SecretFinding[] = [];
	for (const forbidden of FORBIDDEN_FILES) {
		if (forbidden.pattern.test(name)) {
			findings.push({ line: 1, path, rule: forbidden.rule });
		}
	}
	const lines = content.split(/\r?\n/u);
	for (const [index, line] of lines.entries()) {
		findings.push(...scanLine(path, index + 1, line));
	}
	return findings;
}

export function listTrackedFiles(root: string): string[] {
	const result = spawnSync("git", ["ls-files", "-z"], {
		cwd: root,
		encoding: "buffer",
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.status !== 0) {
		const message = result.stderr?.toString().trim() || "git ls-files failed";
		throw new Error(`Cannot list tracked files: ${message}`);
	}
	return result.stdout
		.toString()
		.split("\0")
		.filter((path) => path.length > 0);
}

export async function scanRepository(options: ScanOptions = {}): Promise<ScanResult> {
	const root = options.root ?? process.cwd();
	const files = options.files ?? listTrackedFiles(root);
	const allowlist = options.pathAllowlist ?? DEFAULT_PATH_ALLOWLIST;
	const findings: SecretFinding[] = [];
	let filesScanned = 0;
	for (const relativePath of files) {
		const absolutePath = join(root, relativePath);
		const stats = await fs.stat(absolutePath).catch(() => null);
		if (stats === null || !stats.isFile()) continue;
		const bytes = await fs.readFile(absolutePath);
		if (bytes.includes(0)) continue;
		filesScanned += 1;
		const content = bytes.toString("utf8");
		findings.push(...scanContent(relativePath.replaceAll("\\", "/"), content, allowlist));
	}
	return {
		filesScanned,
		findings: findings.toSorted(
			(left, right) =>
				left.path.localeCompare(right.path) ||
				left.line - right.line ||
				left.rule.localeCompare(right.rule),
		),
	};
}

export function formatFinding(finding: SecretFinding): string {
	return `${finding.path}:${finding.line} ${finding.rule}`;
}

export async function main(root = process.cwd()): Promise<number> {
	const result = await scanRepository({ root });
	if (result.findings.length === 0) {
		process.stdout.write(`Secret scan passed: ${result.filesScanned} tracked files\n`);
		return 0;
	}
	process.stderr.write(
		`Secret scan failed: ${result.findings.length} finding(s) in ${result.filesScanned} tracked files\n`,
	);
	for (const finding of result.findings) {
		process.stderr.write(`${formatFinding(finding)}\n`);
	}
	return 1;
}

if (import.meta.main) {
	process.exitCode = await main();
}
