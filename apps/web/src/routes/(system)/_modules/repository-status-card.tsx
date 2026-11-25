"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, Download, RefreshCw, Rocket } from "lucide-react";
import { Button } from "@tsukaima/ui/components/motion/button";
import { EditorialGroup, ExpandableRow } from "@tsukaima/ui";
import { Input } from "@tsukaima/ui/components/motion/input";
import { orpc, type RepositoryStatus } from "@/lib/api";
import { m } from "@/paraglide/messages";
import { errorMessage, useToast } from "@/lib/toast";
import { InlineError } from "../../_modules/shell/primitives";

function DirtySummary({ dirty }: { readonly dirty: RepositoryStatus["dirty"] }) {
	const counts = [
		{ label: m.repository_staged(), value: dirty.staged },
		{ label: m.repository_modified(), value: dirty.modified },
		{ label: m.repository_untracked(), value: dirty.untracked },
		{ label: m.repository_conflicted(), value: dirty.conflicted },
	].filter((entry) => entry.value > 0);
	if (counts.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-x-3 gap-y-1">
			{counts.map((entry) => (
				<span key={entry.label} className="text-xs text-warning">
					{entry.label} <span className="font-mono tabular-nums">{entry.value}</span>
				</span>
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
			<div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
				{status.upstream !== null && (
					<>
						<span>
							{m.repository_ahead()}{" "}
							<span className="font-mono tabular-nums">{status.upstream.ahead}</span>
						</span>
						<span>
							{m.repository_behind()}{" "}
							<span className="font-mono tabular-nums">{status.upstream.behind}</span>
						</span>
					</>
				)}
				<span className={status.pushed ? "text-success" : "text-warning"}>
					{status.pushed ? m.repository_pushed() : m.repository_unpushed()}
				</span>
			</div>
			<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
				<div className="contents">
					<dt className="text-muted-foreground">{m.upgrade_commit()}</dt>
					<dd className="truncate text-foreground">{status.head.subject}</dd>
				</div>
				{upstreamRemote === undefined ? null : (
					<div className="contents">
						<dt className="text-muted-foreground">{m.repository_remotes()}</dt>
						<dd className="truncate font-mono tabular-nums text-[11px] text-muted-foreground">
							{upstreamRemote.fetchUrl}
						</dd>
					</div>
				)}
				<div className="contents">
					<dt className="text-muted-foreground">{m.repository_tags()}</dt>
					<dd className="truncate text-[11px] text-muted-foreground">
						{tags.length === 0 ? m.repository_none() : tags}
					</dd>
				</div>
			</dl>
			<DirtySummary dirty={status.dirty} />
		</div>
	);
}

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
	const valid = nameValue.trim().length > 0 && /^[\w.+-]+@[\w.-]+$/u.test(emailValue.trim());
	return (
		<ExpandableRow summary={m.repository_identity()}>
			<div className="mt-2 space-y-2">
				<p className="text-[11px] leading-4 text-muted-foreground">
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
							onClick={() => save.mutate({ email: emailValue.trim(), name: nameValue.trim() })}
						>
							{m.repository_identity_save()}
						</Button>
					</>
				)}
			</div>
		</ExpandableRow>
	);
}

async function invalidateRepository(queryClient: ReturnType<typeof useQueryClient>) {
	await Promise.all([
		queryClient.invalidateQueries({ queryKey: orpc.admin.repository.key() }),
		queryClient.invalidateQueries({ queryKey: orpc.admin.upgrade.key() }),
		queryClient.invalidateQueries({ queryKey: orpc.admin.runtime.key() }),
	]);
}

export function RepositoryFetchButton() {
	const toast = useToast();
	const queryClient = useQueryClient();
	const fetchRemote = useMutation(
		orpc.admin.repository.fetch.mutationOptions({
			onError: (error) =>
				toast.error(m.repository_fetch_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.repository_fetched());
				await invalidateRepository(queryClient);
			},
		}),
	);
	return (
		<Button
			leadingIcon={<Download />}
			loading={fetchRemote.isPending}
			size="sm"
			variant="outline"
			onClick={() => fetchRemote.mutate({})}
		>
			{m.repository_fetch()}
		</Button>
	);
}

export function RepositoryStatusCard({ showFetch = true }: { showFetch?: boolean } = {}) {
	const toast = useToast();
	const queryClient = useQueryClient();
	const [pushArmed, setPushArmed] = useState(false);
	const status = useQuery({
		...orpc.admin.repository.status.queryOptions(),
		staleTime: 15_000,
	});
	const restart = useQuery(orpc.admin.runtime.restartStatus.queryOptions());
	const invalidate = () => invalidateRepository(queryClient);

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
	const pullAndRestart = useMutation({
		mutationFn: async () => {
			await orpc.admin.repository.pull.call({});
			return await orpc.admin.runtime.scheduleRestart.call({
				delaySeconds: 60,
				mode: "update",
				reason: "pull and upgrade restart requested from WebUI",
			});
		},
		onError: async (error) => {
			toast.error(m.repository_pull_and_restart_failed(), { description: errorMessage(error) });
			await invalidate();
		},
		onSuccess: async () => {
			toast.success(m.repository_pulled_and_restarting());
			await invalidate();
		},
	});
	const restartActive =
		restart.data?.status === "scheduled" || restart.data?.status === "executing";
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
		<EditorialGroup title={m.repository_title()} description={m.repository_description()}>
			<div className="space-y-4">
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
					{showFetch && <RepositoryFetchButton />}
					<Button
						disabled={pullAndRestart.isPending}
						leadingIcon={<ArrowDownToLine />}
						loading={pull.isPending}
						size="xs"
						variant="outline"
						onClick={() => pull.mutate({})}
					>
						{m.repository_pull()}
					</Button>
					<Button
						disabled={
							pull.isPending ||
							restartActive ||
							status.data?.branch === null ||
							status.data?.upstream === null
						}
						leadingIcon={<Rocket />}
						loading={pullAndRestart.isPending}
						size="xs"
						variant="primary"
						onClick={() => pullAndRestart.mutate()}
					>
						{m.repository_pull_and_restart()}
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
			</div>
		</EditorialGroup>
	);
}
