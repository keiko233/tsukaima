"use client";

import type { SkillDetail, SkillsSnapshot, SkillSummary } from "@tsukaima/contracts";
import {
	Alert,
	Button,
	EmptyState,
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
	onPreview,
	skill,
	previewLabel,
	disabledLabel,
	scopeLabel,
}: {
	readonly busy: boolean;
	readonly onPreview: () => void;
	readonly previewLabel: string;
	readonly disabledLabel: string;
	readonly scopeLabel: string;
	readonly skill: SkillSummary;
}) {
	return (
		<div className="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-border bg-background/40 p-3">
			<div className="min-w-0">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-mono text-sm font-medium">{skill.name}</span>
					<span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10.5px] text-muted-foreground">
						{scopeLabel}
					</span>
					{skill.enabled ? null : (
						<span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10.5px] text-muted-foreground">
							{disabledLabel}
						</span>
					)}
				</div>
				<p className="mt-1 text-xs text-muted-foreground">{skill.description}</p>
			</div>
			<Button disabled={busy} size="sm" variant="secondary" onClick={onPreview}>
				{previewLabel}
			</Button>
		</div>
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
					<div className="space-y-2">
						{skills.map((skill) => (
							<SkillRow
								busy={busy}
								disabledLabel={t.t("disabled_badge")}
								key={skill.name}
								previewLabel={t.t("preview")}
								scopeLabel={
									skill.scope === "everyone" ? t.t("scope_everyone") : t.t("scope_admin")
								}
								skill={skill}
								onPreview={() => void preview(skill.name)}
							/>
						))}
					</div>
				)}
			</PluginSection>
			{detail === null ? null : (
				<PluginSection title={`${detail.name} · skill://${detail.name}/SKILL.md`}>
					<div className="space-y-3">
						<p className="text-xs text-muted-foreground">{detail.description}</p>
						<pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 text-xs">
							{detail.body}
						</pre>
						{detail.resources.length === 0 ? null : (
							<div className="text-xs text-muted-foreground">
								{detail.resources.map((resource) => (
									<div className="font-mono" key={resource.path}>
										{resource.path}
									</div>
								))}
							</div>
						)}
					</div>
				</PluginSection>
			)}
			{diagnostics.length === 0 ? null : (
				<PluginSection title={t.t("diagnostics")}>
					<ul className="space-y-1 text-xs">
						{diagnostics.map((diagnostic, index) => (
							<li className="text-muted-foreground" key={`${diagnostic.code}-${index}`}>
								<span className="font-mono text-foreground">{diagnostic.code}</span>{" "}
								{diagnostic.message}
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
