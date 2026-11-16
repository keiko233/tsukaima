import {
	assertPermission,
	type PluginMediaApi,
	type PluginMediaRecord,
	type PluginMediaStoreInput,
} from "@tsukaima/sdk";
import type { MediaKind, MediaService, StoredMedia } from "./media-service.ts";

const MEDIA_KINDS: readonly MediaKind[] = ["image", "sticker", "audio", "video", "file"];

function mediaKind(value: PluginMediaStoreInput["kind"]): MediaKind {
	return MEDIA_KINDS.includes(value) ? value : "file";
}

/**
 * Secret-free projection of a canonical media row. `sourceUrl` and any blob path are omitted
 * so plugin code only receives stable identifiers and content metadata.
 */
function toRecord(media: StoredMedia): PluginMediaRecord {
	return {
		createdAt: media.createdAt,
		durationMs: media.durationMs,
		expiresAt: media.expiresAt,
		height: media.height,
		id: media.id,
		kind: media.kind,
		mimeType: media.mimeType,
		sha256: media.sha256,
		sizeBytes: media.sizeBytes,
		source: media.source,
		width: media.width,
	};
}

/**
 * Permission-checked facade over the host `MediaService`. The plugin never sees filesystem
 * paths, remote URLs, or raw credentials; every call is checked against its manifest grants.
 */
export function createPluginMediaBridge(
	media: MediaService,
	pluginId: string,
	grantedPermissions: readonly string[],
): PluginMediaApi {
	const requireRead = () => assertPermission(grantedPermissions, "media.read", pluginId);
	const requireWrite = () => assertPermission(grantedPermissions, "media.write", pluginId);
	return {
		async store(input) {
			requireWrite();
			const stored = await media.store({
				bytes: input.bytes,
				...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
				...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
				...(input.height === undefined ? {} : { height: input.height }),
				kind: mediaKind(input.kind),
				...(input.metadata === undefined ? {} : { metadata: input.metadata }),
				...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
				source: input.source ?? "webui",
				...(input.width === undefined ? {} : { width: input.width }),
			});
			return toRecord(stored);
		},
		async findById(mediaId) {
			requireRead();
			const stored = await media.findById(mediaId);
			return stored === undefined ? undefined : toRecord(stored);
		},
		async findBySha(sha256) {
			requireRead();
			const stored = await media.findBySha(sha256);
			return stored === undefined ? undefined : toRecord(stored);
		},
		async readBytes(mediaId) {
			requireRead();
			const stored = await media.findById(mediaId);
			if (stored === undefined) throw new Error("Media not found");
			return await media.readBytes(stored.sha256);
		},
	};
}
