"use client";

import type { SkillDetail, SkillsSnapshot, SkillSummary } from "@tsukaima/contracts";
import {
	Alert,
	Button,
	CodeBlock,
	EmptyState,
	ExpandableRow,
	PluginPage,
	PluginSection,
	StatGrid,
	definePluginUi,
	usePluginI18n,
	usePluginPanel,
	usePluginRpc,
	usePluginToast,
} from "@tsukaima/sdk/ui";
import { Puzzle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { i18n } from "./i18n.ts";
import { SKILLS_PLUGIN_ID } from "./manifest.ts";

const SNAPSHOT_RPC = `${SKILLS_PLUGIN_ID}.snapshot`;
const RESCAN_RPC = `${SKILLS_PLUGIN_ID}.rescan`;
const GET_RPC = `${SKILLS_PLUGIN_ID}.get`;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function SkillRow({
	busy,
	detail,
	onPreview,
	skill,
	previewLabel,
	disabledLabel,
	scopeLabel,
}: {
	readonly busy: boolean;
	readonly detail: SkillDetail | null;
	readonly onPreview: () => void;
	readonly previewLabel: string;
	readonly disabledLabel: string;
	readonly scopeLabel: string;
	readonly skill: SkillSummary;
}) {
	const metadata = Object.entries(skill.metadata ?? {});
	return (
		<ExpandableRow
			summary={
				<span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
					<span className="font-mono">{skill.name}</span>
					<span className="text-[11px] text-muted-foreground">{scopeLabel}</span>
					{skill.enabled ? null : (
						<span className="text-[11px] text-muted-foreground">{disabledLabel}</span>
					)}
					<span className="min-w-0 truncate text-[11px] text-muted-foreground">
						{skill.description}
					</span>
				</span>
			}
		>
			<div className="space-y-3">
				<p className="text-xs text-muted-foreground">{skill.description}</p>
				{metadata.length === 0 ? null : (
					<dl className="text-[11px]">
						{metadata.map(([key, value]) => (
							<div
								key={key}
								className="flex flex-wrap items-baseline gap-x-3 border-b border-border/60 py-1 last:border-b-0"
							>
								<dt className="font-mono text-muted-foreground">{key}</dt>
								<dd className="min-w-0 break-words">{value}</dd>
							</div>
						))}
					</dl>
				)}
				{detail === null ? null : (
					<div className="space-y-2">
						<div className="font-mono text-[11px] text-muted-foreground">{`skill://${detail.name}/SKILL.md`}</div>
						<CodeBlock className="max-h-80">{detail.body}</CodeBlock>
						{detail.resources.length === 0 ? null : (
							<div>
								{detail.resources.map((resource) => (
									<div
										key={resource.path}
										className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/60 py-1 font-mono text-[11px] last:border-b-0"
									>
										<span className="break-all">{resource.path}</span>
										<span className="tabular-nums text-muted-foreground">{resource.bytes}</span>
									</div>
								))}
							</div>
						)}
					</div>
				)}
				<Button disabled={busy} size="xs" variant="secondary" onClick={onPreview}>
					{previewLabel}
				</Button>
			</div>
		</ExpandableRow>
	);
}

function SkillsPanel() {
	const t = usePluginI18n();
	const panel = usePluginPanel();
	const rpc = usePluginRpc();
	const toast = usePluginToast();
	const [snapshot, setSnapshot] = useState<SkillsSnapshot | null>(null);
	const [detail, setDetail] = useState<SkillDetail | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void rpc
			.call<SkillsSnapshot>(SNAPSHOT_RPC)
			.then((next) => {
				if (!cancelled) setSnapshot(next);
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					toast.error(t.t("action_failed"), errorMessage(error));
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const rescan = async (): Promise<void> => {
		setBusy(true);
		try {
			setSnapshot(await rpc.call<SkillsSnapshot>(RESCAN_RPC));
			toast.success(t.t("rescanned"));
			await panel.refresh();
		} catch (error) {
			toast.error(t.t("action_failed"), errorMessage(error));
		} finally {
			setBusy(false);
		}
	};

	const preview = async (name: string): Promise<void> => {
		setBusy(true);
		try {
			const next = await rpc.call<SkillDetail | Record<string, never>>(GET_RPC, { name });
			setDetail("name" in next ? (next as SkillDetail) : null);
		} catch (error) {
			toast.error(t.t("action_failed"), errorMessage(error));
		} finally {
			setBusy(false);
		}
	};

	const skills = snapshot?.skills ?? [];
	const diagnostics = snapshot?.diagnostics ?? [];
	const roots = snapshot?.roots ?? Number(panel.status?.metrics?.roots ?? 0);
	const enabled = skills.filter((skill) => skill.enabled).length;

	return (
		<PluginPage
			actions={
				<Button
					disabled={busy}
					leadingIcon={<RefreshCw />}
					size="sm"
					variant="secondary"
					onClick={() => void rescan()}
				>
					{t.t("rescan")}
				</Button>
			}
			description={t.t("plugin_description")}
			title={t.t("panel_skills")}
		>
			{roots === 0 ? <Alert tone="warning">{t.t("no_paths_hint")}</Alert> : null}
			<StatGrid
				items={[
					{ label: t.t("skills"), value: skills.length },
					{ label: t.t("enabled"), value: enabled },
					{ label: t.t("roots"), value: roots },
					{ label: t.t("diagnostics"), value: diagnostics.length },
				]}
			/>
			<PluginSection title={t.t("skills")}>
				{skills.length === 0 ? (
					<EmptyState
						icon={<Puzzle className="size-6" />}
						description={roots === 0 ? t.t("no_paths_hint") : t.t("empty")}
						title={t.t("empty")}
					/>
				) : (
					<div>
						{skills.map((skill) => (
							<SkillRow
								busy={busy}
								detail={detail !== null && detail.name === skill.name ? detail : null}
								disabledLabel={t.t("disabled_badge")}
								key={skill.name}
								previewLabel={t.t("preview")}
								scopeLabel={skill.scope === "everyone" ? t.t("scope_everyone") : t.t("scope_admin")}
								skill={skill}
								onPreview={() => void preview(skill.name)}
							/>
						))}
					</div>
				)}
			</PluginSection>
			{diagnostics.length === 0 ? null : (
				<PluginSection title={t.t("diagnostics")}>
					<ul className="text-xs">
						{diagnostics.map((diagnostic) => (
							<li
								className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border/60 py-1.5 text-muted-foreground last:border-b-0"
								key={`${diagnostic.code}:${diagnostic.name ?? ""}:${diagnostic.rootIndex ?? 0}:${diagnostic.message}`}
							>
								<span className="font-mono text-[11px] text-ink">{diagnostic.code}</span>
								<span className="min-w-0 break-words">{diagnostic.message}</span>
							</li>
						))}
					</ul>
				</PluginSection>
			)}
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
			component: SkillsPanel,
			icon: "puzzle",
			id: "skills",
			title: (t) => t("panel_skills"),
		},
	],
});
