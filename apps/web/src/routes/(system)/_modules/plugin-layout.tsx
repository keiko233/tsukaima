"use client";

import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Puzzle, Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Input } from "@elaina/ui/components/motion/input";
import { Skeleton, StatusDot } from "@elaina/sdk/ui";
import { orpc, type PluginRow } from "@/lib/api";
import { cn } from "@elaina/ui/lib/utils";
import { useMediaQuery } from "@/routes/_modules/hooks/use-media-query";
import { m } from "@/paraglide/messages";

function statusLabel(plugin: PluginRow): string {
	if (plugin.enabled !== 1) return m.plugins_status_disabled();
	const level = plugin.status?.level;
	if (level === "ok") return m.plugins_status_ok();
	if (level === "warning") return m.plugins_status_warning();
	if (level === "error") return m.plugins_status_error();
	return m.plugins_status_unknown();
}

export function PluginSidebar({ selectedId }: { selectedId?: string }) {
	const pluginsQuery = useQuery(orpc.admin.plugins.list.queryOptions());
	const plugins = pluginsQuery.data ?? [];
	const [search, setSearch] = useState("");
	const filtered = useMemo(() => {
		const query = search.trim().toLowerCase();
		if (query.length === 0) return plugins;
		return plugins.filter(
			(plugin) =>
				plugin.id.toLowerCase().includes(query) || plugin.name.toLowerCase().includes(query),
		);
	}, [plugins, search]);
	const navigate = useNavigate();

	return (
		<nav aria-label={m.nav_plugins()} className="flex min-h-0 flex-1 flex-col">
			<div className="shrink-0 px-2.5 pb-1.5 pt-2">
				<h1 className="text-[13px] font-semibold tracking-tight">{m.nav_plugins()}</h1>
				<p className="mt-0.5 text-[10.5px] text-muted-foreground">{m.plugins_sidebar_description()}</p>
				<Input
					aria-label={m.plugins_search_placeholder()}
					placeholder={m.plugins_search_placeholder()}
					value={search}
					onChange={setSearch}
					leftIcon={<Search />}
					classNames={{ field: "mt-2 h-8 rounded-md", input: "text-xs", root: "gap-0" }}
				/>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
				{pluginsQuery.isPending ? (
					<div className="space-y-2 px-1 py-2">
						<Skeleton className="h-11 w-full" />
						<Skeleton className="h-14 w-full" />
					</div>
				) : pluginsQuery.isError ? (
					<p className="px-2 py-4 text-center text-[11px] text-destructive">
						{pluginsQuery.error.message}
					</p>
				) : filtered.length === 0 ? (
					<p className="px-2 py-4 text-center text-[11px] text-muted-foreground">
						{search.length === 0 ? m.plugins_empty() : m.plugins_no_matches()}
					</p>
				) : (
					<ul className="space-y-1">
						{filtered.map((plugin) => {
							const selected = plugin.id === selectedId;
							return (
								<li key={plugin.id}>
									<button
										type="button"
										aria-current={selected ? "page" : undefined}
										onClick={() => {
											void navigate({
												params: { pluginId: plugin.id },
												to: "/plugins/$pluginId",
											});
										}}
										className={cn(
											"flex w-full items-start gap-2 rounded-md border border-transparent px-1.5 py-1.5 text-left outline-none transition-colors",
											"hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
											selected && "border-border bg-muted/70",
										)}
									>
										<span className="mt-1.5 flex size-3 items-center justify-center">
											{plugin.enabled === 1 ? (
												<StatusDot level={plugin.status?.level ?? "unknown"} />
											) : (
												<span className="size-2 rounded-full bg-muted-foreground/40" />
											)}
										</span>
										<span className="min-w-0 flex-1">
											<span className="flex items-baseline justify-between gap-2">
												<span className="truncate text-[12.5px] font-medium">{plugin.name}</span>
												<span className="shrink-0 text-[10px] text-muted-foreground">
													{plugin.version}
												</span>
											</span>
											<span className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
												<span className="truncate">{statusLabel(plugin)}</span>
											</span>
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</nav>
	);
}

export function PluginLayout({ children }: { children: ReactNode }) {
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const mobile = useMediaQuery("(max-width: 767px)");
	const selectedId = pathname.startsWith("/plugins/")
		? decodeURIComponent(pathname.slice("/plugins/".length))
		: undefined;
	const showList = !mobile || selectedId === undefined;
	const showDetail = !mobile || selectedId !== undefined;

	return (
		<div className="flex min-h-0 flex-1 overflow-hidden">
			<aside
				className={cn(
					"min-h-0 shrink-0 flex-col border-border bg-sidebar md:flex md:w-60 md:border-r lg:w-64",
					showList ? "flex w-full" : "hidden",
				)}
			>
				<PluginSidebar selectedId={selectedId} />
			</aside>
			<div
				className={cn(
					"min-h-0 min-w-0 flex-1 overflow-y-auto",
					showDetail ? "block" : "hidden md:block",
				)}
			>
				<div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-4 py-4 sm:px-5">
					{children}
				</div>
			</div>
		</div>
	);
}

export function PluginListPlaceholder({ children }: { children?: ReactNode }) {
	return (
		<div className="grid flex-1 place-items-center px-6 py-16 text-center">
			<div className="max-w-xs space-y-1.5">
				<Puzzle className="mx-auto size-6 text-muted-foreground/70" />
				<p className="text-[12.5px] font-medium">{m.nav_plugins()}</p>
				<p className="text-[11px] leading-4 text-muted-foreground">
					{m.plugins_sidebar_description()}
				</p>
				{children}
			</div>
		</div>
	);
}
