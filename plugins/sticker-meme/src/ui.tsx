"use client";

import {
	Alert,
	Button,
	EmptyState,
	Field,
	Input,
	PluginPage,
	PluginSection,
	StatGrid,
	Switch,
	definePluginUi,
	usePluginI18n,
	usePluginPanel,
	usePluginRpc,
	usePluginToast,
} from "@elaina/sdk/ui";
import { Download, RefreshCw, Save, Trash2, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import type { StickerItem, StickerPack } from "./domain.ts";
import { i18n } from "./i18n.ts";
import { STICKER_MEME_PLUGIN_ID } from "./manifest.ts";

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

const rpcName = (method: string): string => `${STICKER_MEME_PLUGIN_ID}.${method}`;
const list = (value: string): string[] =>
	value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
const join = (values: readonly string[]): string => values.join(", ");

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
				<Button disabled={saving} leadingIcon={<Save />} size="xs" onClick={() => void save()}>
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
				<Button disabled={saving} size="xs" variant="secondary" onClick={() => void save()}>
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
	const review = async (action: "approve" | "reject" | "delete") => {
		try {
			await rpc.call(rpcName("candidates.review"), { action, id: candidate.id });
			toast.success(t.t("review_success"));
			await onChanged();
		} catch (error) {
			toast.error(t.t("review_failed"), String(error));
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
				<Button size="xs" onClick={() => void review("approve")}>
					{t.t("approve")}
				</Button>
				<Button size="xs" variant="secondary" onClick={() => void review("reject")}>
					{t.t("reject")}
				</Button>
				<Button size="xs" variant="ghost" onClick={() => void review("delete")}>
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
	const [deletePackId, setDeletePackId] = useState("");
	const [deleteArmed, setDeleteArmed] = useState(false);
	const [backupBeforeDelete, setBackupBeforeDelete] = useState(true);
	const [loading, setLoading] = useState(false);

	const refresh = async (): Promise<void> => {
		setLoading(true);
		try {
			const packResult = await rpc.call<{ packs: readonly PackRow[] }>(rpcName("packs.list"));
			const itemResult = await rpc.call<{ items: readonly ItemRow[] }>(rpcName("items.list"));
			const candidateResult = await rpc.call<{ items: readonly ItemRow[] }>(
				rpcName("candidates.list"),
			);
			const statsResult = await rpc.call<StatsRow>(rpcName("stats"));
			setPacks(packResult.packs);
			setItems(itemResult.items);
			setCandidates(candidateResult.items);
			setStats(statsResult);
			if (deletePackId.length === 0 && packResult.packs.length > 0) {
				setDeletePackId(packResult.packs[0]?.id ?? "");
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

	const importDirectory = async () => {
		try {
			const report = await rpc.call<{
				deduped: number;
				items: number;
				missingMedia: number;
			}>(rpcName("packs.importDir"), { directory, dryRun });
			toast.success(
				t.t("import_success"),
				t.t("import_result", {
					deduped: String(report.deduped),
					items: String(report.items),
					missing: String(report.missingMedia),
				}),
			);
			if (!dryRun) await refresh();
		} catch (error) {
			toast.error(t.t("import_failed"), String(error));
		}
	};

	const importDsh = async () => {
		try {
			const report = await rpc.call<{
				deduped: number;
				items: number;
				missingMedia: number;
			}>(rpcName("packs.importDsh"), { directory, dryRun });
			toast.success(
				t.t("import_success"),
				t.t("import_result", {
					deduped: String(report.deduped),
					items: String(report.items),
					missing: String(report.missingMedia),
				}),
			);
			if (!dryRun) await refresh();
		} catch (error) {
			toast.error(t.t("import_failed"), String(error));
		}
	};

	const importBundle = async () => {
		try {
			const parsed = JSON.parse(bundle) as Record<string, unknown>;
			const report = await rpc.call<{
				deduped: number;
				items: number;
				missingMedia: number;
			}>(rpcName("packs.importBundle"), { ...parsed, dryRun });
			toast.success(
				t.t("import_success"),
				t.t("import_result", {
					deduped: String(report.deduped),
					items: String(report.items),
					missing: String(report.missingMedia),
				}),
			);
			if (!dryRun) await refresh();
		} catch (error) {
			toast.error(t.t("import_failed"), String(error));
		}
	};

	const exportBundle = async () => {
		try {
			const result = await rpc.call<ExportRow>(rpcName("packs.export"), {});
			setExported(JSON.stringify(result, null, 2));
		} catch (error) {
			toast.error(t.t("save_failed"), String(error));
		}
	};

	const deletePack = async () => {
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
		}
	};

	return (
		<PluginPage
			actions={
				<Button
					disabled={loading}
					leadingIcon={<RefreshCw />}
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

			<PluginSection description={t.t("export_hint")} title={t.t("import")}>
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
							disabled={directory.trim().length === 0}
							leadingIcon={<Upload />}
							size="sm"
							onClick={() => void importDirectory()}
						>
							{t.t("import_run")}
						</Button>
						<Button
							disabled={directory.trim().length === 0}
							size="sm"
							variant="secondary"
							onClick={() => void importDsh()}
						>
							{t.t("import_dsh")}
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
							disabled={bundle.trim().length === 0}
							size="sm"
							onClick={() => void importBundle()}
						>
							{t.t("import_run")}
						</Button>
						<Button
							leadingIcon={<Download />}
							size="sm"
							variant="secondary"
							onClick={() => void exportBundle()}
						>
							{t.t("export")}
						</Button>
					</div>
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
						disabled={!deleteArmed || !backupBeforeDelete || deletePackId.length === 0}
						leadingIcon={<Trash2 />}
						size="sm"
						variant="danger"
						onClick={() => void deletePack()}
					>
						{t.t("delete_pack")}
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
