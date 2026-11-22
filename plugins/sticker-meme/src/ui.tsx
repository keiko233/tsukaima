"use client";

import {
	Alert,
	Button,
	EmptyState,
	Field,
	Input,
	PluginPage,
	PluginSection,
	ProgressBar,
	Spinner,
	StatGrid,
	Switch,
	cn,
	definePluginUi,
	usePluginConfig,
	usePluginI18n,
	usePluginPanel,
	usePluginRpc,
	usePluginToast,
} from "@tsukaima/sdk/ui";
import {
	ChevronRight,
	Download,
	Pencil,
	RefreshCw,
	Save,
	Send,
	Sparkles,
	Trash2,
	Upload,
	X,
} from "lucide-react";
import pLimit from "p-limit";
import { pickBy } from "es-toolkit";
import { useEffect, useRef, useState } from "react";
import { i18n } from "./i18n.ts";
import { STICKER_MEME_PLUGIN_ID } from "./manifest.ts";

/** Browser-safe view of the fields this panel receives over plugin RPC. */
interface StickerPack {
	readonly id: string;
	readonly name: string;
	readonly source: string;
	readonly enabled: boolean;
	readonly tags: readonly string[];
	readonly personaIds: readonly string[];
	readonly metadata: Record<string, unknown>;
	readonly createdAt: string;
	readonly updatedAt: string;
}

interface StickerItem {
	readonly id: string;
	readonly packId: string;
	readonly name: string;
	readonly description: string;
	readonly keywords: readonly string[];
	readonly emotions: readonly string[];
	readonly mimeType: string;
	readonly mediaId: string;
	readonly hash: string;
	readonly width: number | null;
	readonly height: number | null;
	readonly enabled: boolean;
	readonly reviewStatus: string;
	readonly score: number;
	readonly semantic?: {
		readonly confidence: number;
		readonly labels: readonly string[];
		readonly source: string;
	};
	readonly useCount: number;
	readonly lastUsedAt: string | null;
	readonly sourceConversationId: string | null;
	readonly revokedAt: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

interface PackRow extends StickerPack {
	readonly itemCount: number;
}

interface ItemRow extends StickerItem {}

interface StatsRow {
	readonly approved: number;
	readonly items: number;
	readonly packs: number;
	readonly pending: number;
	readonly rejected: number;
	readonly revoked: number;
	readonly sends: number;
	readonly usage: number;
}

interface PreviewRow {
	readonly dataBase64: string;
	readonly mediaId: string;
	readonly mimeType: string;
}

interface ExportRow {
	readonly files: readonly { readonly dataBase64: string; readonly path: string }[];
	readonly manifest: Record<string, unknown>;
	readonly warnings?: readonly string[];
}

interface TelegramImportRow {
	readonly classified: number;
	readonly classifier: string;
	readonly deduped: number;
	readonly dryRun: boolean;
	readonly items: number;
	readonly missingMedia: number;
	readonly setName: string;
	readonly skipped: number;
	readonly title: string;
	readonly warnings: readonly string[];
}

interface UrlImportRow {
	readonly convertedFromVideo: boolean;
	readonly duplicate: boolean;
	readonly item: ItemRow;
	readonly originalMimeType: string;
	readonly pack: PackRow;
}

interface QqRecentMediaRow {
	readonly alreadyInLibrary: boolean;
	readonly channelId: string;
	readonly conversationId: string;
	readonly conversationTitle: string;
	readonly createdAt: string;
	readonly existingItemId?: string;
	readonly mediaId: string;
	readonly messageId: string;
	readonly mimeType: string;
	readonly partType: "image" | "sticker";
	readonly previewText?: string;
	readonly sha256?: string;
}

interface ReclassifyRow {
	readonly classifier: string;
	readonly skipped: number;
	readonly updated: number;
}

interface SemanticModelRow {
	readonly capabilities: readonly string[];
	readonly id: string;
	readonly input: readonly string[];
	readonly name: string;
	readonly pluginId?: string;
	readonly providerId: string;
	readonly supportsImage: boolean;
}

interface SemanticModelsResponse {
	readonly configuredCustom: boolean;
	readonly models: readonly SemanticModelRow[];
}

type JobKind =
	| "telegram.import"
	| "packs.importDir"
	| "packs.importBundle"
	| "packs.importDsh"
	| "semantic.reclassify";

type JobStage =
	| "fetching"
	| "downloading"
	| "converting"
	| "classifying"
	| "saving"
	| "done"
	| "error";

interface JobProgressRow {
	readonly classified: number;
	readonly current: number;
	readonly currentItem?: string;
	readonly dryRun: boolean;
	readonly error?: string;
	readonly finishedAt?: string;
	readonly id: string;
	readonly kind: JobKind;
	readonly packTitle?: string;
	readonly skipped: number;
	readonly stage: JobStage;
	readonly startedAt: string;
	readonly status: "running" | "completed" | "failed";
	readonly total: number | null;
	readonly updatedAt: string;
}

interface ProgressResponse {
	readonly active: JobProgressRow | null;
	readonly jobs?: readonly JobProgressRow[];
}

type SemanticMode = "auto" | "heuristic" | "vision";
type TelegramAnimatedFormat = "gif" | "thumbnail";
type TelegramVideoFormat = "gif" | "thumbnail";

const CUSTOM_MODEL_OPTION = "__custom__";

const encodeModelOption = (providerId: string, modelId: string): string =>
	providerId.length > 0 && modelId.length > 0 ? JSON.stringify([providerId, modelId]) : "";

const decodeModelOption = (
	value: string,
): { readonly modelId: string; readonly providerId: string } => {
	if (value.length === 0 || value === CUSTOM_MODEL_OPTION) {
		return { modelId: "", providerId: "" };
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
			return { modelId: parsed[1], providerId: parsed[0] };
		}
	} catch {}
	return { modelId: "", providerId: "" };
};

const rpcName = (method: string): string => `${STICKER_MEME_PLUGIN_ID}.${method}`;
const list = (value: string): string[] =>
	value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
const join = (values: readonly string[]): string => values.join(", ");
const clampWorkerCount = (value: string, fallback: number): number => {
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? Math.max(1, Math.min(16, parsed)) : fallback;
};
const telegramSetName = (pack: StickerPack): string | undefined => {
	const telegram = pack.metadata.telegram;
	if (typeof telegram !== "object" || telegram === null || Array.isArray(telegram))
		return undefined;
	const name = (telegram as Record<string, unknown>).name;
	return typeof name === "string" && name.length > 0 ? name : undefined;
};

function JobProgressCard({ job }: { job: JobProgressRow }) {
	const t = usePluginI18n();
	const stageLabel = t.t(`progress_stage_${job.stage}`);
	const progressLabel =
		job.currentItem === undefined || job.currentItem.length === 0
			? stageLabel
			: t.t("progress_item_status", { item: job.currentItem, stage: stageLabel });
	const countsLabel = t.t("progress_counts", {
		classified: String(job.classified),
		skipped: String(job.skipped),
	});
	const percent =
		job.total !== null && job.total > 0
			? Math.min(100, Math.round((job.current / job.total) * 100))
			: null;

	return (
		<div
			aria-live="polite"
			className="space-y-2 rounded-lg border border-border bg-background/60 p-3"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex min-w-0 items-center gap-2 text-xs font-medium">
					{job.status === "running" ? <Spinner /> : null}
					<span className="truncate">
						{job.packTitle === undefined || job.packTitle.length === 0
							? stageLabel
							: `${job.packTitle} · ${stageLabel}`}
					</span>
				</div>
				<div className="text-[11px] tabular-nums text-muted-foreground">
					{percent === null ? countsLabel : `${percent}% · ${countsLabel}`}
				</div>
			</div>
			{job.total !== null && job.total > 0 ? (
				<ProgressBar current={job.current} label={progressLabel} total={job.total} />
			) : (
				<div className="space-y-1.5">
					<div className="text-xs text-muted-foreground">{progressLabel}</div>
					<div
						aria-label={progressLabel}
						className="h-1.5 overflow-hidden rounded-full bg-muted"
						role="progressbar"
					>
						<div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
					</div>
				</div>
			)}
		</div>
	);
}

function StickerMediaPreview({
	alt,
	className,
	mimeType,
	preview,
}: {
	alt: string;
	className: string;
	mimeType: string;
	preview: string;
}) {
	const src = `data:${mimeType};base64,${preview}`;
	if (mimeType.toLowerCase().startsWith("video/")) {
		return <video aria-label={alt} autoPlay className={className} loop muted playsInline src={src} />;
	}
	return <img alt={alt} className={className} src={src} />;
}

function StickerInspector({
	item,
	onChanged,
	onClose,
	preview,
}: {
	item: ItemRow;
	onChanged: () => Promise<void>;
	onClose: () => void;
	preview?: string;
}) {
	const t = usePluginI18n();
	const rpc = usePluginRpc();
	const toast = usePluginToast();
	const [name, setName] = useState(item.name);
	const [description, setDescription] = useState(item.description);
	const [keywords, setKeywords] = useState(join(item.keywords));
	const [emotions, setEmotions] = useState(join(item.emotions));
	const [score, setScore] = useState(String(item.score));
	const [saving, setSaving] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [deleteArmed, setDeleteArmed] = useState(false);
	const missing = item.mediaId.length === 0 || item.revokedAt !== null;
	const save = async () => {
		setSaving(true);
		try {
			await rpc.call(rpcName("items.update"), {
				description,
				emotions: list(emotions),
				id: item.id,
				keywords: list(keywords),
				name,
				score: Number(score) || 0,
			});
			toast.success(t.t("save_success"));
			await onChanged();
		} catch (error) {
			toast.error(t.t("save_failed"), String(error));
		} finally {
			setSaving(false);
		}
	};
	const toggleEnabled = async () => {
		try {
			await rpc.call(rpcName("items.update"), { enabled: !item.enabled, id: item.id });
			await onChanged();
		} catch (error) {
			toast.error(t.t("save_failed"), String(error));
		}
	};
	const deleteItem = async () => {
		if (!deleteArmed) {
			setDeleteArmed(true);
			return;
		}
		setDeleting(true);
		try {
			await rpc.call(rpcName("items.delete"), { id: item.id });
			toast.success(t.t("item_delete_success"));
			onClose();
			await onChanged();
		} catch (error) {
			toast.error(t.t("item_delete_failed"), String(error));
		} finally {
			setDeleting(false);
		}
	};
	return (
		<div className="mt-3 space-y-3 rounded-xl border border-border bg-background/60 p-3">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="flex min-w-0 items-center gap-3">
					<div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border">
						{preview === undefined ? (
							<span className="text-[10px] text-muted-foreground">{t.t("item_preview")}</span>
						) : (
							<StickerMediaPreview
								alt={item.name}
								className="size-full object-contain"
								mimeType={item.mimeType}
								preview={preview}
							/>
						)}
					</div>
					<div className="min-w-0">
						<div className="truncate text-sm font-medium">{item.name}</div>
						<div className="text-[11px] text-muted-foreground">
							{t.t(`status_${item.reviewStatus}`)} ·{" "}
							{t.t("item_usage", { count: String(item.useCount) })} · {item.score}
						</div>
						{item.semantic === undefined || item.semantic.labels.length === 0 ? null : (
							<div className="mt-1 flex flex-wrap gap-1">
								{item.semantic.labels.slice(0, 6).map((label) => (
									<span
										key={label}
										className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
									>
										{label}
									</span>
								))}
							</div>
						)}
						{missing ? (
							<div className="text-[11px] text-warning">{t.t("status_missing")}</div>
						) : null}
					</div>
				</div>
				<div className="flex items-center gap-2">
					<Switch
						ariaLabel={t.t("item_enabled")}
						checked={item.enabled}
						onCheckedChange={() => void toggleEnabled()}
					/>
					<Button leadingIcon={<X />} size="xs" variant="ghost" onClick={onClose}>
						{t.t("close")}
					</Button>
				</div>
			</div>
			<div className="grid gap-2 sm:grid-cols-2">
				<Field label={t.t("item_name")}>
					<Input value={name} onChange={setName} />
				</Field>
				<Field label={t.t("item_description")}>
					<Input value={description} onChange={setDescription} />
				</Field>
				<Field label={t.t("item_keywords")}>
					<Input value={keywords} onChange={setKeywords} />
				</Field>
				<Field label={t.t("item_emotions")}>
					<Input value={emotions} onChange={setEmotions} />
				</Field>
				<Field label={t.t("item_score")}>
					<Input type="number" value={score} onChange={setScore} />
				</Field>
			</div>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<Button
					leadingIcon={<Trash2 />}
					loading={deleting}
					size="xs"
					variant="danger"
					onClick={() => void deleteItem()}
				>
					{deleteArmed ? t.t("item_delete_confirm") : t.t("item_delete")}
				</Button>
				<Button loading={saving} size="xs" variant="secondary" onClick={() => void save()}>
					{t.t("item_save")}
				</Button>
			</div>
		</div>
	);
}

function PackAccordion({
	items,
	onChanged,
	onLoadPreviews,
	pack,
	previewErrors,
	previews,
}: {
	items: readonly ItemRow[];
	onChanged: () => Promise<void>;
	onLoadPreviews: (items: readonly ItemRow[]) => Promise<void>;
	pack: PackRow;
	previewErrors: Record<string, boolean>;
	previews: Record<string, string>;
}) {
	const t = usePluginI18n();
	const rpc = usePluginRpc();
	const toast = usePluginToast();
	const [expanded, setExpanded] = useState(false);
	const [editing, setEditing] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [name, setName] = useState(pack.name);
	const [tags, setTags] = useState(join(pack.tags));
	const [personas, setPersonas] = useState(join(pack.personaIds));
	const [saving, setSaving] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const telegramName = telegramSetName(pack);
	const selected = items.find((item) => item.id === selectedId) ?? null;
	const toggle = () => {
		const next = !expanded;
		setExpanded(next);
		setSelectedId(null);
		setConfirmDelete(false);
	};
	useEffect(() => {
		if (expanded) void onLoadPreviews(items);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [expanded, items]);
	const save = async () => {
		setSaving(true);
		try {
			await rpc.call(rpcName("packs.save"), {
				enabled: pack.enabled,
				id: pack.id,
				name,
				personaIds: list(personas),
				source: pack.source,
				tags: list(tags),
			});
			toast.success(t.t("save_success"));
			setEditing(false);
			await onChanged();
		} catch (error) {
			toast.error(t.t("save_failed"), String(error));
		} finally {
			setSaving(false);
		}
	};
	/** First click arms the delete, the second click removes the whole pack. */
	const deletePack = async () => {
		if (!confirmDelete) {
			setConfirmDelete(true);
			return;
		}
		setDeleting(true);
		try {
			await rpc.call(rpcName("packs.delete"), { confirm: true, packId: pack.id });
			toast.success(t.t("delete_success"));
			await onChanged();
		} catch (error) {
			toast.error(t.t("delete_failed"), String(error));
			setConfirmDelete(false);
		} finally {
			setDeleting(false);
		}
	};
	return (
		<div className="rounded-xl border border-border bg-background/40">
			<div className="flex items-start gap-2 p-3">
				<button
					aria-expanded={expanded}
					className="flex min-w-0 flex-1 items-center gap-2 text-left"
					type="button"
					onClick={toggle}
				>
					<ChevronRight
						className={cn(
							"size-4 shrink-0 text-muted-foreground transition-transform",
							expanded && "rotate-90",
						)}
					/>
					<span className="min-w-0">
						<span className="block truncate text-sm font-medium">{pack.name}</span>
						<span className="block text-[11px] text-muted-foreground">
							{t.t(`source_${pack.source}`)} ·{" "}
							{t.t("pack_items", { count: String(pack.itemCount) })}
							{telegramName === undefined
								? ""
								: ` · ${t.t("telegram_pack_meta", { name: telegramName })}`}
						</span>
					</span>
				</button>
				<div className="flex shrink-0 items-center gap-1">
					<Button
						aria-label={confirmDelete ? t.t("pack_delete_confirm") : t.t("delete_pack")}
						disabled={deleting}
						leadingIcon={confirmDelete ? undefined : <Trash2 />}
						loading={deleting}
						size="xs"
						variant={confirmDelete ? "danger" : "ghost"}
						onClick={() => void deletePack()}
					>
						{confirmDelete ? t.t("pack_delete_confirm") : null}
					</Button>
					<Button
						aria-expanded={editing}
						leadingIcon={<Pencil />}
						size="xs"
						variant="ghost"
						onClick={() => {
							setConfirmDelete(false);
							setEditing(!editing);
						}}
					>
						{editing ? t.t("pack_edit_done") : t.t("edit")}
					</Button>
					<Switch
						ariaLabel={t.t("pack_enabled")}
						checked={pack.enabled}
						onCheckedChange={() => {
							void rpc
								.call(rpcName("packs.toggle"), { enabled: !pack.enabled, packId: pack.id })
								.then(onChanged)
								.catch((error: unknown) => toast.error(t.t("save_failed"), String(error)));
						}}
					/>
				</div>
			</div>
			{editing ? (
				<div className="space-y-2 border-t border-border p-3">
					<div className="grid gap-2 sm:grid-cols-3">
						<Field label={t.t("pack_name")}>
							<Input value={name} onChange={setName} />
						</Field>
						<Field label={t.t("pack_tags")}>
							<Input value={tags} onChange={setTags} />
						</Field>
						<Field label={t.t("pack_personas")}>
							<Input value={personas} onChange={setPersonas} />
						</Field>
					</div>
					<div className="flex justify-end">
						<Button loading={saving} leadingIcon={<Save />} size="xs" onClick={() => void save()}>
							{t.t("save_pack")}
						</Button>
					</div>
				</div>
			) : null}
			{expanded ? (
				<div className="space-y-3 border-t border-border p-3">
					{items.length === 0 ? (
						<div className="text-xs text-muted-foreground">{t.t("pack_items_empty")}</div>
					) : (
						<div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
							{items.map((item) => {
								const preview = previews[item.id];
								const missing = item.mediaId.length === 0 || item.revokedAt !== null;
								const isSelected = selectedId === item.id;
								return (
									<button
										key={item.id}
										aria-label={item.name}
										aria-pressed={isSelected}
										className={cn(
											"group relative aspect-square overflow-hidden rounded-lg border border-border bg-background/60 p-1 transition hover:border-primary/50",
											isSelected && "ring-2 ring-primary",
											!item.enabled && "opacity-50",
										)}
										type="button"
										onClick={() => setSelectedId(isSelected ? null : item.id)}
									>
										{preview === undefined ? (
											<span className="flex size-full items-center justify-center text-center text-[10px] text-muted-foreground">
												{previewErrors[item.id] ? t.t("preview_failed") : t.t("item_preview")}
											</span>
										) : (
											<StickerMediaPreview
												alt={item.name}
												className="size-full object-contain"
												mimeType={item.mimeType}
												preview={preview}
											/>
										)}
										{missing ? (
											<span className="absolute inset-x-0 bottom-0 bg-warning/20 px-1 text-center text-[9px] text-warning">
												{t.t("status_missing")}
											</span>
										) : null}
										{!item.enabled ? (
											<span className="absolute left-1 top-1 rounded bg-background/80 px-1 text-[9px] text-muted-foreground">
												{t.t("item_disabled_short")}
											</span>
										) : null}
									</button>
								);
							})}
						</div>
					)}
					{selected === null ? (
						<div className="text-[11px] text-muted-foreground">{t.t("sticker_edit_hint")}</div>
					) : (
						<StickerInspector
							key={selected.id}
							item={selected}
							preview={previews[selected.id]}
							onChanged={onChanged}
							onClose={() => setSelectedId(null)}
						/>
					)}
				</div>
			) : null}
		</div>
	);
}

function CandidateRow({
	candidate,
	onChanged,
}: {
	candidate: ItemRow;
	onChanged: () => Promise<void>;
}) {
	const t = usePluginI18n();
	const rpc = usePluginRpc();
	const toast = usePluginToast();
	const [reviewing, setReviewing] = useState<"approve" | "reject" | "delete" | null>(null);
	const review = async (action: "approve" | "reject" | "delete") => {
		setReviewing(action);
		try {
			await rpc.call(rpcName("candidates.review"), { action, id: candidate.id });
			toast.success(t.t("review_success"));
			await onChanged();
		} catch (error) {
			toast.error(t.t("review_failed"), String(error));
		} finally {
			setReviewing(null);
		}
	};
	return (
		<div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3 py-2">
			<div className="min-w-0">
				<div className="truncate text-sm font-medium">{candidate.name}</div>
				<div className="truncate text-[11px] text-muted-foreground">
					{candidate.description || candidate.mimeType}
					{candidate.sourceConversationId === null
						? ""
						: ` · ${t.t("candidate_source")}: ${candidate.sourceConversationId}`}
				</div>
				<div className="mt-1 flex flex-wrap gap-1">
					{candidate.keywords.map((keyword) => (
						<span
							key={keyword}
							className="rounded-full border border-border px-1.5 py-0.5 text-[10px]"
						>
							{keyword}
						</span>
					))}
					{candidate.emotions.map((emotion) => (
						<span
							key={emotion}
							className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
						>
							{emotion}
						</span>
					))}
				</div>
			</div>
			<div className="flex flex-wrap gap-1">
				<Button
					disabled={reviewing !== null && reviewing !== "approve"}
					loading={reviewing === "approve"}
					size="xs"
					onClick={() => void review("approve")}
				>
					{t.t("approve")}
				</Button>
				<Button
					disabled={reviewing !== null && reviewing !== "reject"}
					loading={reviewing === "reject"}
					size="xs"
					variant="secondary"
					onClick={() => void review("reject")}
				>
					{t.t("reject")}
				</Button>
				<Button
					disabled={reviewing !== null && reviewing !== "delete"}
					loading={reviewing === "delete"}
					size="xs"
					variant="ghost"
					onClick={() => void review("delete")}
				>
					{t.t("delete")}
				</Button>
			</div>
		</div>
	);
}

function StickerPanel() {
	const t = usePluginI18n();
	const rpc = usePluginRpc();
	const { plugin } = usePluginPanel();
	const config = usePluginConfig();
	const toast = usePluginToast();
	const [packs, setPacks] = useState<readonly PackRow[]>([]);
	const [items, setItems] = useState<readonly ItemRow[]>([]);
	const [candidates, setCandidates] = useState<readonly ItemRow[]>([]);
	const [stats, setStats] = useState<StatsRow | null>(null);
	const [previews, setPreviews] = useState<Record<string, string>>({});
	const [previewErrors, setPreviewErrors] = useState<Record<string, boolean>>({});
	const [directory, setDirectory] = useState("");
	const [bundle, setBundle] = useState("");
	const [exported, setExported] = useState("");
	const [dryRun, setDryRun] = useState(true);
	const [telegramUrl, setTelegramUrl] = useState("");
	const [telegramReport, setTelegramReport] = useState<TelegramImportRow | null>(null);
	const [telegramError, setTelegramError] = useState<string | null>(null);
	const [importingTelegram, setImportingTelegram] = useState(false);
	const [telegramAnimated, setTelegramAnimated] = useState(true);
	const [telegramAnimatedFormat, setTelegramAnimatedFormat] =
		useState<TelegramAnimatedFormat>("gif");
	const [telegramVideoFormat, setTelegramVideoFormat] = useState<TelegramVideoFormat>("gif");
	const [backgroundSemantic, setBackgroundSemantic] = useState(false);
	const configImportConcurrency =
		typeof config.value.importConcurrency === "number" ? config.value.importConcurrency : 4;
	const configSemanticConcurrency =
		typeof config.value.semanticConcurrency === "number" ? config.value.semanticConcurrency : 4;
	const [importConcurrency, setImportConcurrency] = useState(String(configImportConcurrency));
	const [semanticConcurrency, setSemanticConcurrency] = useState(String(configSemanticConcurrency));
	const [botToken, setBotToken] = useState("");
	const [savingToken, setSavingToken] = useState(false);
	const configMode = typeof config.value.semanticMode === "string" ? config.value.semanticMode : "";
	const configProviderId =
		typeof config.value.semanticProviderId === "string" ? config.value.semanticProviderId : "";
	const configModelId =
		typeof config.value.semanticModel === "string" ? config.value.semanticModel : "";
	const [semanticMode, setSemanticMode] = useState<SemanticMode>(
		configMode === "heuristic" || configMode === "auto" || configMode === "vision"
			? configMode
			: "auto",
	);
	const [availableModels, setAvailableModels] = useState<readonly SemanticModelRow[]>([]);
	const [configuredCustom, setConfiguredCustom] = useState(false);
	const [selectedModelChoice, setSelectedModelChoice] = useState<string>(() =>
		encodeModelOption(configProviderId, configModelId),
	);
	const [savingModel, setSavingModel] = useState(false);
	const [reclassifyPackId, setReclassifyPackId] = useState("");
	const [reclassifying, setReclassifying] = useState(false);
	const [reclassifySummary, setReclassifySummary] = useState<ReclassifyRow | null>(null);
	const [importingLegacy, setImportingLegacy] = useState<"dir" | "dsh" | "bundle" | null>(null);
	const [exporting, setExporting] = useState(false);
	const [loading, setLoading] = useState(false);
	const [jobs, setJobs] = useState<readonly JobProgressRow[]>([]);
	const [stickerUrl, setStickerUrl] = useState("");
	const [urlPackId, setUrlPackId] = useState("");
	const [urlName, setUrlName] = useState("");
	const [urlKeywords, setUrlKeywords] = useState("");
	const [urlEmotions, setUrlEmotions] = useState("");
	const [importingUrl, setImportingUrl] = useState(false);
	const [urlImportResult, setUrlImportResult] = useState<UrlImportRow | null>(null);
	const [urlImportError, setUrlImportError] = useState<string | null>(null);
	const [qqMedia, setQqMedia] = useState<readonly QqRecentMediaRow[]>([]);
	const [qqPreviews, setQqPreviews] = useState<Record<string, string>>({});
	const [loadingQqMedia, setLoadingQqMedia] = useState(false);
	const [qqStealPackId, setQqStealPackId] = useState("");
	const [stealingMediaId, setStealingMediaId] = useState<string | null>(null);
	const previewLoadingRef = useRef(new Set<string>());
	const inFlightRef = useRef(false);
	inFlightRef.current = importingTelegram || reclassifying || importingLegacy !== null;
	const wasBackgroundRunningRef = useRef(false);

	useEffect(() => {
		if (configMode === "heuristic" || configMode === "auto" || configMode === "vision") {
			setSemanticMode(configMode);
		}
		if (configProviderId.length > 0 && configModelId.length > 0) {
			setSelectedModelChoice(encodeModelOption(configProviderId, configModelId));
		} else if (configModelId.length > 0) {
			const matched = availableModels.find((candidate) => candidate.id === configModelId);
			if (matched !== undefined && !configuredCustom) {
				setSelectedModelChoice(encodeModelOption(matched.providerId, matched.id));
			} else if (configuredCustom) {
				setSelectedModelChoice(CUSTOM_MODEL_OPTION);
			}
		}
	}, [availableModels, configMode, configModelId, configProviderId, configuredCustom]);

	const refresh = async (): Promise<void> => {
		setLoading(true);
		try {
			const packResult = await rpc.call<{ packs: readonly PackRow[] }>(rpcName("packs.list"));
			const itemResult = await rpc.call<{ items: readonly ItemRow[] }>(rpcName("items.list"));
			const candidateResult = await rpc.call<{ items: readonly ItemRow[] }>(
				rpcName("candidates.list"),
			);
			const statsResult = await rpc.call<StatsRow>(rpcName("stats"));
			const modelsResult = await rpc
				.call<SemanticModelsResponse>(rpcName("semantic.models"))
				.catch(() => ({ configuredCustom: false, models: [] as readonly SemanticModelRow[] }));
			const progressResult = await rpc
				.call<ProgressResponse>(rpcName("progress"))
				.catch(() => ({ active: null, jobs: [] }));
			setPacks(packResult.packs);
			setItems(itemResult.items);
			setCandidates(candidateResult.items);
			setStats(statsResult);
			setAvailableModels(modelsResult.models ?? []);
			setConfiguredCustom(modelsResult.configuredCustom === true);
			const progressJobs =
				progressResult.jobs ?? (progressResult.active === null ? [] : [progressResult.active]);
			setJobs(progressJobs);
			if (progressJobs.some((job) => job.status === "running") && !inFlightRef.current) {
				wasBackgroundRunningRef.current = true;
			}
			setReclassifyPackId((current) =>
				packResult.packs.some((pack) => pack.id === current)
					? current
					: (packResult.packs[0]?.id ?? ""),
			);
			setPreviews((current) => {
				const ids = new Set(itemResult.items.map((item) => item.id));
				return pickBy(current, (_value, id) => ids.has(id)) as Record<string, string>;
			});
		} catch (error) {
			toast.error(t.t("load_failed"), String(error));
		} finally {
			setLoading(false);
		}
	};

	const loadQqMedia = async (): Promise<void> => {
		setLoadingQqMedia(true);
		try {
			const result = await rpc.call<{ items: readonly QqRecentMediaRow[] }>(
				rpcName("qq.recentMedia"),
				{ limit: 24 },
			);
			const mediaList = result.items ?? [];
			setQqMedia(mediaList);
			const limit = pLimit(4);
			const loaded: Record<string, string> = {};
			await Promise.all(
				mediaList.slice(0, 24).map(async (entry) => {
					if (qqPreviews[entry.mediaId] !== undefined) return;
					try {
						const preview = await limit(() =>
							rpc.call<PreviewRow>(rpcName("preview"), {
								mediaId: entry.mediaId,
								mimeType: entry.mimeType,
							}),
						);
						loaded[entry.mediaId] = preview.dataBase64;
					} catch {
						// Ignore individual preview errors
					}
				}),
			);
			if (Object.keys(loaded).length > 0) {
				setQqPreviews((current) => ({ ...current, ...loaded }));
			}
		} catch (error) {
			toast.error(t.t("load_failed"), String(error));
		} finally {
			setLoadingQqMedia(false);
		}
	};

	const importFromUrl = async (): Promise<void> => {
		setUrlImportResult(null);
		setUrlImportError(null);
		setImportingUrl(true);
		try {
			const report = await rpc.call<UrlImportRow>(rpcName("items.importUrl"), {
				...(urlEmotions.trim().length > 0 ? { emotions: urlEmotions.trim() } : {}),
				...(urlKeywords.trim().length > 0 ? { keywords: urlKeywords.trim() } : {}),
				...(urlName.trim().length > 0 ? { name: urlName.trim() } : {}),
				...(urlPackId.trim().length > 0 ? { packId: urlPackId.trim() } : {}),
				url: stickerUrl.trim(),
			});
			setUrlImportResult(report);
			setStickerUrl("");
			setUrlName("");
			setUrlKeywords("");
			setUrlEmotions("");
			toast.success(
				report.duplicate
					? t.t("url_import_duplicate", { name: report.item.name })
					: t.t("url_import_success", { name: report.item.name, pack: report.pack.name }),
			);
			await refresh();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setUrlImportError(message);
			toast.error(t.t("url_import_failed"), message);
		} finally {
			setImportingUrl(false);
		}
	};

	const stealFromQq = async (entry: QqRecentMediaRow): Promise<void> => {
		setStealingMediaId(entry.mediaId);
		try {
			const result = await rpc.call<{
				duplicate: boolean;
				item: ItemRow;
				pack: PackRow;
			}>(rpcName("qq.steal"), {
				conversationId: entry.conversationId,
				mediaId: entry.mediaId,
				mimeType: entry.mimeType,
				...(entry.previewText ? { name: entry.previewText } : {}),
				...(qqStealPackId.trim().length > 0 ? { packId: qqStealPackId.trim() } : {}),
				...(entry.sha256 ? { sha256: entry.sha256 } : {}),
			});
			toast.success(
				t.t("qq_steal_success", { name: result.item.name, pack: result.pack.name }),
			);
			await Promise.all([refresh(), loadQqMedia()]);
		} catch (error) {
			toast.error(t.t("qq_steal_failed"), error instanceof Error ? error.message : String(error));
		} finally {
			setStealingMediaId(null);
		}
	};

	useEffect(() => {
		void refresh();
		void loadQqMedia();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	/** Loads a pack's thumbnails on demand with a small bounded pool. */
	const loadPreviews = async (packItems: readonly ItemRow[]): Promise<void> => {
		const pending = packItems.filter(
			(item) =>
				item.mediaId.length > 0 &&
				previews[item.id] === undefined &&
				!previewLoadingRef.current.has(item.id),
		);
		if (pending.length === 0) return;
		const limit = pLimit(4);
		const loaded: Record<string, string> = {};
		const failed: Record<string, boolean> = {};
		await Promise.all(
			pending.map(async (item) => {
				previewLoadingRef.current.add(item.id);
				try {
					const preview = await limit(() =>
						rpc.call<PreviewRow>(rpcName("preview"), { itemId: item.id }),
					);
					loaded[item.id] = preview.dataBase64;
					failed[item.id] = false;
				} catch {
					failed[item.id] = true;
				} finally {
					previewLoadingRef.current.delete(item.id);
				}
			}),
		);
		if (Object.keys(loaded).length > 0) {
			setPreviews((current) => ({ ...current, ...loaded }));
		}
		if (Object.keys(failed).length > 0) {
			setPreviewErrors((current) => ({ ...current, ...failed }));
		}
	};

	const isJobRunning =
		importingTelegram ||
		reclassifying ||
		importingLegacy !== null ||
		jobs.some((job) => job.status === "running");

	useEffect(() => {
		if (!isJobRunning) return;
		let cancelled = false;
		let polling = false;
		const poll = async () => {
			if (cancelled || polling) return;
			polling = true;
			try {
				const result = await rpc.call<ProgressResponse>(rpcName("progress"));
				if (cancelled || result.active === null) return;
				const progressJobs = result.jobs ?? [result.active];
				setJobs(progressJobs);
				if (progressJobs.some((job) => job.status === "running")) {
					if (!inFlightRef.current) {
						wasBackgroundRunningRef.current = true;
					}
				} else if (wasBackgroundRunningRef.current) {
					wasBackgroundRunningRef.current = false;
					if (!result.active.dryRun) {
						void refresh();
					}
				}
			} catch {
			} finally {
				polling = false;
			}
		};
		void poll();
		const timer = setInterval(() => {
			void poll();
		}, 350);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isJobRunning]);

	const startOptimisticJob = (kind: JobKind, stage: JobStage): void => {
		const now = new Date().toISOString();
		setJobs((current) => [
			...current.filter((job) => job.id !== `pending-${kind}`),
			{
				classified: 0,
				current: 0,
				dryRun,
				id: `pending-${kind}`,
				kind,
				skipped: 0,
				stage,
				startedAt: now,
				status: "running",
				total: null,
				updatedAt: now,
			},
		]);
	};

	const tokenConfigured = config.secretsSet.includes("telegramBotToken");
	const saveToken = async () => {
		if (botToken.trim().length === 0) return;
		setSavingToken(true);
		try {
			await config.save({ telegramBotToken: botToken.trim() });
			setBotToken("");
			toast.success(t.t("telegram_token_saved"));
			await refresh();
		} catch (error) {
			toast.error(t.t("telegram_token_failed"), String(error));
		} finally {
			setSavingToken(false);
		}
	};
	const clearToken = async () => {
		setSavingToken(true);
		try {
			await config.save({ telegramBotToken: null });
			toast.success(t.t("telegram_token_cleared"));
			await refresh();
		} catch (error) {
			toast.error(t.t("telegram_token_failed"), String(error));
		} finally {
			setSavingToken(false);
		}
	};

	const classifierSelection = (): Record<string, string> => {
		if (selectedModelChoice === CUSTOM_MODEL_OPTION) {
			return { semanticProviderId: "" };
		}
		const { modelId, providerId } = decodeModelOption(selectedModelChoice);
		return { semanticModel: modelId, semanticProviderId: providerId };
	};

	const saveModelSettings = async () => {
		setSavingModel(true);
		try {
			if (selectedModelChoice === CUSTOM_MODEL_OPTION) {
				await config.save({
					semanticMode,
					semanticProviderId: null,
				});
			} else {
				const { modelId, providerId } = decodeModelOption(selectedModelChoice);
				await config.save({
					semanticMode,
					semanticModel: modelId.length === 0 ? null : modelId,
					semanticProviderId: providerId.length === 0 ? null : providerId,
				});
			}
			toast.success(t.t("semantic_model_saved"));
			await refresh();
		} catch (error) {
			toast.error(t.t("semantic_model_save_failed"), String(error));
		} finally {
			setSavingModel(false);
		}
	};

	const syncJobProgress = async (kind: JobKind, errorMessage?: string): Promise<void> => {
		const latest = await rpc.call<ProgressResponse>(rpcName("progress")).catch(() => null);
		const serverJobs =
			latest === null ? [] : (latest.jobs ?? (latest.active === null ? [] : [latest.active]));
		setJobs((current): readonly JobProgressRow[] => {
			const base = latest === null ? current : serverJobs;
			if (errorMessage === undefined) return base;
			return base.map((job) =>
				job.kind === kind && job.status === "running"
					? {
							...job,
							error: errorMessage,
							stage: "error" as const,
							status: "failed" as const,
							updatedAt: new Date().toISOString(),
						}
					: job,
			);
		});
	};

	const importTelegram = async () => {
		setTelegramReport(null);
		setTelegramError(null);
		setImportingTelegram(true);
		startOptimisticJob("telegram.import", "fetching");
		try {
			const report = await rpc.call<TelegramImportRow>(rpcName("telegram.import"), {
				animatedFormat: telegramAnimatedFormat,
				deferSemantic: backgroundSemantic,
				dryRun: false,
				includeAnimated: telegramAnimated,
				includeVideo: telegramAnimated,
				semanticMode,
				...classifierSelection(),
				...workerArgs(),
				url: telegramUrl,
				videoFormat: telegramVideoFormat,
			});
			setTelegramReport(report);
			toast.success(
				t.t("import_success"),
				t.t("telegram_import_result", {
					classified: String(report.classified),
					items: String(report.items),
					skipped: String(report.skipped),
					title: report.title,
				}),
			);
			await syncJobProgress("telegram.import");
			await refresh();
		} catch (error) {
			const message = String(error);
			setTelegramError(message);
			await syncJobProgress("telegram.import", message);
			toast.error(t.t("telegram_import_failed"), message);
		} finally {
			setImportingTelegram(false);
		}
	};

	const reclassify = async () => {
		setReclassifying(true);
		setReclassifySummary(null);
		startOptimisticJob("semantic.reclassify", "classifying");
		try {
			const result = await rpc.call<ReclassifyRow>(rpcName("semantic.reclassify"), {
				mode: semanticMode,
				...classifierSelection(),
				packId: reclassifyPackId,
				semanticConcurrency: clampWorkerCount(semanticConcurrency, 4),
			});
			setReclassifySummary(result);
			toast.success(
				t.t("semantic_reclassify_success"),
				t.t("semantic_reclassify_result", {
					skipped: String(result.skipped),
					updated: String(result.updated),
				}),
			);
			await syncJobProgress("semantic.reclassify");
			await refresh();
		} catch (error) {
			const message = String(error);
			await syncJobProgress("semantic.reclassify", message);
			toast.error(t.t("semantic_reclassify_failed"), message);
		} finally {
			setReclassifying(false);
		}
	};

	const importDirectory = async () => {
		setImportingLegacy("dir");
		startOptimisticJob("packs.importDir", "fetching");
		try {
			const report = await rpc.call<{
				deduped: number;
				items: number;
				missingMedia: number;
			}>(rpcName("packs.importDir"), {
				directory,
				dryRun,
				semanticMode,
				...classifierSelection(),
				...workerArgs(),
			});
			toast.success(
				t.t("import_success"),
				t.t("import_result", {
					deduped: String(report.deduped),
					items: String(report.items),
					missing: String(report.missingMedia),
				}),
			);
			await syncJobProgress("packs.importDir");
			if (!dryRun) await refresh();
		} catch (error) {
			const message = String(error);
			await syncJobProgress("packs.importDir", message);
			toast.error(t.t("import_failed"), message);
		} finally {
			setImportingLegacy(null);
		}
	};

	const importDsh = async () => {
		setImportingLegacy("dsh");
		startOptimisticJob("packs.importDsh", "fetching");
		try {
			const report = await rpc.call<{
				deduped: number;
				items: number;
				missingMedia: number;
			}>(rpcName("packs.importDsh"), {
				directory,
				dryRun,
				semanticMode,
				...classifierSelection(),
				...workerArgs(),
			});
			toast.success(
				t.t("import_success"),
				t.t("import_result", {
					deduped: String(report.deduped),
					items: String(report.items),
					missing: String(report.missingMedia),
				}),
			);
			await syncJobProgress("packs.importDsh");
			if (!dryRun) await refresh();
		} catch (error) {
			const message = String(error);
			await syncJobProgress("packs.importDsh", message);
			toast.error(t.t("import_failed"), message);
		} finally {
			setImportingLegacy(null);
		}
	};

	const importBundle = async () => {
		setImportingLegacy("bundle");
		startOptimisticJob("packs.importBundle", "fetching");
		try {
			const parsed = JSON.parse(bundle) as Record<string, unknown>;
			const report = await rpc.call<{
				deduped: number;
				items: number;
				missingMedia: number;
			}>(rpcName("packs.importBundle"), {
				...parsed,
				dryRun,
				semanticMode,
				...classifierSelection(),
				...workerArgs(),
			});
			toast.success(
				t.t("import_success"),
				t.t("import_result", {
					deduped: String(report.deduped),
					items: String(report.items),
					missing: String(report.missingMedia),
				}),
			);
			await syncJobProgress("packs.importBundle");
			if (!dryRun) await refresh();
		} catch (error) {
			const message = String(error);
			await syncJobProgress("packs.importBundle", message);
			toast.error(t.t("import_failed"), message);
		} finally {
			setImportingLegacy(null);
		}
	};

	const exportBundle = async () => {
		setExporting(true);
		try {
			const result = await rpc.call<ExportRow>(rpcName("packs.export"), {});
			setExported(JSON.stringify(result, null, 2));
		} catch (error) {
			toast.error(t.t("save_failed"), String(error));
		} finally {
			setExporting(false);
		}
	};

	const decodedChoice = decodeModelOption(selectedModelChoice);
	const selectedModelInCatalog =
		selectedModelChoice.length === 0 ||
		selectedModelChoice === CUSTOM_MODEL_OPTION ||
		availableModels.some(
			(model) =>
				model.providerId === decodedChoice.providerId && model.id === decodedChoice.modelId,
		);
	const modelSelectOptions = (
		<>
			<option value="">{t.t("semantic_model_auto")}</option>
			{configuredCustom && configModelId.length > 0 ? (
				<option value={CUSTOM_MODEL_OPTION}>
					{t.t("semantic_model_custom", { model: configModelId })}
				</option>
			) : null}
			{!selectedModelInCatalog && decodedChoice.modelId.length > 0 ? (
				<option value={selectedModelChoice}>
					{decodedChoice.modelId} ({decodedChoice.providerId})
				</option>
			) : null}
			{availableModels.map((model) => {
				const value = encodeModelOption(model.providerId, model.id);
				const tag = model.supportsImage
					? t.t("semantic_model_vision_tag")
					: t.t("semantic_model_text_tag");
				return (
					<option key={value} value={value}>
						{model.name} ({model.providerId} · {tag})
					</option>
				);
			})}
		</>
	);

	const latestJob = (kinds: readonly JobKind[]): JobProgressRow | null => {
		// `jobs` arrives newest first from the tracker, so the first match is the latest run.
		const matching = jobs.filter((job) => kinds.includes(job.kind));
		return matching.find((job) => job.status === "running") ?? matching[0] ?? null;
	};
	const telegramProgress = latestJob(["telegram.import"]);
	const telegramBusy = importingTelegram || telegramProgress?.status === "running";
	const telegramFailureMessage =
		telegramError ??
		(telegramProgress?.status === "failed"
			? (telegramProgress.error ?? t.t("telegram_import_failed"))
			: null);
	const reclassifyProgress = latestJob(["semantic.reclassify"]);
	const reclassifyBusy = reclassifying || reclassifyProgress?.status === "running";
	const legacyProgress = latestJob(["packs.importDir", "packs.importBundle", "packs.importDsh"]);
	const legacyBusy = importingLegacy !== null || legacyProgress?.status === "running";
	const workerArgs = (): Record<string, number> => ({
		importConcurrency: clampWorkerCount(importConcurrency, 4),
		semanticConcurrency: clampWorkerCount(semanticConcurrency, 4),
	});

	return (
		<PluginPage
			actions={
				<Button
					disabled={loading}
					leadingIcon={<RefreshCw />}
					loading={loading}
					size="sm"
					variant="secondary"
					onClick={() => void refresh()}
				>
					{t.t("refresh")}
				</Button>
			}
			description={t.t("description")}
			title={t.t("title")}
		>
			{loading && stats === null ? (
				<div className="flex items-center rounded-lg border border-border bg-background/60 px-3 py-2">
					<Spinner label={t.t("loading_library")} />
				</div>
			) : null}

			<PluginSection title={t.t("stats")}>
				<StatGrid
					items={[
						{ label: t.t("stats_packs"), value: stats?.packs ?? 0 },
						{ label: t.t("stats_items"), value: stats?.items ?? 0 },
						{ label: t.t("stats_pending"), value: stats?.pending ?? 0 },
						{ label: t.t("stats_usage"), value: stats?.usage ?? 0 },
					]}
				/>
			</PluginSection>

			<PluginSection
				description={t.t("telegram_credentials_hint")}
				title={t.t("telegram_credentials")}
			>
				<div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
					<Field label={t.t("telegram_bot_token")}>
						<Input
							placeholder={
								tokenConfigured
									? t.t("telegram_token_placeholder_configured")
									: t.t("telegram_token_placeholder_unset")
							}
							type="password"
							value={botToken}
							onChange={setBotToken}
						/>
					</Field>
					<div className="flex flex-wrap gap-2">
						<Button
							disabled={savingToken || botToken.trim().length === 0}
							leadingIcon={<Save />}
							loading={savingToken}
							size="sm"
							onClick={() => void saveToken()}
						>
							{t.t("telegram_token_save")}
						</Button>
						<Button
							disabled={savingToken || !tokenConfigured}
							loading={savingToken}
							size="sm"
							variant="ghost"
							onClick={() => void clearToken()}
						>
							{t.t("telegram_token_clear")}
						</Button>
					</div>
				</div>
				<div className="mt-2 text-[11px] text-muted-foreground">
					{tokenConfigured
						? t.t("telegram_token_status_configured")
						: t.t("telegram_token_status_unset")}
				</div>
			</PluginSection>

			<PluginSection description={t.t("telegram_hint")} title={t.t("telegram_import")}>
				<div className="space-y-3">
					<Field label={t.t("telegram_url")}>
						<Input
							placeholder={t.t("telegram_url_placeholder")}
							value={telegramUrl}
							onChange={setTelegramUrl}
						/>
					</Field>
					<div className="flex flex-wrap items-center gap-4">
						<label className="flex items-center gap-2 text-xs">
							<Switch
								ariaLabel={t.t("import_dry_run")}
								checked={dryRun}
								onCheckedChange={setDryRun}
							/>
							{t.t("import_dry_run")}
						</label>
						<label className="flex items-center gap-2 text-xs">
							<Switch
								ariaLabel={t.t("telegram_include_animated")}
								checked={telegramAnimated}
								onCheckedChange={setTelegramAnimated}
							/>
							{t.t("telegram_include_animated")}
						</label>
						<Field label={t.t("telegram_animated_format")}>
							<select
								className="h-9 rounded-md border border-border bg-background px-2 text-sm"
								value={telegramAnimatedFormat}
								onChange={(event) =>
									setTelegramAnimatedFormat(event.target.value as TelegramAnimatedFormat)
								}
							>
								<option value="gif">{t.t("telegram_animated_gif")}</option>
								<option value="thumbnail">{t.t("telegram_animated_thumbnail")}</option>
							</select>
						</Field>
						<Field label={t.t("telegram_video_format")}>
							<select
								className="h-9 rounded-md border border-border bg-background px-2 text-sm"
								value={telegramVideoFormat}
								onChange={(event) =>
									setTelegramVideoFormat(event.target.value as TelegramVideoFormat)
								}
							>
								<option value="gif">{t.t("telegram_video_gif")}</option>
								<option value="thumbnail">{t.t("telegram_video_thumbnail")}</option>
							</select>
						</Field>
						<Field label={t.t("semantic_mode")}>
							<select
								className="h-9 rounded-md border border-border bg-background px-2 text-sm"
								value={semanticMode}
								onChange={(event) => setSemanticMode(event.target.value as SemanticMode)}
							>
								<option value="heuristic">{t.t("semantic_mode_heuristic")}</option>
								<option value="auto">{t.t("semantic_mode_auto")}</option>
								<option value="vision">{t.t("semantic_mode_vision")}</option>
							</select>
						</Field>
						<Field label={t.t("semantic_model")}>
							<select
								className="h-9 min-w-52 rounded-md border border-border bg-background px-2 text-sm"
								value={selectedModelChoice}
								onChange={(event) => setSelectedModelChoice(event.target.value)}
							>
								{modelSelectOptions}
							</select>
						</Field>
						<Field label={t.t("import_concurrency")}>
							<Input
								max={16}
								min={1}
								type="number"
								value={importConcurrency}
								onChange={setImportConcurrency}
							/>
						</Field>
						<Field label={t.t("semantic_concurrency")}>
							<Input
								max={16}
								min={1}
								type="number"
								value={semanticConcurrency}
								onChange={setSemanticConcurrency}
							/>
						</Field>
						<label className="flex items-center gap-2 text-xs">
							<Switch
								ariaLabel={t.t("telegram_background_semantic")}
								checked={backgroundSemantic}
								onCheckedChange={setBackgroundSemantic}
							/>
							{t.t("telegram_background_semantic")}
						</label>
					</div>
					<Button
						disabled={telegramBusy || telegramUrl.trim().length === 0}
						leadingIcon={<Send />}
						loading={telegramBusy}
						size="sm"
						onClick={() => void importTelegram()}
					>
						{telegramBusy ? t.t("telegram_importing") : t.t("telegram_import_run")}
					</Button>
					{telegramProgress !== null && telegramProgress.status === "running" ? (
						<JobProgressCard job={telegramProgress} />
					) : null}
					{telegramFailureMessage === null ? null : (
						<Alert tone="danger">{telegramFailureMessage}</Alert>
					)}
					{telegramReport === null ? null : (
						<Alert tone={telegramReport.warnings.length > 0 ? "warning" : "info"}>
							{t.t("telegram_import_result", {
								classified: String(telegramReport.classified),
								items: String(telegramReport.items),
								skipped: String(telegramReport.skipped),
								title: telegramReport.title,
							})}
							{telegramReport.warnings.length === 0
								? ""
								: ` ${telegramReport.warnings.join(" · ")}`}
						</Alert>
					)}
				</div>
			</PluginSection>

			<PluginSection description={t.t("url_import_hint")} title={t.t("url_import")}>
				<div className="space-y-3">
					<Field label={t.t("url_import_url")}>
						<Input
							placeholder={t.t("url_import_url_placeholder")}
							value={stickerUrl}
							onChange={setStickerUrl}
						/>
					</Field>
					<div className="grid gap-3 sm:grid-cols-2">
						<Field label={t.t("url_import_pack")}>
							<select
								className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
								value={urlPackId}
								onChange={(event) => setUrlPackId(event.target.value)}
							>
								<option value="">{t.t("url_import_pack_default")}</option>
								{packs.map((pack) => (
									<option key={pack.id} value={pack.id}>
										{pack.name}
									</option>
								))}
							</select>
						</Field>
						<Field label={t.t("url_import_name")}>
							<Input value={urlName} onChange={setUrlName} />
						</Field>
						<Field label={t.t("url_import_keywords")}>
							<Input value={urlKeywords} onChange={setUrlKeywords} />
						</Field>
						<Field label={t.t("url_import_emotions")}>
							<Input value={urlEmotions} onChange={setUrlEmotions} />
						</Field>
					</div>
					<Button
						disabled={importingUrl || stickerUrl.trim().length === 0}
						leadingIcon={<Upload />}
						loading={importingUrl}
						size="sm"
						onClick={() => void importFromUrl()}
					>
						{importingUrl ? t.t("url_import_running") : t.t("url_import_run")}
					</Button>
					{urlImportError === null ? null : <Alert tone="danger">{urlImportError}</Alert>}
					{urlImportResult === null ? null : (
						<Alert tone="info">
							{urlImportResult.duplicate
								? t.t("url_import_duplicate", { name: urlImportResult.item.name })
								: t.t("url_import_success", {
										name: urlImportResult.item.name,
										pack: urlImportResult.pack.name,
									})}
							{urlImportResult.convertedFromVideo
								? ` · ${t.t("url_import_converted", { from: urlImportResult.originalMimeType })}`
								: ""}
						</Alert>
					)}
				</div>
			</PluginSection>

			<PluginSection description={t.t("qq_steal_hint")} title={t.t("qq_steal")}>
				<div className="space-y-3">
					<div className="flex flex-wrap items-end justify-between gap-3">
						<Field label={t.t("url_import_pack")}>
							<select
								className="h-9 min-w-52 rounded-md border border-border bg-background px-2 text-sm"
								value={qqStealPackId}
								onChange={(event) => setQqStealPackId(event.target.value)}
							>
								<option value="">{t.t("url_import_pack_default")}</option>
								{packs.map((pack) => (
									<option key={pack.id} value={pack.id}>
										{pack.name}
									</option>
								))}
							</select>
						</Field>
						<Button
							disabled={loadingQqMedia}
							leadingIcon={<RefreshCw />}
							loading={loadingQqMedia}
							size="sm"
							variant="secondary"
							onClick={() => void loadQqMedia()}
						>
							{t.t("qq_steal_refresh")}
						</Button>
					</div>
					{qqMedia.length === 0 ? (
						<EmptyState title={t.t("qq_steal_empty")} />
					) : (
						<div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
							{qqMedia.map((entry) => {
								const previewBase64 = qqPreviews[entry.mediaId];
								const isStealing = stealingMediaId === entry.mediaId;
								return (
									<div
										key={entry.mediaId}
										className="flex flex-col justify-between gap-2 rounded-md border border-border bg-background p-2"
									>
										<div className="flex h-24 items-center justify-center overflow-hidden rounded bg-muted/40">
											{previewBase64 !== undefined ? (
												<img
													alt={entry.previewText ?? entry.partType}
													className="max-h-24 max-w-full object-contain"
													src={`data:${entry.mimeType};base64,${previewBase64}`}
												/>
											) : (
												<span className="text-[11px] text-muted-foreground">
													{entry.partType}
												</span>
											)}
										</div>
										<div className="space-y-1">
											<div className="truncate text-[11px] font-medium">
												{entry.previewText ?? entry.partType}
											</div>
											<div className="truncate text-[10px] text-muted-foreground">
												{entry.conversationTitle}
											</div>
											<Button
												className="w-full"
												disabled={entry.alreadyInLibrary || stealingMediaId !== null}
												loading={isStealing}
												size="sm"
												variant={entry.alreadyInLibrary ? "ghost" : "secondary"}
												onClick={() => void stealFromQq(entry)}
											>
												{entry.alreadyInLibrary
													? t.t("qq_steal_already")
													: isStealing
														? t.t("qq_steal_stealing")
														: t.t("qq_steal_action")}
											</Button>
										</div>
									</div>
								);
							})}
						</div>
					)}
				</div>
			</PluginSection>

			<PluginSection description={t.t("semantic_hint")} title={t.t("semantic")}>
				<div className="space-y-3">
					<div className="flex flex-wrap items-end gap-3">
						<Field label={t.t("semantic_mode")}>
							<select
								className="h-9 rounded-md border border-border bg-background px-2 text-sm"
								value={semanticMode}
								onChange={(event) => setSemanticMode(event.target.value as SemanticMode)}
							>
								<option value="heuristic">{t.t("semantic_mode_heuristic")}</option>
								<option value="auto">{t.t("semantic_mode_auto")}</option>
								<option value="vision">{t.t("semantic_mode_vision")}</option>
							</select>
						</Field>
						<Field label={t.t("semantic_model")}>
							<select
								className="h-9 min-w-52 rounded-md border border-border bg-background px-2 text-sm"
								value={selectedModelChoice}
								onChange={(event) => setSelectedModelChoice(event.target.value)}
							>
								{modelSelectOptions}
							</select>
						</Field>
						<Button
							disabled={savingModel}
							leadingIcon={<Save />}
							loading={savingModel}
							size="sm"
							variant="secondary"
							onClick={() => void saveModelSettings()}
						>
							{t.t("semantic_model_save")}
						</Button>
					</div>
					{availableModels.length === 0 && !configuredCustom ? (
						<div className="text-[11px] text-muted-foreground">{t.t("semantic_models_empty")}</div>
					) : null}
					<div className="flex flex-wrap items-end gap-3">
						<Field label={t.t("semantic_pack")}>
							<select
								className="h-9 min-w-52 rounded-md border border-border bg-background px-2 text-sm"
								value={reclassifyPackId}
								onChange={(event) => setReclassifyPackId(event.target.value)}
							>
								{packs.map((pack) => (
									<option key={pack.id} value={pack.id}>
										{pack.name}
									</option>
								))}
							</select>
						</Field>
						<Button
							disabled={reclassifyBusy || reclassifyPackId.length === 0}
							leadingIcon={<Sparkles />}
							loading={reclassifyBusy}
							size="sm"
							variant="secondary"
							onClick={() => void reclassify()}
						>
							{reclassifyBusy ? t.t("semantic_reclassifying") : t.t("semantic_reclassify")}
						</Button>
					</div>
					{reclassifyProgress !== null && reclassifyProgress.status === "running" ? (
						<JobProgressCard job={reclassifyProgress} />
					) : null}
					{reclassifyProgress !== null && reclassifyProgress.status === "failed" ? (
						<Alert tone="danger">
							{reclassifyProgress.error ?? t.t("semantic_reclassify_failed")}
						</Alert>
					) : null}
					{reclassifySummary === null ? null : (
						<Alert tone="info">
							{t.t("semantic_reclassify_result", {
								skipped: String(reclassifySummary.skipped),
								updated: String(reclassifySummary.updated),
							})}
						</Alert>
					)}
				</div>
			</PluginSection>

			<PluginSection description={t.t("packs_hint")} title={t.t("packs")}>
				{packs.length === 0 ? (
					<EmptyState description={t.t("packs_empty")} title={t.t("packs")} />
				) : (
					<div className="space-y-2">
						{packs.map((pack) => (
							<PackAccordion
								key={pack.id}
								items={items.filter((item) => item.packId === pack.id)}
								pack={pack}
								previewErrors={previewErrors}
								previews={previews}
								onChanged={refresh}
								onLoadPreviews={loadPreviews}
							/>
						))}
					</div>
				)}
			</PluginSection>

			<PluginSection title={t.t("candidates")}>
				{candidates.length === 0 ? (
					<EmptyState title={t.t("candidates_empty")} />
				) : (
					<div className="space-y-2">
						{candidates.map((candidate) => (
							<CandidateRow key={candidate.id} candidate={candidate} onChanged={refresh} />
						))}
					</div>
				)}
			</PluginSection>

			<PluginSection description={t.t("export_hint")} title={t.t("legacy_import")}>
				<div className="space-y-3">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-xs text-muted-foreground">{t.t("import_dry_run")}</span>
						<Switch
							ariaLabel={t.t("import_dry_run")}
							checked={dryRun}
							onCheckedChange={setDryRun}
						/>
					</div>
					<Field label={t.t("import_directory")}>
						<Input value={directory} onChange={setDirectory} />
					</Field>
					<div className="flex flex-wrap gap-2">
						<Button
							disabled={legacyBusy || directory.trim().length === 0}
							leadingIcon={<Upload />}
							loading={importingLegacy === "dir"}
							size="sm"
							onClick={() => void importDirectory()}
						>
							{importingLegacy === "dir" ? t.t("import_running") : t.t("import_run")}
						</Button>
						<Button
							disabled={legacyBusy || directory.trim().length === 0}
							loading={importingLegacy === "dsh"}
							size="sm"
							variant="secondary"
							onClick={() => void importDsh()}
						>
							{importingLegacy === "dsh" ? t.t("import_running") : t.t("import_dsh")}
						</Button>
					</div>
					<Field label={t.t("import_bundle")}>
						<textarea
							className="min-h-24 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
							value={bundle}
							onChange={(event) => setBundle(event.target.value)}
						/>
					</Field>
					<div className="flex flex-wrap gap-2">
						<Button
							disabled={legacyBusy || bundle.trim().length === 0}
							loading={importingLegacy === "bundle"}
							size="sm"
							onClick={() => void importBundle()}
						>
							{importingLegacy === "bundle" ? t.t("import_running") : t.t("import_run")}
						</Button>
						<Button
							disabled={exporting}
							leadingIcon={<Download />}
							loading={exporting}
							size="sm"
							variant="secondary"
							onClick={() => void exportBundle()}
						>
							{exporting ? t.t("exporting") : t.t("export")}
						</Button>
					</div>
					{legacyProgress !== null && legacyProgress.status === "running" ? (
						<JobProgressCard job={legacyProgress} />
					) : null}
					{legacyProgress !== null && legacyProgress.status === "failed" ? (
						<Alert tone="danger">{legacyProgress.error ?? t.t("import_failed")}</Alert>
					) : null}
					{exported.length === 0 ? null : (
						<Field label={t.t("bundle_output")}>
							<textarea
								className="min-h-40 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
								readOnly
								value={exported}
							/>
						</Field>
					)}
				</div>
			</PluginSection>

			<PluginSection title={plugin.name}>
				<div className="text-xs text-muted-foreground">
					{t.t("plugin_identity", { id: plugin.id, version: plugin.version })}
				</div>
			</PluginSection>
		</PluginPage>
	);
}

export default definePluginUi({
	description: (t) => t("plugin_description"),
	displayName: (t) => t("plugin_name"),
	i18n,
	icon: "puzzle",
	panels: [
		{
			component: StickerPanel,
			icon: "puzzle",
			id: "library",
			title: (t) => t("panel_library"),
		},
	],
});
