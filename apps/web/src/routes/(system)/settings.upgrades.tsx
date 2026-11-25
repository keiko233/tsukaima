import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { KpiStrip } from "@tsukaima/ui";
import { orpc } from "@/lib/api";
import { m } from "@/paraglide/messages";
import { GitHubActivityCard, GitHubCard } from "./_modules/github-card";
import { SystemPage } from "./_modules/page-header";
import { RepositoryFetchButton, RepositoryStatusCard } from "./_modules/repository-status-card";
import { UpgradeCenter } from "./_modules/upgrade-center";

function SettingsUpgradesPage() {
	const repository = useQuery({
		...orpc.admin.repository.status.queryOptions(),
		staleTime: 15_000,
	});
	const github = useQuery({ ...orpc.admin.github.status.queryOptions(), staleTime: 15_000 });
	const status = repository.data;
	const dirty = status?.dirty;
	const changes =
		dirty === undefined
			? undefined
			: dirty.staged + dirty.modified + dirty.untracked + dirty.conflicted;
	const githubStatus = github.data;
	const githubLabel = githubStatus?.configured
		? (githubStatus.login ?? m.github_login_signed_in())
		: m.github_logged_out();

	return (
		<SystemPage description={m.settings_upgrades_description()} title={m.settings_tab_upgrades()}>
			<div className="space-y-6">
				<div aria-label={m.settings_upgrade_strip_label()} role="region">
					<KpiStrip
						items={[
							{ label: m.repository_version(), value: status?.version || "—" },
							{
								label: m.repository_branch(),
								value: status === undefined ? "—" : (status.branch ?? m.repository_detached()),
							},
							{
								label: m.upgrade_commit(),
								value: (
									<code title={status?.head.commit} className="font-mono text-sm tabular-nums">
										{status?.head.commit.slice(0, 12) || "—"}
									</code>
								),
							},
							{
								label: m.repository_title(),
								value:
									changes === undefined ? (
										"—"
									) : changes === 0 ? (
										m.repository_clean()
									) : (
										<code className="font-mono tabular-nums" title={m.upgrade_dirty_description()}>
											{changes}
										</code>
									),
								tone: changes === undefined ? "muted" : changes === 0 ? "success" : "warning",
							},
							{
								label: m.repository_upstream(),
								value:
									status === undefined ? "—" : (status.upstream?.ref ?? m.repository_no_upstream()),
							},
							{
								label: m.github_title(),
								value:
									githubStatus === undefined
										? "—"
										: githubStatus.available
											? githubLabel
											: m.upgrade_status_unavailable(),
								tone: githubStatus?.configured ? "success" : "muted",
							},
						]}
					/>
				</div>
				<UpgradeCenter fetchAction={<RepositoryFetchButton />} />
				<RepositoryStatusCard showFetch={false} />
				<GitHubCard />
				<GitHubActivityCard />
			</div>
		</SystemPage>
	);
}

export const Route = createFileRoute("/(system)/settings/upgrades")({
	component: SettingsUpgradesPage,
});
