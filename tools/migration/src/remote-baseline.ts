import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DshBaseline, extractDshBaseline } from "@tsukaima/migration";

export interface RemoteDshBaselineTarget {
	readonly host: string;
	readonly project: string;
	readonly container: string;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

// This script runs inside the DSH container with Node. It never copies raw
// configuration values, chat text, QQ identifiers, or binary assets: each file
// is reduced to a sanitized structural form before it is written to stdout.
const REMOTE_INSPECT_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const HOME = '/home/node/.dsh';
const WORKSPACE = '/workspace';
const files = new Map();
let tempCounter = 0;
let sqlite = null;
try {
	sqlite = require('node:sqlite');
} catch {
	sqlite = null;
}

function put(name, content) {
	files.set(name, Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'));
}

function exists(target) {
	try {
		fs.accessSync(target);
		return true;
	} catch {
		return false;
	}
}

function listDir(target) {
	try {
		return fs.readdirSync(target, { withFileTypes: true });
	} catch {
		return [];
	}
}

function readJson(target) {
	try {
		return JSON.parse(fs.readFileSync(target, 'utf8'));
	} catch {
		return null;
	}
}

function isRecord(value) {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringArray(value) {
	return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function sorted(values) {
	return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function walk(target, output) {
	for (const entry of listDir(target)) {
		const child = path.join(target, entry.name);
		if (entry.isDirectory()) {
			walk(child, output);
		} else if (entry.isFile()) {
			output.push(child);
		}
	}
	return output;
}

const NON_CREDENTIAL_KEYS = new Set([
	'hotkey',
	'hotkeys',
	'keyboard',
	'keyword',
	'keywords',
	'publickey',
	'triggerkeywords',
	'chatkey',
	'daykey',
	'sessionkey',
	'primarykey',
	'cachekey',
	'sortkey',
	'foreignkey',
]);
const CREDENTIAL_SEGMENTS = new Set([
	'auth',
	'authorization',
	'cookie',
	'credential',
	'credentials',
	'pass',
	'passphrase',
	'password',
	'passwd',
	'secret',
	'token',
]);
const IDENTIFYING_KEYS = new Set([
	'asker',
	'botqq',
	'adminusers',
	'personaoverrides',
	'qq',
	'userid',
	'groupid',
	'chatkey',
	'sessionkey',
]);

function keySegments(key) {
	return key
		.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

function isCredentialLikeKey(key) {
	const lower = key.toLowerCase();
	if (NON_CREDENTIAL_KEYS.has(lower)) {
		return false;
	}
	const segments = keySegments(key);
	if (segments.some((segment) => CREDENTIAL_SEGMENTS.has(segment))) {
		return true;
	}
	if (segments.includes('apikey')) {
		return true;
	}
	if (segments.some((segment, index) => segment === 'api' && segments[index + 1] === 'key')) {
		return true;
	}
	return segments.includes('key');
}

function isSensitiveKey(key) {
	const lower = key.toLowerCase();
	return isCredentialLikeKey(key) || IDENTIFYING_KEYS.has(lower);
}

function nextIndent(lines, start, indent) {
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (/^\s*(#|$)/.test(line)) {
			continue;
		}
		const match = /^(\s*)/.exec(line);
		return match ? match[1].length : 0;
	}
	return indent;
}

function sanitizeCordis(content) {
	const lines = content.split(/\r?\n/);
	const output = [];
	let suppressIndent = -1;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const indentMatch = /^(\s*)/.exec(line);
		const indent = indentMatch ? indentMatch[1].length : 0;
		if (suppressIndent >= 0) {
			if (line.trim() === '' || indent > suppressIndent) {
				continue;
			}
			suppressIndent = -1;
		}
		if (line.trim() === '' || line.trim().startsWith('#')) {
			output.push(line);
			continue;
		}
		const match =
			/^(\s*)((?:-\s+)+)?(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_$.-]+))\s*:(.*)$/.exec(line);
		if (!match) {
			output.push(line);
			continue;
		}
		const key = match[3] || match[4] || match[5];
		const rawValue = match[6] || '';
		const trimmed = rawValue.trim();
		if (!isSensitiveKey(key)) {
			output.push(line);
			continue;
		}
		const hasNestedValue = nextIndent(lines, index, indent) > indent;
		if (hasNestedValue) {
			output.push(line.slice(0, line.length - rawValue.length) + ' "[REDACTED]"');
			suppressIndent = indent;
			continue;
		}
		const unconfigured =
			trimmed === '' ||
			trimmed.startsWith('#') ||
			trimmed === '""' ||
			trimmed === "''" ||
			/^(null|~)$/i.test(trimmed.split(/\s+#/)[0].trim());
		output.push(line.slice(0, line.length - rawValue.length) + (unconfigured ? ' ""' : ' "[REDACTED]"'));
	}
	return output.join('\n');
}

const TIMING_FIELDS = new Set([
	'createdAt',
	'dueAt',
	'repeatEveryMs',
	'flexMs',
	'firedAt',
	'closedAt',
	'attempts',
	'maxAttempts',
	'fireCount',
	'cancelIfReplied',
	'kind',
]);
const SAFE_SCHEDULE_KEYS = new Set([
	'status',
	'unit',
	'enabled',
	'maxConcurrent',
	...TIMING_FIELDS,
]);

function redactedScalar(value) {
	return value === '' || value === null || value === undefined ? '' : '[REDACTED]';
}

function sanitizeSchedule(value) {
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeSchedule(item));
	}
	if (isRecord(value)) {
		const output = {};
		for (const [key, child] of Object.entries(value)) {
			const lower = key.toLowerCase();
			if (SAFE_SCHEDULE_KEYS.has(key)) {
				output[key] =
					Array.isArray(child) || isRecord(child) ? sanitizeSchedule(child) : child;
			} else if (lower === 'prompt' || lower === 'chatkey' || isSensitiveKey(key)) {
				output[key] = redactedScalar(child);
			} else if (Array.isArray(child) || isRecord(child)) {
				output[key] = sanitizeSchedule(child);
			} else if (typeof child === 'string') {
				output[key] = child === '' ? '' : '[REDACTED]';
			} else if (typeof child === 'number') {
				output[key] = 0;
			} else if (typeof child === 'boolean') {
				output[key] = false;
			} else {
				output[key] = null;
			}
		}
		return output;
	}
	return value === '' || value === null || value === undefined ? value : '[REDACTED]';
}

function sanitizePrimitive(value) {
	if (typeof value === 'string') {
		return value === '' ? '' : '[REDACTED]';
	}
	if (typeof value === 'number') {
		return 0;
	}
	if (typeof value === 'boolean') {
		return false;
	}
	return null;
}

function sanitizeRecord(value) {
	if (!isRecord(value)) {
		return sanitizePrimitive(value);
	}
	const output = {};
	for (const [key, child] of Object.entries(value)) {
		if (Array.isArray(child)) {
			output[key] = [];
		} else if (isRecord(child)) {
			output[key] = {};
		} else {
			output[key] = sanitizePrimitive(child);
		}
	}
	return output;
}

function sanitizeRuntime(value) {
	if (!isRecord(value)) {
		return sanitizePrimitive(value);
	}
	const output = {};
	for (const [key, child] of Object.entries(value)) {
		if (Array.isArray(child)) {
			output[key] = child.map((item) =>
				isRecord(item) ? sanitizeRecord(item) : sanitizePrimitive(item),
			);
		} else if (isRecord(child)) {
			output[key] = {};
		} else {
			output[key] = sanitizePrimitive(child);
		}
	}
	return output;
}

function sanitizeHumanProfiles(value) {
	if (!isRecord(value)) {
		return sanitizePrimitive(value);
	}
	const output = {};
	for (const [key, child] of Object.entries(value)) {
		if (key === 'profiles' && isRecord(child)) {
			const profiles = {};
			let index = 0;
			for (const profile of Object.values(child)) {
				index += 1;
				profiles['profile_' + index] = sanitizeRecord(profile);
			}
			output[key] = profiles;
		} else if (Array.isArray(child)) {
			output[key] = [];
		} else if (isRecord(child)) {
			output[key] = {};
		} else {
			output[key] = sanitizePrimitive(child);
		}
	}
	return output;
}

function sanitizeDocumentIndex(value) {
	const output = {};
	for (const [key, child] of Object.entries(value)) {
		if (Array.isArray(child)) {
			output[key] = [];
		} else if (isRecord(child)) {
			output[key] = {};
		} else {
			output[key] = sanitizePrimitive(child);
		}
	}
	return output;
}

function quoteSqlIdentifier(value) {
	return '"' + String(value).replace(/"/g, '""') + '"';
}

function sqliteTables(databasePath) {
	if (!sqlite || !exists(databasePath)) {
		return [];
	}
	let database = null;
	try {
		database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
		const tables = database
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all();
		return tables.map((table) => {
			const columns = database
				.prepare('PRAGMA table_info(' + quoteSqlIdentifier(table.name) + ')')
				.all();
			return { name: table.name, columns: columns.map((column) => column.name) };
		});
	} catch {
		return [];
	} finally {
		if (database) {
			try {
				database.close();
			} catch {
				// Best effort close.
			}
		}
	}
}

function sqliteRowCount(databasePath, tableName) {
	if (!sqlite || !exists(databasePath)) {
		return 0;
	}
	let database = null;
	try {
		database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
		const row = database
			.prepare('SELECT COUNT(*) AS count FROM ' + quoteSqlIdentifier(tableName))
			.get();
		return Number(row && row.count ? row.count : 0);
	} catch {
		return 0;
	} finally {
		if (database) {
			try {
				database.close();
			} catch {
				// Best effort close.
			}
		}
	}
}

function schemaOnlyDatabase(databasePath) {
	if (!sqlite || !exists(databasePath)) {
		return null;
	}
	let source = null;
	let tables = [];
	try {
		source = new sqlite.DatabaseSync(databasePath, { readOnly: true });
		tables = source
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL",
			)
			.all();
	} catch {
		tables = [];
	} finally {
		if (source) {
			try {
				source.close();
			} catch {
				// Best effort close.
			}
		}
	}
	if (tables.length === 0) {
		return null;
	}
	tempCounter += 1;
	const tempPath = path.join(
		os.tmpdir(),
		'tsukaima-audit-' + process.pid + '-' + tempCounter + '.db',
	);
	let target = null;
	try {
		target = new sqlite.DatabaseSync(tempPath);
		for (const table of tables) {
			try {
				target.exec(table.sql);
			} catch {
				// Skip a table definition this SQLite build cannot recreate.
			}
		}
		target.close();
		target = null;
		return fs.readFileSync(tempPath);
	} catch {
		return null;
	} finally {
		if (target) {
			try {
				target.close();
			} catch {
				// Best effort close.
			}
		}
		try {
			fs.unlinkSync(tempPath);
		} catch {
			// Best effort cleanup.
		}
	}
}

function inspectDeployment() {
	let cli = null;
	try {
		const version = execFileSync('dsh', ['--version'], {
			encoding: 'utf8',
			timeout: 5000,
		});
		const first = version.split(/\r?\n/)[0];
		cli = first && first.trim() !== '' ? first.trim() : null;
	} catch {
		cli = null;
	}
	return {
		image: process.env.DSH_IMAGE || null,
		cliVersion: cli,
	};
}

function inspectTools() {
	const roots = [
		path.join(WORKSPACE, 'work', 'dsh-napcat'),
		path.join(HOME, 'profiles', 'web', 'node_modules', 'dsh-napcat'),
	];
	const tools = new Set();
	for (const root of roots) {
		for (const file of walk(root, [])) {
			let stats = null;
			try {
				stats = fs.statSync(file);
			} catch {
				continue;
			}
			if (stats.size > 5 * 1024 * 1024) {
				continue;
			}
			let content = '';
			try {
				content = fs.readFileSync(file, 'utf8');
			} catch {
				continue;
			}
			const matches = content.match(/napcat_[a-z_]+/g);
			if (matches) {
				for (const match of matches) {
					if (!match.endsWith('_')) {
						tools.add(match);
					}
				}
			}
		}
	}
	return sorted(tools);
}

function inspectProfilePackage() {
	const record = readJson(path.join(HOME, 'profiles', 'web', 'package.json'));
	if (!isRecord(record)) {
		return;
	}
	const output = {
		name: typeof record.name === 'string' ? record.name : null,
		version: typeof record.version === 'string' ? record.version : null,
	};
	if (isRecord(record.dependencies)) {
		const dependencies = {};
		for (const [name, spec] of Object.entries(record.dependencies)) {
			if (typeof spec === 'string') {
				dependencies[name] = spec;
			}
		}
		output.dependencies = dependencies;
	}
	put(
		'home/.dsh/profiles/web/package.json',
		JSON.stringify(output, null, '\t') + '\n',
	);
}

function inspectInstalledPackages() {
	const nodeModules = path.join(HOME, 'profiles', 'web', 'node_modules');
	const packages = [];
	for (const entry of listDir(nodeModules)) {
		if (entry.name.startsWith('@')) {
			for (const child of listDir(path.join(nodeModules, entry.name))) {
				if (child.isDirectory() || child.isSymbolicLink()) {
					packages.push(path.join(entry.name, child.name));
				}
			}
		} else if (entry.isDirectory() || entry.isSymbolicLink()) {
			packages.push(entry.name);
		}
	}
	for (const packageName of packages) {
		const record = readJson(path.join(nodeModules, packageName, 'package.json'));
		if (
			!isRecord(record) ||
			typeof record.name !== 'string' ||
			typeof record.version !== 'string'
		) {
			continue;
		}
		put(
			'home/.dsh/profiles/web/node_modules/' + packageName + '/package.json',
			JSON.stringify({ name: record.name, version: record.version }, null, '\t') + '\n',
		);
	}
}

function inspectCordis() {
	try {
		const content = fs.readFileSync(
			path.join(HOME, 'profiles', 'web', 'cordis.patch.yml'),
			'utf8',
		);
		put('home/.dsh/profiles/web/cordis.patch.yml', sanitizeCordis(content));
	} catch {
		// The profile may not have an override file.
	}
}

function inspectSchedule(source, destination) {
	const record = readJson(source);
	if (record === null) {
		return;
	}
	put(destination, JSON.stringify(sanitizeSchedule(record), null, '\t') + '\n');
}

function sanitizeSpace(space) {
	if (
		space === 'dsh-host' ||
		space === 'napcat-group-<id>' ||
		space === 'napcat-private-<id>' ||
		space === 'workspace-<uuid>' ||
		space === 'custom-<space>'
	) {
		return space;
	}
	if (space.startsWith('napcat-group-')) {
		return 'napcat-group-<id>';
	}
	if (space.startsWith('napcat-private-')) {
		return 'napcat-private-<id>';
	}
	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	if (space.startsWith('workspace-') && uuid.test(space.slice('workspace-'.length))) {
		return 'workspace-<uuid>';
	}
	if (uuid.test(space)) {
		return 'workspace-<uuid>';
	}
	return 'custom-<space>';
}

function inspectMemePacks(root) {
	const packs = [];
	for (const entry of listDir(root)) {
		if (!entry.isDirectory()) {
			continue;
		}
		const directory = path.join(root, entry.name);
		const manifestValue = readJson(path.join(directory, 'manifest.json'));
		const manifest = isRecord(manifestValue) ? manifestValue : {};
		const indexDatabase = path.join(directory, 'index.db');
		const tables = sqliteTables(indexDatabase);
		const memesTable = tables.find((table) => table.name === 'memes');
		packs.push({
			id:
				typeof manifest.id === 'string' && manifest.id !== '' ? manifest.id : entry.name,
			name: typeof manifest.name === 'string' ? manifest.name : null,
			version: typeof manifest.version === 'string' ? manifest.version : null,
			manifestFields: sorted(Object.keys(manifest)),
			tables,
			fileCount: memesTable ? sqliteRowCount(indexDatabase, memesTable.name) : 0,
		});
		const safePack = entry.name.replace(/[^A-Za-z0-9._-]+/g, '-');
		const sanitizedManifest = {};
		for (const key of Object.keys(manifest)) {
			sanitizedManifest[key] =
				key === 'id' || key === 'name' || key === 'version' ? manifest[key] : null;
		}
		put(
			'workspace/.dsh/meme-packs/' + safePack + '/manifest.json',
			JSON.stringify(sanitizedManifest, null, '\t') + '\n',
		);
	}
	packs.sort((left, right) => left.id.localeCompare(right.id));
	return {
		packCount: packs.length,
		fileCount: packs.reduce((total, pack) => total + pack.fileCount, 0),
		schemaNames: sorted(packs.flatMap((pack) => pack.tables.map((table) => table.name))),
		manifestFields: sorted(packs.flatMap((pack) => pack.manifestFields)),
		packs,
	};
}

function inspectMemory(root) {
	const dataRoot = path.join(root, 'data');
	for (const entry of listDir(dataRoot)) {
		if (!entry.isDirectory()) {
			continue;
		}
		const databasePath = path.join(dataRoot, entry.name, 'mnemon.db');
		const tables = sqliteTables(databasePath);
		if (tables.length === 0) {
			continue;
		}
		const schemaOnly = schemaOnlyDatabase(databasePath);
		if (schemaOnly) {
			put(
				'workspace/.mnemon/data/' + sanitizeSpace(entry.name) + '/mnemon.db',
				schemaOnly,
			);
		}
	}
	const documents = readJson(path.join(root, 'documents', 'index.json'));
	if (isRecord(documents)) {
		put(
			'workspace/.mnemon/documents/index.json',
			JSON.stringify(sanitizeDocumentIndex(documents), null, '\t') + '\n',
		);
	}
	const runtime = readJson(path.join(root, 'runtime', 'memories.json'));
	if (isRecord(runtime)) {
		put(
			'workspace/.mnemon/runtime/memories.json',
			JSON.stringify(sanitizeRuntime(runtime), null, '\t') + '\n',
		);
	}
}

function inspectJsonl(source, destination) {
	try {
		const content = fs.readFileSync(source, 'utf8');
		const output = [];
		for (const line of content.split(/\r?\n/)) {
			if (line.trim() === '') {
				continue;
			}
			try {
				const record = JSON.parse(line);
				if (isRecord(record)) {
					output.push(JSON.stringify(sanitizeRecord(record)));
				}
			} catch {
				// Ignore an unparseable ledger line.
			}
		}
		put(destination, output.join('\n') + (output.length > 0 ? '\n' : ''));
	} catch {
		// The ledger may not exist.
	}
}

function inspectHumanProfiles(source, destination) {
	const record = readJson(source);
	if (isRecord(record)) {
		put(destination, JSON.stringify(sanitizeHumanProfiles(record), null, '\t') + '\n');
	}
}

function inspectSessions() {
	const root = path.join(HOME, 'sessions');
	const sessionFiles = walk(root, []).filter(
		(file) => /\.jsonl$/i.test(file) || /\.jsonl\.zstd$/i.test(file),
	);
	const workspaces = new Set();
	for (const file of sessionFiles) {
		const relativePath = path.relative(root, file).split(path.sep);
		if (relativePath.length > 1 && relativePath[0] !== '') {
			workspaces.add(relativePath[0]);
		}
	}
	const samples = sessionFiles
		.filter((file) => /session\.v4\.jsonl(?:\.zstd)?$/i.test(file))
		.sort()
		.slice(0, 25);
	const recordTypes = new Set();
	const sessionFields = new Set();
	const eventFields = new Set();
	const eventTypes = new Set();
	let sessionRecordCount = 0;
	let sampledFileCount = 0;
	let sampledBytes = 0;
	const maxSampleBytes = 32 * 1024 * 1024;
	for (const file of samples) {
		let stats = null;
		try {
			stats = fs.statSync(file);
		} catch {
			continue;
		}
		if (sampledBytes + stats.size > maxSampleBytes) {
			continue;
		}
		let content = '';
		try {
			if (/\.zstd$/i.test(file)) {
				if (typeof zlib.zstdDecompressSync !== 'function') {
					continue;
				}
				content = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8');
			} else {
				content = fs.readFileSync(file, 'utf8');
			}
		} catch {
			continue;
		}
		sampledFileCount += 1;
		sampledBytes += stats.size;
		for (const line of content.split(/\r?\n/)) {
			if (line.trim() === '') {
				continue;
			}
			let record = null;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			if (!isRecord(record) || typeof record.type !== 'string') {
				continue;
			}
			recordTypes.add(record.type);
			if (record.type === 'session') {
				sessionRecordCount += 1;
				for (const key of Object.keys(record)) {
					sessionFields.add(key);
				}
			} else {
				eventTypes.add(record.type);
				for (const key of Object.keys(record)) {
					eventFields.add(key);
				}
			}
		}
	}
	return {
		fileCount: sessionFiles.length,
		compressedFileCount: sessionFiles.filter((file) => /\.zstd$/i.test(file)).length,
		workspaceCount: workspaces.size,
		sessionRecordCount,
		recordTypes: sorted(recordTypes),
		sessionFields: sorted(sessionFields),
		eventFields: sorted(eventFields),
		eventTypes: sorted(eventTypes),
		sampledFileCount,
	};
}

function octal(value, length) {
	return value.toString(8).padStart(length - 1, '0') + '\0';
}

function writeString(buffer, value, offset, length) {
	Buffer.from(value, 'utf8').copy(buffer, offset, 0, length);
}

function tarHeader(name, size, type) {
	const header = Buffer.alloc(512, 0);
	let prefix = '';
	let fileName = name;
	if (Buffer.byteLength(fileName, 'utf8') > 100) {
		let index = fileName.lastIndexOf('/');
		while (
			index > 0 &&
			(Buffer.byteLength(fileName.slice(index + 1), 'utf8') > 100 ||
				Buffer.byteLength(fileName.slice(0, index), 'utf8') > 155)
		) {
			index = fileName.lastIndexOf('/', index - 1);
		}
		if (index > 0) {
			prefix = fileName.slice(0, index);
			fileName = fileName.slice(index + 1);
		}
	}
	writeString(header, fileName, 0, 100);
	writeString(header, octal(type === '5' ? 0o755 : 0o644, 8), 100, 8);
	writeString(header, octal(0, 8), 108, 8);
	writeString(header, octal(0, 8), 116, 8);
	writeString(header, octal(size, 12), 124, 12);
	writeString(header, octal(Math.floor(Date.now() / 1000), 12), 136, 12);
	for (let index = 148; index < 156; index += 1) {
		header[index] = 0x20;
	}
	header[156] = type.charCodeAt(0);
	writeString(header, 'ustar\0', 257, 6);
	writeString(header, '00', 263, 2);
	writeString(header, 'root', 265, 32);
	writeString(header, 'root', 297, 32);
	writeString(header, octal(0, 8), 329, 8);
	writeString(header, octal(0, 8), 337, 8);
	writeString(header, prefix, 345, 155);
	let checksum = 0;
	for (const byte of header) {
		checksum += byte;
	}
	writeString(header, checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
	return header;
}

function buildTar() {
	const chunks = [];
	const directories = new Set();
	for (const [name, content] of files) {
		const parts = name.split('/');
		parts.pop();
		let current = '';
		for (const part of parts) {
			current += part + '/';
			if (!directories.has(current)) {
				directories.add(current);
				chunks.push(tarHeader(current, 0, '5'));
			}
		}
		chunks.push(tarHeader(name, content.length, '0'));
		chunks.push(content);
		const padding = (512 - (content.length % 512)) % 512;
		if (padding > 0) {
			chunks.push(Buffer.alloc(padding));
		}
	}
	chunks.push(Buffer.alloc(1024));
	return Buffer.concat(chunks);
}

function main() {
	put(
		'audit/deployment.json',
		JSON.stringify(inspectDeployment(), null, '\t') + '\n',
	);
	put(
		'audit/tools.json',
		JSON.stringify({ napcatTools: inspectTools() }, null, '\t') + '\n',
	);
	inspectProfilePackage();
	inspectInstalledPackages();
	inspectCordis();
	inspectSchedule(
		path.join(HOME, 'storages', 'schedule.json'),
		'home/.dsh/storages/schedule.json',
	);
	inspectSchedule(
		path.join(WORKSPACE, 'napcat', 'schedule.json'),
		'workspace/napcat/schedule.json',
	);
	const memeRoot = ['/workspace/.dsh/meme-packs', '/workspace/meme-packs'].find(exists);
	if (memeRoot) {
		put(
			'audit/meme-packs.json',
			JSON.stringify(inspectMemePacks(memeRoot), null, '\t') + '\n',
		);
	} else {
		put(
			'audit/meme-packs.json',
			JSON.stringify(
				{ packCount: 0, fileCount: 0, schemaNames: [], manifestFields: [], packs: [] },
				null,
				'\t',
			) + '\n',
		);
	}
	const memoryRoot = ['/workspace/.mnemon', '/workspace/memory/.mnemon'].find(exists);
	if (memoryRoot) {
		inspectMemory(memoryRoot);
	}
	inspectJsonl(
		path.join(WORKSPACE, 'napcat', 'friend-requests.jsonl'),
		'workspace/napcat/friend-requests.jsonl',
	);
	inspectHumanProfiles(
		path.join(WORKSPACE, 'napcat', 'human-profiles.json'),
		'workspace/napcat/human-profiles.json',
	);
	inspectJsonl(
		path.join(WORKSPACE, 'napcat', 'qa-ledger.jsonl'),
		'workspace/napcat/qa-ledger.jsonl',
	);
	inspectJsonl(
		path.join(WORKSPACE, 'napcat', 'admin-audit.jsonl'),
		'workspace/napcat/admin-audit.jsonl',
	);
	put(
		'audit/sessions.json',
		JSON.stringify(inspectSessions(), null, '\t') + '\n',
	);
	process.stdout.write(buildTar());
}

try {
	main();
} catch (error) {
	process.stderr.write(String(error && error.stack ? error.stack : error) + '\n');
	process.exit(1);
}
`;

function remoteScript(target: RemoteDshBaselineTarget): string {
	return String.raw`set -euo pipefail
project=${shellQuote(target.project)}
container=${shellQuote(target.container)}
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

image="$(docker inspect --format '{{.Config.Image}}' "$container")"

cat > "$tmp/inspect.cjs" <<'__TSUKAIMA_DSH_INSPECT__'
${REMOTE_INSPECT_SCRIPT}
__TSUKAIMA_DSH_INSPECT__

docker exec -i -e DSH_IMAGE="$image" "$container" node --experimental-sqlite --no-warnings - < "$tmp/inspect.cjs" | tar -C "$tmp" -xf -
rm -f "$tmp/inspect.cjs"

# Keep the project directory in the contract so operators can point at an
# existing audit project, but the in-container inspector is the source of truth.
test -n "$project"

tar -C "$tmp" -cf - .
`;
}

export function buildRemoteAuditCommand(target: RemoteDshBaselineTarget): string[] {
	return ["ssh", target.host, "bash", "-s"];
}

export function buildRemoteAuditScript(target: RemoteDshBaselineTarget): string {
	return remoteScript(target);
}

export async function runRemoteDshBaseline(target: RemoteDshBaselineTarget): Promise<DshBaseline> {
	const process = Bun.spawn(buildRemoteAuditCommand(target), {
		stdin: new TextEncoder().encode(remoteScript(target)),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [archive, errorText, exitCode] = await Promise.all([
		new Response(process.stdout).arrayBuffer(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`Remote DSH audit failed: ${errorText.trim() || `exit ${exitCode}`}`);
	}
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-dsh-baseline-"));
	const snapshot = join(directory, "snapshot");
	const archivePath = join(directory, "audit.tar");
	try {
		await fs.mkdir(snapshot, { recursive: true });
		await fs.writeFile(archivePath, new Uint8Array(archive));
		const extract = Bun.spawnSync(["tar", "-xf", archivePath, "-C", snapshot], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (extract.exitCode !== 0) {
			throw new Error(`Failed to extract remote audit: ${extract.stderr.toString().trim()}`);
		}
		return await extractDshBaseline([[snapshot, "dsh-baseline"]], {
			target: {
				host: target.host,
				project: target.project,
				container: target.container,
			},
		});
	} finally {
		await fs.rm(directory, { force: true, recursive: true });
	}
}
