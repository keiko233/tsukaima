"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogIn, LogOut } from "lucide-react";
import { Button } from "@tsukaima/ui/components/motion/button";
import { EditorialGroup } from "@tsukaima/ui";
import { orpc, type GitHubLoginStart, type GitHubRun, type GitHubStatus } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { m } from "@/paraglide/messages";
import { InlineError } from "../../_modules/shell/primitives";

function LoginSection({ status }: { readonly status: GitHubStatus }) {
	const toast = useToast();
	const queryClient = useQueryClient();
	const [device, setDevice] = useState<GitHubLoginStart | null>(null);
	const handled = useRef<string | undefined>(undefined);

	const start = useMutation(
		orpc.admin.github.loginStart.mutationOptions({
			onError: (error) =>
				toast.error(m.github_login_failed(), { description: errorMessage(error) }),
			onSuccess: (result) => {
				handled.current = undefined;
				setDevice(result);
			},
		}),
	);
	const poll = useQuery({
		...orpc.admin.github.loginPoll.queryOptions(),
		enabled: device !== null,
		refetchOnWindowFocus: false,
		refetchInterval: (query) => {
			if (device === null) return false;
			const current = query.state.data?.status;
			return current === "authorized" ||
				current === "expired" ||
				current === "failed" ||
				current === "idle"
				? false
				: 3_000;
		},
	});
	const pollStatus = poll.data?.status;
	useEffect(() => {
		if (pollStatus === undefined || handled.current === poll.data?.status) return;
		if (pollStatus === "authorized") {
			handled.current = pollStatus;
			toast.success(m.github_login_success());
			setDevice(null);
			void queryClient.invalidateQueries({ queryKey: orpc.admin.github.key() });
			return;
		}
		if (pollStatus === "expired" || pollStatus === "failed" || pollStatus === "idle") {
			handled.current = pollStatus;
			toast.error(
				pollStatus === "expired"
					? m.github_login_expired()
					: (poll.data?.message ?? m.github_login_failed()),
			);
			setDevice(null);
		}
	}, [poll.data?.message, pollStatus, queryClient, toast]);

	const logout = useMutation(
		orpc.admin.github.logout.mutationOptions({
			onError: (error) =>
				toast.error(m.github_logout_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.github_logged_out());
				setDevice(null);
				await queryClient.invalidateQueries({ queryKey: orpc.admin.github.key() });
			},
		}),
	);

	if (!status.available) {
		return <p className="text-[11px] leading-4 text-muted-foreground">{m.github_cli_missing()}</p>;
	}

	if (status.configured && status.login !== null) {
		return (
			<div className="space-y-2">
				<div className="flex flex-wrap items-center gap-2 border-b border-border/70 pb-2 text-[11px]">
					<span className="font-medium text-foreground">
						{m.github_login_signed_in()} {status.login}
					</span>
					<span className="font-mono tabular-nums text-muted-foreground">
						{status.host}
						{status.gitProtocol === null ? "" : ` · ${status.gitProtocol}`}
					</span>
					{status.scopes.length === 0 ? null : (
						<span className="text-muted-foreground">
							{m.github_scopes()}: {status.scopes.join(", ")}
						</span>
					)}
					<Button
						className="ml-auto"
						leadingIcon={<LogOut />}
						loading={logout.isPending}
						size="xs"
						variant="ghost"
						onClick={() => logout.mutate()}
					>
						{m.github_logout()}
					</Button>
				</div>
				{status.error === null ? null : (
					<p className="text-[11px] leading-4 text-destructive">{status.error}</p>
				)}
			</div>
		);
	}

	if (device !== null) {
		return (
			<div className="space-y-2 border-t border-border/70 pt-3">
				<p className="text-[11px] leading-4 text-muted-foreground">{m.github_login_code_hint()}</p>
				<div className="flex flex-wrap items-center gap-2">
					<code className="font-mono tabular-nums text-sm font-semibold tracking-widest">
						{device.userCode}
					</code>
					<a
						className="font-mono text-[11px] text-primary underline underline-offset-4"
						href={device.verificationUri}
						rel="noreferrer"
						target="_blank"
					>
						{device.verificationUri}
					</a>
				</div>
				<p className="text-[11px] text-muted-foreground">{m.github_login_waiting()}</p>
			</div>
		);
	}

	return (
		<div className="space-y-2">
			<Button
				leadingIcon={<LogIn />}
				loading={start.isPending}
				size="sm"
				onClick={() => start.mutate()}
			>
				{m.github_login_start()}
			</Button>
			<p className="text-[11px] leading-4 text-muted-foreground">{m.github_login_help()}</p>
		</div>
	);
}

export function GitHubCard() {
	const status = useQuery({
		...orpc.admin.github.status.queryOptions(),
		staleTime: 15_000,
	});
	return (
		<EditorialGroup title={m.github_title()} description={m.github_description()}>
			<div className="space-y-3">
				{status.isError ? (
					<InlineError
						message={`${m.github_load_failed()}: ${status.error.message}`}
						onRetry={() => void status.refetch()}
						retryLabel={m.retry()}
					/>
				) : status.data === undefined ? (
					<p className="text-[11px] text-muted-foreground">{m.loading()}</p>
				) : (
					<LoginSection status={status.data} />
				)}
			</div>
		</EditorialGroup>
	);
}

function runTone(run: GitHubRun): string {
	if (run.conclusion === "success") return "text-success";
	if (run.conclusion === null) return "text-warning";
	return "text-destructive";
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
		<EditorialGroup title={m.github_activity_title()} description={m.github_activity_description()}>
			<div className="space-y-3">
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
						<div className="overflow-x-auto">
							<table aria-label={m.github_runs()} className="w-full text-xs">
								<thead className="border-b border-border text-muted-foreground">
									<tr>
										<th scope="col" className="py-2 pe-4 text-start font-medium">
											{m.github_runs()}
										</th>
										<th scope="col" className="py-2 pe-4 text-start font-medium">
											{m.request_status()}
										</th>
										<th scope="col" className="py-2 text-start font-medium">
											{m.upgrade_commit()}
										</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-border/70">
									{runs.data.map((run) => (
										<tr key={run.id}>
											<td className="py-2 pe-4">
												<a
													className="font-medium underline-offset-4 hover:underline"
													href={run.url}
													rel="noreferrer"
													target="_blank"
												>
													{run.name}
												</a>
											</td>
											<td className={`py-2 pe-4 font-mono tabular-nums ${runTone(run)}`}>
												{run.conclusion ?? run.status}
											</td>
											<td className="py-2 font-mono tabular-nums text-muted-foreground">
												{run.headSha.slice(0, 7)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
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
									<span className="font-mono tabular-nums text-[11px] text-muted-foreground">
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
									<span className="ml-auto text-[11px] text-muted-foreground">
										{pull.head} → {pull.base}
									</span>
								</li>
							))}
						</ul>
					)}
				</div>
			</div>
		</EditorialGroup>
	);
}
