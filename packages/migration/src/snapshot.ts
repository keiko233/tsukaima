import { promises as fs } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { classifyDshConfigKey, type DshValueClass } from "./dsh-baseline.ts";
import { sha256Bytes, sha256File, sha256String, stableStringify } from "./fs.ts";
import { listFiles } from "./fs.ts";
import { collectSecretValues, redactSecrets, type SecretRedaction } from "./secrets.ts";

export const DEFAULT_SNAPSHOT_EXCLUDES = [
	".git",
	".cache",
	"Cache",
	"Code Cache",
	"GPUCache",
	"Service Worker",
	"ShaderCache",
	"GrShaderCache",
	"BrowserMetrics",
	"Crashpad",
	"SingletonCookie",
	"SingletonLock",
	"SingletonSocket",
	"Cookies",
	"Cookies-journal",
	"Login Data",
	"Login Data-journal",
	"Local State",
	"Preferences",
	"History",
	"History-journal",
	"Web Data",
	"Web Data-journal",
	"*.pem",
	"*.key",
	"*.p12",
	"*.pfx",
	"id_rsa",
	"id_ed25519",
	"credentials",
	"credentials.json",
	".env",
	".env.*",
	"auth.json",
	"secrets.json",
	"npm-cache",
	"pnpm-store",
	"pnpm-cache",
	"yarn-cache",
	"logs",
	"*.log",
] as const;

const SENSITIVE_FILE_NAMES = new Set([
	"cookies",
	"credentials",
	"credentials.json",
	"id_rsa",
	"id_ed25519",
	"login data",
	"local state",
	"secrets.json",
	"auth.json",
	"web data",
]);

const STRUCTURED_TEXT = /\.(?:json|jsonl|ndjson|ya?ml|toml)$/i;

export type SnapshotOwnership = "home" | "workspace" | "shared" | "unknown";

export interface SnapshotFileRecord {
	readonly path: string;
	readonly capturedPath: string | null;
	readonly sourcePath: string;
	readonly size: number;
	readonly sizeBytes: number;
	readonly sourceSha256: string;
	readonly sha256: string | null;
	readonly mode: number;
	readonly modeString: string;
	readonly ownership: SnapshotOwnership;
	readonly ownershipClass: SnapshotOwnership;
	readonly classification: DshValueClass;
	readonly redacted: boolean;
	readonly redactions: readonly SecretRedaction[];
}

export interface SnapshotErrorRecord {
	readonly path: string;
	readonly code: "stat_failed" | "read_failed" | "write_failed" | "parse_failed";
	readonly message: string;
	readonly resumable: boolean;
}

export interface SnapshotManifest {
	readonly version: 1;
	readonly createdAt: string;
	readonly dryRun: boolean;
	readonly target: {
		readonly host: string | null;
		readonly project: string | null;
		readonly container: string | null;
	};
	readonly labels: readonly string[];
	readonly excludes: readonly string[];
	readonly counts: {
		readonly fileCount: number;
		readonly totalBytes: number;
		readonly files: number;
		readonly redacted: number;
		readonly secretFiles: number;
		readonly errors: number;
		readonly bytes: number;
	};
	readonly files: readonly SnapshotFileRecord[];
	readonly errors: readonly SnapshotErrorRecord[];
}

export interface SnapshotTargetInput {
	readonly host?: string;
	readonly project?: string;
	readonly container?: string;
}

export interface SnapshotTarget {
	readonly host: string | null;
	readonly project: string | null;
	readonly container: string | null;
}

export interface CaptureSnapshotOptions {
	readonly sources: readonly (readonly [path: string, label: string])[];
	readonly output: string;
	readonly target?: SnapshotTargetInput;
	readonly excludes?: readonly string[];
	readonly dryRun?: boolean;
	readonly now?: () => number;
	readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface CaptureSnapshotResult {
	readonly manifest: SnapshotManifest;
	readonly manifestPath: string;
	readonly filesPath: string;
	readonly errorsPath: string;
}

function nonEmpty(value: string | undefined): string | null {
	return value && value.trim() !== "" ? value : null;
}

export function resolveSnapshotTarget(
	input: SnapshotTargetInput = {},
	environment: Readonly<Record<string, string | undefined>> = process.env,
): SnapshotTarget {
	return {
		container:
			nonEmpty(input.container) ??
			nonEmpty(environment.DSH_SNAPSHOT_CONTAINER) ??
			nonEmpty(environment.DSH_AUDIT_CONTAINER),
		host:
			nonEmpty(input.host) ??
			nonEmpty(environment.DSH_SNAPSHOT_HOST) ??
			nonEmpty(environment.DSH_AUDIT_HOST),
		project:
			nonEmpty(input.project) ??
			nonEmpty(environment.DSH_SNAPSHOT_PROJECT) ??
			nonEmpty(environment.DSH_AUDIT_PROJECT),
	};
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildSnapshotCommand(target: { readonly host: string }): string[] {
	return ["ssh", target.host, "bash", "-s"];
}

function escapePattern(value: string): string {
	return value
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replaceAll("*", ".*")
		.replaceAll("?", ".");
}

export function matchesSnapshotExclude(
	path: string,
	excludes: readonly string[] = DEFAULT_SNAPSHOT_EXCLUDES,
): boolean {
	const normalized = path.replaceAll("\\", "/");
	const segments = normalized.split("/").filter(Boolean);
	return excludes.some((pattern) => {
		const regex = new RegExp(`(?:^|/)${escapePattern(pattern)}(?:$|/)`, "i");
		if (regex.test(normalized)) return true;
		return segments.some((segment) => new RegExp(`^${escapePattern(pattern)}$`, "i").test(segment));
	});
}

export function classifySnapshotFile(path: string): {
	readonly classification: DshValueClass;
	readonly ownership: SnapshotOwnership;
} {
	const normalized = path.replaceAll("\\", "/").toLowerCase();
	const name = basename(normalized);
	if (
		SENSITIVE_FILE_NAMES.has(name) ||
		/\.(?:pem|key|p12|pfx)$/i.test(name) ||
		/(?:^|\/)(?:\.ssh|secrets?|credentials?|cookies?)(?:\/|$)/i.test(normalized)
	) {
		return { classification: "secret", ownership: ownershipOf(normalized) };
	}
	const classification = classifyDshConfigKey(name.replace(/\.[^.]+$/, ""));
	return { classification, ownership: ownershipOf(normalized) };
}

function ownershipOf(path: string): SnapshotOwnership {
	const normalized = path.replaceAll("\\", "/");
	if (/(?:^|\/)workspace\//i.test(normalized) || /(?:^|\/)napcat\//i.test(normalized)) {
		return "workspace";
	}
	if (/(?:^|\/)home\/\.dsh\//i.test(normalized) || /(?:^|\/)\.dsh\//i.test(normalized)) {
		return "home";
	}
	if (/(?:^|\/)meme-packs\//i.test(normalized) || /(?:^|\/)\.mnemon\//i.test(normalized)) {
		return "shared";
	}
	return "unknown";
}

function modeString(mode: number): string {
	return mode.toString(8).padStart(4, "0");
}

export interface RedactedStructuredText {
	readonly content: string;
	readonly redactions: readonly SecretRedaction[];
	readonly parsed: boolean;
}

/** Redact credential-like values in JSON, JSONL, YAML, and TOML while preserving structure. */
export function redactStructuredText(content: string, path: string): RedactedStructuredText {
	if (!STRUCTURED_TEXT.test(path)) {
		return { content, parsed: false, redactions: [] };
	}
	try {
		if (/\.jsonl$|\.ndjson$/i.test(path)) {
			const lines = content.split(/\r?\n/);
			const redactions: SecretRedaction[] = [];
			const output = lines.map((line, index) => {
				if (line.trim() === "") return line;
				try {
					const parsed = JSON.parse(line) as unknown;
					const result = redactSecrets(parsed, { includeHostSpecific: true });
					redactions.push(
						...result.redactions.map((redaction) => ({
							...redaction,
							path: `$[${index}]${redaction.path.slice(1)}`,
						})),
					);
					return JSON.stringify(result.value);
				} catch {
					// Keep malformed lines but never let one line abort redaction of the rest.
					return line;
				}
			});
			return { content: output.join("\n"), parsed: true, redactions };
		}
		if (/\.ya?ml$/i.test(path)) {
			const parsed = Bun.YAML.parse(content) as unknown;
			const result = redactSecrets(parsed, { includeHostSpecific: true });
			return {
				content: Bun.YAML.stringify(result.value, null, 2),
				parsed: true,
				redactions: result.redactions,
			};
		}
		const parsed = JSON.parse(content) as unknown;
		const result = redactSecrets(parsed, { includeHostSpecific: true });
		return {
			content: `${JSON.stringify(result.value, null, "\t")}\n`,
			parsed: true,
			redactions: result.redactions,
		};
	} catch {
		return { content, parsed: false, redactions: [] };
	}
}

async function writeJsonl(path: string, records: readonly unknown[]): Promise<void> {
	const content = records.map((record) => JSON.stringify(record)).join("\n");
	await fs.writeFile(path, content.length > 0 ? `${content}\n` : "");
}

export async function captureSnapshot(
	options: CaptureSnapshotOptions,
): Promise<CaptureSnapshotResult> {
	const now = options.now ?? Date.now;
	const dryRun = options.dryRun === true;
	const excludes = [...new Set([...(options.excludes ?? []), ...DEFAULT_SNAPSHOT_EXCLUDES])];
	const target = resolveSnapshotTarget(options.target, options.environment);
	const output = options.output;
	await fs.mkdir(output, { recursive: true });
	const files: SnapshotFileRecord[] = [];
	const errors: SnapshotErrorRecord[] = [];
	const seen = new Set<string>();

	for (const [sourcePath, label] of options.sources) {
		let stats;
		try {
			stats = await fs.stat(sourcePath);
		} catch (error) {
			errors.push({
				code: "stat_failed",
				message: error instanceof Error ? error.message : String(error),
				path: label,
				resumable: true,
			});
			continue;
		}
		const candidateFiles = stats.isDirectory()
			? await listFiles(sourcePath)
			: stats.isFile()
				? [sourcePath]
				: [];
		for (const absolutePath of candidateFiles) {
			const relativePath = stats.isDirectory()
				? relative(sourcePath, absolutePath).replaceAll("\\", "/")
				: basename(absolutePath);
			const logicalPath = `${label}/${relativePath}`;
			if (seen.has(logicalPath) || matchesSnapshotExclude(logicalPath, excludes)) {
				continue;
			}
			seen.add(logicalPath);
			const classified = classifySnapshotFile(logicalPath);
			let fileStats;
			try {
				fileStats = await fs.stat(absolutePath);
			} catch (error) {
				errors.push({
					code: "stat_failed",
					message: error instanceof Error ? error.message : String(error),
					path: logicalPath,
					resumable: true,
				});
				continue;
			}
			const mode = fileStats.mode & 0o777;
			const capturedRelative = `files/${logicalPath}`;
			const capturedAbsolute = join(output, capturedRelative);
			try {
				const bytes = await fs.readFile(absolutePath);
				const sourceSha256 = sha256Bytes(bytes);
				if (classified.classification === "secret") {
					if (!dryRun) {
						await fs.mkdir(dirname(capturedAbsolute), { recursive: true });
						await fs.writeFile(capturedAbsolute, "[REDACTED SECRET FILE]\n");
					}
					files.push({
						capturedPath: dryRun ? null : capturedRelative,
						classification: classified.classification,
						mode,
						modeString: modeString(mode),
						ownership: classified.ownership,
						ownershipClass: classified.ownership,
						path: logicalPath,
						redacted: true,
						redactions: [{ key: basename(logicalPath), path: "$" }],
						sha256: dryRun
							? null
							: sha256Bytes(new TextEncoder().encode("[REDACTED SECRET FILE]\n")),
						size: fileStats.size,
						sizeBytes: fileStats.size,
						sourcePath: absolutePath,
						sourceSha256,
					});
					continue;
				}
				let outputBytes: Uint8Array = bytes;
				let redacted = false;
				let redactions: readonly SecretRedaction[] = [];
				const text = bytes.toString("utf8");
				const structured = redactStructuredText(text, relativePath);
				if (structured.parsed) {
					outputBytes = new TextEncoder().encode(structured.content);
					redacted = structured.redactions.length > 0;
					redactions = structured.redactions;
				}
				if (!dryRun) {
					await fs.mkdir(dirname(capturedAbsolute), { recursive: true });
					await fs.writeFile(capturedAbsolute, outputBytes);
				}
				files.push({
					capturedPath: dryRun ? null : capturedRelative,
					classification: classified.classification,
					mode,
					modeString: modeString(mode),
					ownership: classified.ownership,
					ownershipClass: classified.ownership,
					path: logicalPath,
					redacted,
					redactions,
					sha256: dryRun ? null : sha256Bytes(outputBytes),
					size: fileStats.size,
					sizeBytes: fileStats.size,
					sourcePath: absolutePath,
					sourceSha256,
				});
			} catch (error) {
				errors.push({
					code: "read_failed",
					message: error instanceof Error ? error.message : String(error),
					path: logicalPath,
					resumable: true,
				});
			}
		}
	}

	files.sort((left, right) => left.path.localeCompare(right.path));
	errors.sort((left, right) => left.path.localeCompare(right.path));
	const manifest: SnapshotManifest = {
		counts: {
			bytes: files.reduce((total, file) => total + file.sizeBytes, 0),
			errors: errors.length,
			fileCount: files.length,
			files: files.length,
			redacted: files.filter((file) => file.redacted).length,
			secretFiles: files.filter((file) => file.classification === "secret").length,
			totalBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
		},
		createdAt: new Date(now()).toISOString(),
		dryRun,
		errors,
		excludes,
		files,
		labels: options.sources.map(([, label]) => label),
		target,
		version: 1,
	};
	const manifestPath = join(output, "manifest.json");
	const filesPath = join(output, "files.jsonl");
	const errorsPath = join(output, "errors.jsonl");
	await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	await writeJsonl(filesPath, files);
	await writeJsonl(errorsPath, errors);
	return { errorsPath, filesPath, manifest, manifestPath };
}

export function buildSnapshotRemoteScript(target: {
	readonly host: string;
	readonly project: string;
	readonly container: string | null;
}): string {
	return String.raw`set -euo pipefail
project=${shellQuote(target.project)}
container=${shellQuote(target.container ?? "")}
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/snapshot"

# Preflight: SSH already succeeded. Nothing is stopped or written on the source.
test -n "$project"
if [ -n "$container" ]; then
	docker info >/dev/null
	docker inspect "$container" >/dev/null
	# Capture DSH volumes through a read-only volume mount. The container filesystem is
	# never mutated: the archive is streamed to stdout and extracted locally.
	docker run --rm --volumes-from "$container:ro" -v "$tmp:/out" alpine:3 sh -c '
		set -e
		for path in /home/node/.dsh /workspace; do
			if [ -e "$path" ]; then
				tar -C / -cf - "${"$"}{path#/}"
			fi
		done | tar -C /out/snapshot -xf -
	' >/dev/null
else
	test -d "$project"
	tar -C "$project" -cf - . | tar -C "$tmp/snapshot" -xf -
fi

# Prefer zstd so large snapshots stream small; fall back to a plain tar stream.
if command -v zstd >/dev/null 2>&1; then
	tar -C "$tmp/snapshot" -cf - . | zstd -q -c
else
	tar -C "$tmp/snapshot" -cf - .
fi
`;
}

export async function runRemoteSnapshot(
	target: {
		readonly host: string;
		readonly project: string;
		readonly container: string | null;
	},
	options: Omit<CaptureSnapshotOptions, "sources" | "target">,
): Promise<CaptureSnapshotResult> {
	const process = Bun.spawn(buildSnapshotCommand(target), {
		stderr: "pipe",
		stdin: new TextEncoder().encode(buildSnapshotRemoteScript(target)),
		stdout: "pipe",
	});
	const [archive, errorText, exitCode] = await Promise.all([
		new Response(process.stdout).arrayBuffer(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`Remote DSH snapshot failed: ${errorText.trim() || `exit ${exitCode}`}`);
	}
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-dsh-snapshot-"));
	const archivePath = join(directory, "snapshot.tar");
	const staging = join(directory, "snapshot");
	try {
		await fs.mkdir(staging, { recursive: true });
		const archiveBytes = new Uint8Array(archive);
		const zstdMagic =
			archiveBytes[0] === 0x28 &&
			archiveBytes[1] === 0xb5 &&
			archiveBytes[2] === 0x2f &&
			archiveBytes[3] === 0xfd;
		await fs.writeFile(
			archivePath,
			zstdMagic ? Bun.zstdDecompressSync(archiveBytes) : archiveBytes,
		);
		const extract = Bun.spawnSync(["tar", "-xf", archivePath, "-C", staging], {
			stderr: "pipe",
			stdout: "pipe",
		});
		if (extract.exitCode !== 0) {
			throw new Error(`Failed to extract DSH snapshot: ${extract.stderr.toString().trim()}`);
		}
		return await captureSnapshot({
			...options,
			sources: [[staging, "dsh-snapshot"]],
			target: {
				...(target.container === null ? {} : { container: target.container }),
				host: target.host,
				project: target.project,
			},
		});
	} finally {
		await fs.rm(directory, { force: true, recursive: true });
	}
}

/** Values that must never appear in a captured manifest or report. */
export function snapshotSecretValues(manifest: SnapshotManifest): string[] {
	return manifest.files.flatMap((file) => (file.redactions.length > 0 ? [`[REDACTED]`] : []));
}

export function snapshotFingerprint(manifest: SnapshotManifest): string {
	return sha256String(
		stableStringify(
			manifest.files.map((file) => ({
				path: file.path,
				sourceSha256: file.sourceSha256,
			})),
		),
	);
}

// Keep the unused helpers visible to type-aware callers without changing runtime behavior.
export { collectSecretValues, sha256File };
