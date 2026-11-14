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
	definePluginUi,
	usePluginConfig,
	usePluginI18n,
	usePluginPanel,
	usePluginRpc,
	usePluginToast,
} from "@tsukaima/sdk/ui";
import { Download, RefreshCw, Save, Send, Sparkles, Trash2, Upload } from "lucide-react";
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
}

type SemanticMode = "auto" | "heuristic" | "vision";
type TelegramAnimatedFormat = "gif" | "thumbnail";
type TelegramVideoFormat = "gif" | "thumbnail" | "webm";

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
		if (
			Array.isArray(parsed) &&
			typeof parsed[0] === "string" &&
			typeof parsed[1] === "string"
		) {
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
const telegramSetName = (pack: StickerPack): string | undefined => {
	const telegram = pack.metadata.telegram;
	if (typeof telegram !== "object" || telegram === null || Array.isArray(telegram)) return undefined;
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

function PackCard({
	onChanged,
	pack,
}: {
	onChanged: () => Promise<void>;
	pack: PackRow;
}) {
	const t = usePluginI18n();
	const rpc = usePluginRpc();
	const toast = usePluginToast();
	const [name, setName] = useState(pack.name);
	const [tags, setTags] = useState(join(pack.tags));
	const [personas, setPersonas] = useState(join(pack.personaIds));
	const [saving, setSaving] = useState(false);
	const telegramName = telegramSetName(pack);
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
			await onChanged();
		} catch (error) {
			toast.error(t.t("save_failed"), String(error));
		} finally {
			setSaving(false);
		}
	};
	return (
		<div className="rounded-xl border border-border bg-background/40 p-3">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="min-w-0">
					<div className="truncate text-sm font-medium">{pack.name}</div>
					<div className="text-[11px] text-muted-foreground">
						{t.t(`source_${pack.source}`)} · {t.t("pack_items", { count: String(pack.itemCount) })}
						{telegramName === undefined
							? ""
							: ` · ${t.t("telegram_pack_meta", { name: telegramName })}`}
					</div>
				</div>
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
			<div className="mt-3 grid gap-2 sm:grid-cols-3">
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
			<div className="mt-2 flex justify-end">
				<Button loading={saving} leadingIcon={<Save />} size="xs" onClick={() => void save()}>
					{t.t("save_pack")}
				</Button>
			</div>
		</div>
	);
}

function ItemCard({
	item,
	onChanged,
	preview,
}: {
	item: ItemRow;
	onChanged: () => Promise<void>;
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
	const missing = item.mediaId.length === 0 || item.revokedAt !== null;
	return (
		<div className="space-y-2 rounded-xl border border-border bg-background/40 p-3">
			<div className="flex items-start justify-between gap-2">
				<div className="flex min-w-0 items-center gap-2">
					{preview === undefined ? (
						<div className="flex size-14 shrink-0 items-center justify-center rounded-lg border border-border text-[10px] text-muted-foreground">
							{t.t("item_preview")}
						</div>
					) : (
						<img
							alt={item.name}
							className="size-14 shrink-0 rounded-lg border border-border object-contain"
							src={`data:${item.mimeType};base64,${preview}`}
						/>
					)}
					<div className="min-w-0">
						<div className="truncate text-sm font-medium">{item.name}</div>
						<div className="text-[11px] text-muted-foreground">
							{t.t(`status_${item.reviewStatus}`)} ·{" "}
							{t.t("item_usage", { count: String(item.useCount) })} · {item.score}
							{item.semantic === undefined || item.semantic.labels.length === 0
								? ""
								: ` · ${t.t("semantic_source")}: ${item.semantic.labels.slice(0, 4).join(", ")}`}
						</div>
						{missing ? (
							<div className="text-[11px] text-warning">{t.t("status_missing")}</div>
						) : null}
					</div>
				</div>
				<Switch
					ariaLabel={t.t("item_enabled")}
					checked={item.enabled}
					onCheckedChange={() => {
						void rpc
							.call(rpcName("items.update"), { enabled: !item.enabled, id: item.id })
							.then(onChanged)
							.catch((error: unknown) => toast.error(t.t("save_failed"), String(error)));
					}}
				/>
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
			<div className="flex justify-end">
				<Button loading={saving} size="xs" variant="secondary" onClick={() => void save()}>
					{t.t("item_save")}
				</Button>
			</div>
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
						<span key={keyword} className="rounded-full border border-border px-1.5 py-0.5 text-[10px]">
							{keyword}
						</span>
					))}
					{candidate.emotions.map((emotion) => (
						<span key={emotion} className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
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
	const [deletePackId, setDeletePackId] = useState("");
	const [deleteArmed, setDeleteArmed] = useState(false);
	const [backupBeforeDelete, setBackupBeforeDelete] = useState(true);
	const [deleting, setDeleting] = useState(false);
	const [loading, setLoading] = useState(false);
	const [jobProgress, setJobProgress] = useState<JobProgressRow | null>(null);
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
				.catch(() => ({ active: null }));
			setPacks(packResult.packs);
			setItems(itemResult.items);
			setCandidates(candidateResult.items);
			setStats(statsResult);
			setAvailableModels(modelsResult.models ?? []);
			setConfiguredCustom(modelsResult.configuredCustom === true);
			if (progressResult.active !== null) {
				setJobProgress(progressResult.active);
				if (progressResult.active.status === "running" && !inFlightRef.current) {
					wasBackgroundRunningRef.current = true;
				}
			}
			if (deletePackId.length === 0 && packResult.packs.length > 0) {
				setDeletePackId(packResult.packs[0]?.id ?? "");
			}
			if (reclassifyPackId.length === 0 && packResult.packs.length > 0) {
				setReclassifyPackId(packResult.packs[0]?.id ?? "");
			}
			const loaded: Record<string, string> = {};
			for (const item of itemResult.items.slice(0, 24)) {
				if (item.mediaId.length === 0) continue;
				try {
					const preview = await rpc.call<PreviewRow>(rpcName("preview"), { itemId: item.id });
					loaded[item.id] = preview.dataBase64;
				} catch {}
			}
			setPreviews(loaded);
		} catch (error) {
			toast.error(t.t("load_failed"), String(error));
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const isJobRunning =
		importingTelegram ||
		reclassifying ||
		importingLegacy !== null ||
		jobProgress?.status === "running";

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
				setJobProgress(result.active);
				if (result.active.status === "running") {
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
		setJobProgress({
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
		});
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
		const latest = await rpc
			.call<ProgressResponse>(rpcName("progress"))
			.catch(() => ({ active: null }));
		if (latest.active !== null) {
			setJobProgress(latest.active);
			return;
		}
		setJobProgress((current) =>
			current !== null && current.kind === kind && current.status === "running"
				? {
						...current,
						...(errorMessage === undefined ? {} : { error: errorMessage }),
						stage: errorMessage === undefined ? "done" : "error",
						status: errorMessage === undefined ? "completed" : "failed",
						updatedAt: new Date().toISOString(),
					}
				: current,
		);
	};

	const importTelegram = async () => {
		setTelegramReport(null);
		setTelegramError(null);
		setImportingTelegram(true);
		startOptimisticJob("telegram.import", "fetching");
		try {
			const report = await rpc.call<TelegramImportRow>(rpcName("telegram.import"), {
				animatedFormat: telegramAnimatedFormat,
				dryRun,
				includeAnimated: telegramAnimated,
				includeVideo: telegramAnimated,
				semanticMode,
				...classifierSelection(),
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
			if (!dryRun) await refresh();
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

	const deletePack = async () => {
		setDeleting(true);
		try {
			await rpc.call(rpcName("packs.delete"), {
				backup: backupBeforeDelete,
				confirm: deleteArmed,
				packId: deletePackId,
			});
			toast.success(t.t("delete_success"));
			setDeleteArmed(false);
			await refresh();
		} catch (error) {
			toast.error(t.t("delete_failed"), String(error));
		} finally {
			setDeleting(false);
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

	const telegramProgress = jobProgress?.kind === "telegram.import" ? jobProgress : null;
	const telegramBusy = importingTelegram || telegramProgress?.status === "running";
	const telegramFailureMessage =
		telegramError ??
		(telegramProgress?.status === "failed"
			? (telegramProgress.error ?? t.t("telegram_import_failed"))
			: null);
	const reclassifyProgress = jobProgress?.kind === "semantic.reclassify" ? jobProgress : null;
	const reclassifyBusy = reclassifying || reclassifyProgress?.status === "running";
	const legacyProgress =
		jobProgress !== null &&
		(jobProgress.kind === "packs.importDir" ||
			jobProgress.kind === "packs.importBundle" ||
			jobProgress.kind === "packs.importDsh")
			? jobProgress
			: null;
	const legacyBusy = importingLegacy !== null || legacyProgress?.status === "running";

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
								<option value="webm">{t.t("telegram_video_webm")}</option>
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
					</div>
					<Button
						disabled={telegramBusy || isJobRunning || telegramUrl.trim().length === 0}
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
							disabled={reclassifyBusy || isJobRunning || reclassifyPackId.length === 0}
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

			<PluginSection title={t.t("packs")}>
				{packs.length === 0 ? (
					<EmptyState description={t.t("packs_empty")} title={t.t("packs")} />
				) : (
					<div className="space-y-2">
						{packs.map((pack) => (
							<PackCard key={pack.id} pack={pack} onChanged={refresh} />
						))}
					</div>
				)}
			</PluginSection>

			<PluginSection title={t.t("items")}>
				{items.length === 0 ? (
					<EmptyState title={t.t("items_empty")} />
				) : (
					<div className="grid gap-2 xl:grid-cols-2">
						{items.map((item) => (
							<ItemCard
								key={item.id}
								item={item}
								onChanged={refresh}
								preview={previews[item.id]}
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
							disabled={legacyBusy || isJobRunning || directory.trim().length === 0}
							leadingIcon={<Upload />}
							loading={importingLegacy === "dir"}
							size="sm"
							onClick={() => void importDirectory()}
						>
							{importingLegacy === "dir" ? t.t("import_running") : t.t("import_run")}
						</Button>
						<Button
							disabled={legacyBusy || isJobRunning || directory.trim().length === 0}
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
							disabled={legacyBusy || isJobRunning || bundle.trim().length === 0}
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

			<PluginSection title={t.t("delete_pack")}>
				<Alert tone="warning">{t.t("delete_confirm")}</Alert>
				<div className="mt-3 grid gap-3 sm:grid-cols-2">
					<Field label={t.t("packs")}>
						<select
							className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
							value={deletePackId}
							onChange={(event) => setDeletePackId(event.target.value)}
						>
							{packs.map((pack) => (
								<option key={pack.id} value={pack.id}>
									{pack.name}
								</option>
							))}
						</select>
					</Field>
					<div className="flex flex-wrap items-center gap-4 pt-5">
						<label className="flex items-center gap-2 text-xs">
							<Switch
								ariaLabel={t.t("delete_backup")}
								checked={backupBeforeDelete}
								onCheckedChange={setBackupBeforeDelete}
							/>
							{t.t("delete_backup")}
						</label>
						<label className="flex items-center gap-2 text-xs">
							<Switch
								ariaLabel={t.t("delete_arm")}
								checked={deleteArmed}
								onCheckedChange={setDeleteArmed}
							/>
							{t.t("delete_arm")}
						</label>
					</div>
				</div>
				<div className="mt-3 flex justify-end">
					<Button
						disabled={deleting || !deleteArmed || !backupBeforeDelete || deletePackId.length === 0}
						leadingIcon={<Trash2 />}
						loading={deleting}
						size="sm"
						variant="danger"
						onClick={() => void deletePack()}
					>
						{deleting ? t.t("deleting") : t.t("delete_pack")}
					</Button>
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
