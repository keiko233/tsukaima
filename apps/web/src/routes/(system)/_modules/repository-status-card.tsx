"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, Download, GitBranch, RefreshCw } from "lucide-react";
import { Button } from "@tsukaima/ui/components/motion/button";
import { Card, CardContent, CardHeader, CardTitle } from "@tsukaima/ui/components/motion/card";
import { Input } from "@tsukaima/ui/components/motion/input";
import { cn } from "@tsukaima/ui/lib/utils";
import { orpc, type RepositoryStatus } from "@/lib/api";
import { m } from "@/paraglide/messages";
import { errorMessage, useToast } from "@/lib/toast";
import { InlineError } from "../../_modules/shell/primitives";

function shortCommit(commit: string): string {
	return commit.length > 12 ? commit.slice(0, 12) : commit;
}

function Pill({
	children,
	tone = "muted",
}: {
	readonly children: ReactNode;
	readonly tone?: "muted" | "ok" | "warn";
}) {
	return (
		<span
			className={cn(
				"rounded px-1.5 py-0.5 text-[9.5px] font-medium",
				tone === "ok"
					? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
					: tone === "warn"
						? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
						: "bg-muted text-muted-foreground",
			)}
		>
			{children}
		</span>
	);
}

/**
 * Uncommitted work, split the way the service counts it. Paths are deliberately absent: the
 * browser shows a summary, and a full diff belongs to a governed workspace, not an admin card.
 */
function DirtySummary({ dirty }: { readonly dirty: RepositoryStatus["dirty"] }) {
	const counts = [
		{ label: m.repository_staged(), value: dirty.staged },
		{ label: m.repository_modified(), value: dirty.modified },
		{ label: m.repository_untracked(), value: dirty.untracked },
		{ label: m.repository_conflicted(), value: dirty.conflicted },
	].filter((entry) => entry.value > 0);
	if (counts.length === 0) {
		return (
			<span className="text-[11px] text-emerald-700 dark:text-emerald-400">
				{m.repository_clean()}
			</span>
		);
	}
	return (
		<div className="flex flex-wrap gap-1">
			{counts.map((entry) => (
				<Pill key={entry.label} tone="warn">
					{entry.label} {entry.value}
				</Pill>
			))}
		</div>
	);
}

function RepositorySummary({ status }: { readonly status: RepositoryStatus }) {
	const upstreamRemote = status.remotes.find((remote) => remote.name === status.upstream?.remote);
	const tags = status.tags
		.slice(0, 5)
		.map((tag) => tag.name)
		.join(", ");
	return (
		<div className="space-y-2.5">
			<div className="flex flex-wrap items-center gap-1.5">
				<span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-foreground">
					<GitBranch className="size-3" />
					{status.branch ?? m.repository_detached()}
				</span>
				{status.upstream === null ? (
					<Pill>{m.repository_no_upstream()}</Pill>
				) : (
					<>
						<Pill>
							{m.repository_upstream()} {status.upstream.ref}
						</Pill>
						<Pill>
							{m.repository_ahead()} {status.upstream.ahead}
						</Pill>
						<Pill>
							{m.repository_behind()} {status.upstream.behind}
						</Pill>
					</>
				)}
				<Pill tone={status.pushed ? "ok" : "warn"}>
					{status.pushed ? m.repository_pushed() : m.repository_unpushed()}
				</Pill>
			</div>
			<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
				<div className="contents">
					<dt className="text-muted-foreground">{m.upgrade_commit()}</dt>
					<dd className="truncate text-foreground">
						<span className="font-mono text-[10.5px]">{shortCommit(status.head.commit) || "—"}</span>{" "}
						{status.head.subject}
					</dd>
				</div>
				<div className="contents">
					<dt className="text-muted-foreground">{m.repository_version()}</dt>
					<dd className="font-mono text-[10.5px] text-foreground">{status.version || "—"}</dd>
				</div>
				{upstreamRemote === undefined ? null : (
					<div className="contents">
						<dt className="text-muted-foreground">{m.repository_remotes()}</dt>
						<dd className="truncate font-mono text-[10.5px] text-muted-foreground">
							{upstreamRemote.fetchUrl}
						</dd>
					</div>
				)}
				<div className="contents">
					<dt className="text-muted-foreground">{m.repository_tags()}</dt>
					<dd className="truncate text-[10.5px] text-muted-foreground">
						{tags.length === 0 ? m.repository_none() : tags}
					</dd>
				</div>
			</dl>
			<DirtySummary dirty={status.dirty} />
		</div>
	);
}

/** Author identity for commits and merges the server creates. */
function GitIdentitySection() {
	const toast = useToast();
	const queryClient = useQueryClient();
	const identity = useQuery(orpc.admin.repository.identity.queryOptions());
	const [name, setName] = useState<string | null>(null);
	const [email, setEmail] = useState<string | null>(null);
	const save = useMutation(
		orpc.admin.repository.updateIdentity.mutationOptions({
			onError: (error) =>
				toast.error(m.repository_identity_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.repository_identity_saved());
				setName(null);
				setEmail(null);
				await queryClient.invalidateQueries({ queryKey: orpc.admin.repository.key() });
			},
		}),
	);
	const nameValue = name ?? identity.data?.name ?? "";
	const emailValue = email ?? identity.data?.email ?? "";
	const valid = nameValue.trim().length > 0 && /^\S+@\S+\.\S+$/u.test(emailValue.trim());
	return (
		<details className="rounded-lg border border-border/60 px-3 py-2">
			<summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
				{m.repository_identity()}
			</summary>
			<div className="mt-2 space-y-2">
				<p className="text-[10.5px] leading-4 text-muted-foreground">
					{m.repository_identity_help()}
				</p>
				{identity.isError ? (
					<InlineError
						message={`${m.repository_load_failed()}: ${identity.error.message}`}
						onRetry={() => void identity.refetch()}
						retryLabel={m.retry()}
					/>
				) : (
					<>
						<div className="grid gap-2 sm:grid-cols-2">
							<Input
								classNames={{ field: "h-8 rounded-md", input: "text-xs", root: "gap-1" }}
								label={m.repository_identity_name()}
								value={nameValue}
								onChange={setName}
							/>
							<Input
								classNames={{ field: "h-8 rounded-md", input: "text-xs", root: "gap-1" }}
								label={m.repository_identity_email()}
								type="email"
								value={emailValue}
								onChange={setEmail}
							/>
						</div>
						<Button
							disabled={!valid}
							loading={save.isPending}
							size="sm"
							onClick={() =>
								save.mutate({ email: emailValue.trim(), name: nameValue.trim() })
							}
						>
							{m.repository_identity_save()}
						</Button>
					</>
				)}
			</div>
		</details>
	);
}

export function RepositoryStatusCard() {
	const toast = useToast();
	const queryClient = useQueryClient();
	const [pushArmed, setPushArmed] = useState(false);
	const status = useQuery({
		...orpc.admin.repository.status.queryOptions(),
		staleTime: 15_000,
	});
	const invalidate = async () => {
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: orpc.admin.repository.key() }),
			queryClient.invalidateQueries({ queryKey: orpc.admin.upgrade.key() }),
		]);
	};
	const fetchRemote = useMutation(
		orpc.admin.repository.fetch.mutationOptions({
			onError: (error) =>
				toast.error(m.repository_fetch_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.repository_fetched());
				await invalidate();
			},
		}),
	);
	const pull = useMutation(
		orpc.admin.repository.pull.mutationOptions({
			onError: (error) =>
				toast.error(m.repository_pull_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.repository_pulled());
				await invalidate();
			},
		}),
	);
	const push = useMutation(
		orpc.admin.repository.push.mutationOptions({
			onError: (error) =>
				toast.error(m.repository_push_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.repository_pushed());
				setPushArmed(false);
				await invalidate();
			},
		}),
	);
	return (
		<Card size="compact">
			<CardHeader>
				<CardTitle as="h2">{m.repository_title()}</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				<p className="text-[11px] leading-4 text-muted-foreground">{m.repository_description()}</p>
				{status.isError ? (
					<InlineError
						message={`${m.repository_load_failed()}: ${status.error.message}`}
						onRetry={() => void status.refetch()}
						retryLabel={m.retry()}
					/>
				) : status.data === undefined ? (
					<p className="text-[11px] text-muted-foreground">{m.loading()}</p>
				) : (
					<RepositorySummary status={status.data} />
				)}
				<div className="flex flex-wrap items-center gap-1.5">
					<Button
						disabled={status.isFetching}
						leadingIcon={<RefreshCw className={status.isFetching ? "animate-spin" : undefined} />}
						size="xs"
						variant="outline"
						onClick={() => void status.refetch()}
					>
						{m.repository_refresh()}
					</Button>
					<Button
						leadingIcon={<Download />}
						loading={fetchRemote.isPending}
						size="xs"
						variant="outline"
						onClick={() => fetchRemote.mutate({})}
					>
						{m.repository_fetch()}
					</Button>
					<Button
						leadingIcon={<ArrowDownToLine />}
						loading={pull.isPending}
						size="xs"
						variant="outline"
						onClick={() => pull.mutate({})}
					>
						{m.repository_pull()}
					</Button>
					<Button
						disabled={status.data?.pushed === true || status.data?.branch === null}
						leadingIcon={<ArrowUpFromLine />}
						loading={push.isPending}
						size="xs"
						variant={pushArmed ? "primary" : "outline"}
						onClick={() => {
							if (!pushArmed) {
								setPushArmed(true);
								return;
							}
							push.mutate({ confirm: true });
						}}
					>
						{pushArmed ? m.repository_push_confirm() : m.repository_push()}
					</Button>
				</div>
				<GitIdentitySection />
			</CardContent>
		</Card>
	);
}
