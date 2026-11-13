"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Radio, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@elaina/ui/components/motion/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@elaina/ui/components/motion/card";
import { Input } from "@elaina/ui/components/motion/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@elaina/ui/components/motion/select";
import { Switch } from "@elaina/ui/components/motion/switch";
import { orpc, type LogEntry, type LogLevel, type LogSnapshot } from "@/lib/api";
import { runtimeUrl } from "@/lib/runtime-url";
import { errorMessage, useToast } from "@/lib/toast";
import { cn } from "@elaina/ui/lib/utils";
import { m } from "@/paraglide/messages";
import { LogTerminal } from "./log-terminal";
import { SystemPage } from "./page-header";

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const LOG_STREAM_URL = runtimeUrl("/events/logs");

type LogFilter = "all" | LogLevel;
type LogStreamState = "connecting" | "live" | "reconnecting";

function parseStreamData<T>(event: Event): T | null {
	try {
		return JSON.parse((event as MessageEvent<string>).data) as T;
	} catch {
		return null;
	}
}

export function DiagnosticsPage() {
	const toast = useToast();
	const queryClient = useQueryClient();
	const diagnosticsQuery = useQuery(orpc.admin.diagnostics.status.queryOptions());
	const settingsQuery = useQuery(orpc.admin.settings.get.queryOptions());
	const logsQuery = useQuery(orpc.admin.diagnostics.logs.queryOptions());
	const [entries, setEntries] = useState<LogEntry[]>([]);
	const [capacity, setCapacity] = useState(2_000);
	const [filterLevel, setFilterLevel] = useState<LogFilter>("all");
	const [follow, setFollow] = useState(true);
	const [search, setSearch] = useState("");
	const [streamState, setStreamState] = useState<LogStreamState>("connecting");
	const receivedSnapshot = useRef(false);
	const capacityRef = useRef(capacity);

	const updateSettings = useMutation(
		orpc.admin.settings.update.mutationOptions({
			onError: (error) =>
				toast.error(m.toast_settings_save_failed(), {
					description: errorMessage(error),
				}),
			onSuccess: async () => {
				toast.success(m.toast_settings_saved());
				await queryClient.invalidateQueries({ queryKey: orpc.admin.key() });
			},
		}),
	);
	const clearLogs = useMutation(
		orpc.admin.diagnostics.clearLogs.mutationOptions({
			onError: (error) =>
				toast.error(m.toast_logs_clear_failed(), {
					description: errorMessage(error),
				}),
			onSuccess: ({ cleared }) => {
				const emptySnapshot: LogSnapshot = { capacity, dropped: 0, entries: [] };
				setEntries([]);
				queryClient.setQueryData(orpc.admin.diagnostics.logs.queryKey(), emptySnapshot);
				toast.success(m.toast_logs_cleared(), {
					description: m.toast_logs_cleared_description({ count: cleared }),
				});
			},
		}),
	);

	useEffect(() => {
		const snapshot = logsQuery.data;
		if (snapshot === undefined || receivedSnapshot.current) return;
		capacityRef.current = snapshot.capacity;
		setCapacity(snapshot.capacity);
		setEntries([...snapshot.entries]);
	}, [logsQuery.data]);

	useEffect(() => {
		const source = new EventSource(LOG_STREAM_URL, { withCredentials: true });
		const handleSnapshot = (event: Event) => {
			const snapshot = parseStreamData<LogSnapshot>(event);
			if (snapshot === null) return;
			receivedSnapshot.current = true;
			capacityRef.current = snapshot.capacity;
			setCapacity(snapshot.capacity);
			setEntries([...snapshot.entries]);
			setStreamState("live");
		};
		const handleLog = (event: Event) => {
			const entry = parseStreamData<LogEntry>(event);
			if (entry === null) return;
			setEntries((previous) => {
				if (previous.some((item) => item.id === entry.id)) return previous;
				return [...previous, entry].slice(-Math.max(1, capacityRef.current));
			});
		};
		source.addEventListener("open", () => setStreamState("live"));
		source.addEventListener("snapshot", handleSnapshot);
		source.addEventListener("log", handleLog);
		source.addEventListener("error", () => setStreamState("reconnecting"));
		return () => {
			source.close();
		};
	}, []);

	const filteredEntries = useMemo(() => {
		const query = search.trim().toLowerCase();
		return entries.filter(
			(entry) =>
				(filterLevel === "all" || entry.level === filterLevel) &&
				(query.length === 0 || entry.text.toLowerCase().includes(query)),
		);
	}, [entries, filterLevel, search]);

	if (diagnosticsQuery.isPending || settingsQuery.isPending) {
		return <Card className="p-4">{m.loading()}</Card>;
	}

	if (diagnosticsQuery.isError) {
		return <Card className="p-4">{diagnosticsQuery.error.message}</Card>;
	}

	const diagnostics = diagnosticsQuery.data;
	const settings = settingsQuery.data ?? { logLevel: "info" };
	const streamLabel =
		streamState === "live"
			? m.diagnostics_logs_live()
			: streamState === "reconnecting"
				? m.diagnostics_logs_reconnecting()
				: m.diagnostics_logs_connecting();

	return (
		<SystemPage fill description={m.diagnostics_page_description()} title={m.nav_diagnostics()}>
			<div className="flex min-h-0 flex-1 flex-col gap-4">
				<Card size="compact" className="shrink-0">
					<CardContent>
						<dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 xl:grid-cols-6">
							<div className="min-w-0">
								<dt className="text-xs text-muted-foreground">{m.diagnostics_state_label()}</dt>
								<dd className="mt-1 truncate font-medium">{diagnostics.state.stage}</dd>
							</div>
							<div className="min-w-0">
								<dt className="text-xs text-muted-foreground">{m.diagnostics_channels_label()}</dt>
								<dd className="mt-1 font-medium">
									{diagnostics.channels
										.map((channel) => `${channel.id}: ${channel.connected ? "true" : "false"}`)
										.join(", ") || "false"}
								</dd>
							</div>
							<div className="min-w-0">
								<dt className="text-xs text-muted-foreground">{m.diagnostics_processed_label()}</dt>
								<dd className="mt-1 font-mono tabular-nums">{diagnostics.processedMessages}</dd>
							</div>
							<div className="min-w-0">
								<dt className="text-xs text-muted-foreground">{m.diagnostics_log_level_label()}</dt>
								<dd className="mt-1 font-mono">{diagnostics.logLevel}</dd>
							</div>
							<div className="min-w-0">
								<dt className="text-xs text-muted-foreground">
									{m.diagnostics_usage_input_label()}
								</dt>
								<dd className="mt-1 font-mono tabular-nums">
									{diagnostics.usageTotals.inputTokens}
								</dd>
							</div>
							<div className="min-w-0">
								<dt className="text-xs text-muted-foreground">
									{m.diagnostics_usage_output_label()}
								</dt>
								<dd className="mt-1 font-mono tabular-nums">
									{diagnostics.usageTotals.outputTokens}
								</dd>
							</div>
						</dl>
						{diagnostics.channels.some((channel) => channel.restartRequired) ||
						diagnostics.providerRestartRequired ? (
							<p className="mt-4 border-t border-border pt-3 text-xs text-destructive">
								{m.settings_restart_hint()}
							</p>
						) : null}
						{diagnostics.lastError !== undefined ? (
							<p className="mt-3 break-words text-xs text-destructive">
								{m.diagnostics_last_error_label()} {diagnostics.lastError}
							</p>
						) : null}
					</CardContent>
				</Card>

				<Card size="compact" className="flex min-h-0 flex-1 flex-col">
					<CardHeader className="shrink-0">
						<div className="flex flex-wrap items-center gap-2">
							<CardTitle as="h2">{m.diagnostics_logs_title()}</CardTitle>
							<span
								className={cn(
									"inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
									streamState === "live"
										? "border-success/30 bg-success/10 text-success"
										: "border-border text-muted-foreground",
								)}
							>
								<span className="relative flex size-1.5">
									{streamState === "live" ? (
										<span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
									) : null}
									<span
										className={cn(
											"relative inline-flex size-1.5 rounded-full",
											streamState === "live" ? "bg-success" : "bg-muted-foreground",
										)}
									/>
								</span>
								{streamLabel}
							</span>
						</div>
						<CardDescription>{m.diagnostics_logs_description()}</CardDescription>
						<CardAction>
							<Button
								variant="outline"
								size="sm"
								disabled={clearLogs.isPending || entries.length === 0}
								onClick={() => clearLogs.mutate()}
							>
								<Trash2 className="size-3.5" />
								{m.diagnostics_logs_clear()}
							</Button>
						</CardAction>
					</CardHeader>
					<CardContent className="flex min-h-0 flex-1 flex-col gap-3">
						<div className="grid shrink-0 gap-2 lg:grid-cols-[minmax(12rem,1fr)_10rem_9rem_auto] lg:items-end">
							<Input
								aria-label={m.diagnostics_logs_search_placeholder()}
								placeholder={m.diagnostics_logs_search_placeholder()}
								value={search}
								onChange={setSearch}
								leftIcon={<Search />}
							/>
							<div className="space-y-1.5">
								<label className="px-1 text-xs font-medium text-muted-foreground">
									{m.settings_log_level_label()}
								</label>
								<Select
									value={settings.logLevel}
									disabled={updateSettings.isPending}
									onValueChange={(value) => {
										updateSettings.mutate({ logLevel: value as LogLevel });
									}}
								>
									<SelectTrigger className="w-full">
										<SelectValue placeholder={m.settings_log_level_label()} />
									</SelectTrigger>
									<SelectContent>
										{LOG_LEVELS.map((level) => (
											<SelectItem key={level} value={level}>
												{level}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-1.5">
								<label className="px-1 text-xs font-medium text-muted-foreground">
									{m.diagnostics_logs_filter_label()}
								</label>
								<Select
									value={filterLevel}
									onValueChange={(value) => setFilterLevel(value as LogFilter)}
								>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="all">{m.diagnostics_logs_all_levels()}</SelectItem>
										{LOG_LEVELS.map((level) => (
											<SelectItem key={level} value={level}>
												{level}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<Switch
								checked={follow}
								onCheckedChange={setFollow}
								label={m.diagnostics_logs_follow()}
								className="h-11"
							/>
						</div>
						<LogTerminal
							className="min-h-64 max-h-none flex-1"
							entries={filteredEntries}
							follow={follow}
							emptyLabel={m.diagnostics_logs_empty()}
						/>
						<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
							<span>
								{m.diagnostics_logs_buffer({
									capacity,
									count: entries.length,
								})}
							</span>
							{filteredEntries.length !== entries.length ? (
								<span>
									{m.diagnostics_logs_filtered({
										count: filteredEntries.length,
									})}
								</span>
							) : null}
							<span className="inline-flex items-center gap-1 font-mono">
								<Radio className="size-3" />
								ansi
							</span>
						</div>
					</CardContent>
				</Card>
			</div>
		</SystemPage>
	);
}
