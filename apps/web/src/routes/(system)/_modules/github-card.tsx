"use client";

import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Trash2 } from "lucide-react";
import { Button } from "@tsukaima/ui/components/motion/button";
import { Card, CardContent, CardHeader, CardTitle } from "@tsukaima/ui/components/motion/card";
import { Input } from "@tsukaima/ui/components/motion/input";
import { cn } from "@tsukaima/ui/lib/utils";
import { orpc, type GitHubAppStatus, type GitHubRun } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { m } from "@/paraglide/messages";
import { InlineError } from "../../_modules/shell/primitives";

function Field({ label, children }: { readonly children: ReactNode; readonly label: string }) {
	return (
		<div className="contents">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="truncate text-foreground">{children}</dd>
		</div>
	);
}

function ConfiguredSummary({ status }: { readonly status: GitHubAppStatus }) {
	const permissions = Object.entries(status.permissions ?? {})
		.map(([scope, level]) => `${scope}: ${level}`)
		.join(", ");
	return (
		<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
			<Field label={m.github_account()}>{status.account ?? "—"}</Field>
			<Field label={m.github_app_id()}>
				<span className="font-mono text-[10.5px]">{status.appId ?? "—"}</span>
			</Field>
			<Field label={m.github_installation_id()}>
				<span className="font-mono text-[10.5px]">{status.installationId ?? "—"}</span>
			</Field>
			<Field label={m.github_permissions()}>
				<span className="text-[10.5px] text-muted-foreground">{permissions || "—"}</span>
			</Field>
			<Field label={m.github_key_fingerprint()}>
				<span className="font-mono text-[10.5px] text-muted-foreground">
					{status.keyFingerprint ?? "—"}
				</span>
			</Field>
			<Field label={m.github_token_expires()}>
				<span className="text-[10.5px] text-muted-foreground">
					{status.tokenExpiresAt === null
						? "—"
						: new Date(status.tokenExpiresAt).toLocaleTimeString()}
				</span>
			</Field>
		</dl>
	);
}

export function GitHubAppCard() {
	const toast = useToast();
	const queryClient = useQueryClient();
	const status = useQuery({
		...orpc.admin.github.status.queryOptions(),
		staleTime: 30_000,
	});
	const [editing, setEditing] = useState(false);
	const [appId, setAppId] = useState("");
	const [installationId, setInstallationId] = useState("");
	const [privateKey, setPrivateKey] = useState("");

	const invalidate = async () => {
		await queryClient.invalidateQueries({ queryKey: orpc.admin.github.key() });
	};
	const configure = useMutation(
		orpc.admin.github.configure.mutationOptions({
			onError: (error) =>
				toast.error(m.github_configure_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.github_saved());
				setEditing(false);
				setPrivateKey("");
				await invalidate();
			},
		}),
	);
	const clear = useMutation(
		orpc.admin.github.clear.mutationOptions({
			onError: (error) =>
				toast.error(m.github_remove_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.github_removed());
				setEditing(false);
				await invalidate();
			},
		}),
	);

	const configured = status.data?.configured === true;
	const formVisible = status.data !== undefined && (!configured || editing);
	const appIdValue = Number(appId);
	const installationIdValue = Number(installationId);
	const valid =
		Number.isInteger(appIdValue) &&
		appIdValue > 0 &&
		Number.isInteger(installationIdValue) &&
		installationIdValue > 0 &&
		privateKey.trim().length > 0;

	return (
		<Card size="compact">
			<CardHeader>
				<CardTitle as="h2">{m.github_title()}</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				<p className="text-[11px] leading-4 text-muted-foreground">{m.github_description()}</p>
				{status.isError ? (
					<InlineError
						message={`${m.github_load_failed()}: ${status.error.message}`}
						onRetry={() => void status.refetch()}
						retryLabel={m.retry()}
					/>
				) : status.data === undefined ? (
					<p className="text-[11px] text-muted-foreground">{m.loading()}</p>
				) : configured ? (
					<ConfiguredSummary status={status.data} />
				) : (
					<p className="text-[11px] text-muted-foreground">{m.github_not_configured()}</p>
				)}
				{formVisible ? (
					<div className="space-y-2">
						<div className="grid gap-2 sm:grid-cols-2">
							<Input
								classNames={{ field: "h-8 rounded-md", input: "text-xs", root: "gap-1" }}
								inputMode="numeric"
								label={m.github_app_id()}
								value={appId}
								onChange={setAppId}
							/>
							<Input
								classNames={{ field: "h-8 rounded-md", input: "text-xs", root: "gap-1" }}
								inputMode="numeric"
								label={m.github_installation_id()}
								value={installationId}
								onChange={setInstallationId}
							/>
						</div>
						<label className="block text-[11px] text-muted-foreground">
							{m.github_private_key()}
							<textarea
								aria-label={m.github_private_key()}
								className={cn(
									"mt-1 min-h-24 w-full resize-y rounded-md border border-border bg-background p-2",
									"font-mono text-[10.5px] leading-4 text-foreground outline-none",
									"focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
								)}
								placeholder={m.github_private_key_placeholder()}
								spellCheck={false}
								value={privateKey}
								onChange={(event) => setPrivateKey(event.currentTarget.value)}
							/>
						</label>
						<p className="text-[10.5px] leading-4 text-muted-foreground">
							{m.github_required_permissions()}
						</p>
						<div className="flex flex-wrap gap-1.5">
							<Button
								disabled={!valid}
								loading={configure.isPending}
								size="sm"
								onClick={() =>
									configure.mutate({
										appId: appIdValue,
										installationId: installationIdValue,
										privateKey: privateKey.trim(),
									})
								}
							>
								{m.github_configure()}
							</Button>
							{configured ? (
								<Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
									{m.cancel()}
								</Button>
							) : null}
						</div>
					</div>
				) : configured ? (
					<div className="flex flex-wrap gap-1.5">
						<Button
							leadingIcon={<KeyRound />}
							size="xs"
							variant="outline"
							onClick={() => setEditing(true)}
						>
							{m.github_configure()}
						</Button>
						<Button
							leadingIcon={<Trash2 />}
							loading={clear.isPending}
							size="xs"
							variant="ghost"
							onClick={() => clear.mutate()}
						>
							{m.github_remove()}
						</Button>
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}

function runTone(run: GitHubRun): string {
	if (run.conclusion === "success")
		return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
	if (run.conclusion === null) return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
	return "bg-destructive/10 text-destructive";
}

export function GitHubActivityCard() {
	const status = useQuery({
		...orpc.admin.github.status.queryOptions(),
		staleTime: 30_000,
	});
	const enabled = status.data?.configured === true;
	const runs = useQuery({
		...orpc.admin.github.runs.queryOptions({ input: {} }),
		enabled,
		staleTime: 60_000,
	});
	const pulls = useQuery({
		...orpc.admin.github.pulls.queryOptions(),
		enabled,
		staleTime: 60_000,
	});
	if (!enabled) return null;

	return (
		<Card size="compact">
			<CardHeader>
				<CardTitle as="h2">{m.github_activity_title()}</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				<p className="text-[11px] leading-4 text-muted-foreground">
					{m.github_activity_description()}
				</p>
				<div className="space-y-1.5">
					<h3 className="text-[11px] font-medium text-foreground">{m.github_runs()}</h3>
					{runs.isError ? (
						<InlineError
							message={`${m.github_load_failed()}: ${runs.error.message}`}
							onRetry={() => void runs.refetch()}
							retryLabel={m.retry()}
						/>
					) : runs.data === undefined ? (
						<p className="text-[11px] text-muted-foreground">{m.loading()}</p>
					) : runs.data.length === 0 ? (
						<p className="text-[11px] text-muted-foreground">{m.github_runs_empty()}</p>
					) : (
						<ul className="divide-y divide-border/60">
							{runs.data.map((run) => (
								<li key={run.id} className="flex flex-wrap items-center gap-2 py-1.5 text-[11px]">
									<span
										className={cn("rounded px-1.5 py-0.5 text-[9.5px] font-medium", runTone(run))}
									>
										{run.conclusion ?? run.status}
									</span>
									<a
										className="truncate font-medium text-foreground underline-offset-4 hover:underline"
										href={run.url}
										rel="noreferrer"
										target="_blank"
									>
										{run.name}
									</a>
									<span className="ml-auto font-mono text-[10px] text-muted-foreground">
										{run.headSha.slice(0, 7)}
									</span>
								</li>
							))}
						</ul>
					)}
				</div>
				<div className="space-y-1.5">
					<h3 className="text-[11px] font-medium text-foreground">{m.github_pulls()}</h3>
					{pulls.isError ? (
						<InlineError
							message={`${m.github_load_failed()}: ${pulls.error.message}`}
							onRetry={() => void pulls.refetch()}
							retryLabel={m.retry()}
						/>
					) : pulls.data === undefined ? (
						<p className="text-[11px] text-muted-foreground">{m.loading()}</p>
					) : pulls.data.length === 0 ? (
						<p className="text-[11px] text-muted-foreground">{m.github_pulls_empty()}</p>
					) : (
						<ul className="divide-y divide-border/60">
							{pulls.data.map((pull) => (
								<li
									key={pull.number}
									className="flex flex-wrap items-center gap-2 py-1.5 text-[11px]"
								>
									<span className="font-mono text-[10px] text-muted-foreground">
										#{pull.number}
									</span>
									<a
										className="truncate font-medium text-foreground underline-offset-4 hover:underline"
										href={pull.url}
										rel="noreferrer"
										target="_blank"
									>
										{pull.title}
									</a>
									<span className="ml-auto text-[10px] text-muted-foreground">
										{pull.head} → {pull.base}
									</span>
								</li>
							))}
						</ul>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
