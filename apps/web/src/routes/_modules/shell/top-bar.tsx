"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	Activity,
	ChevronDown,
	Circle,
	LogOut,
	Moon,
	PanelLeft,
	Puzzle,
	Settings,
	SlidersHorizontal,
	Sparkles,
	Sun,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/motion/button";
import {
	MorphPopover,
	MorphPopoverContent,
	MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import { orpc, type DiagnosticsData } from "@/lib/api";
import { applyTheme, getInitialTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

type ConnectionTone = "success" | "warning" | "danger" | "muted";

function connectionStatus(data: DiagnosticsData | undefined): {
	label: () => string;
	tone: ConnectionTone;
} {
	if (data === undefined) return { label: m.connect_connecting, tone: "muted" };
	const state = data.onebotState;
	if (!data.onebotConfigured) {
		return data.onebotRestartRequired
			? { label: m.connect_disconnected, tone: "danger" }
			: { label: m.connect_unconfigured, tone: "muted" };
	}
	if (state === "open" && data.onebotConnected) {
		return { label: m.connect_connected, tone: "success" };
	}
	if (state === "connecting") return { label: m.connect_connecting, tone: "warning" };
	if (state === "reconnecting") return { label: m.connect_reconnecting, tone: "warning" };
	if (data.onebotLastErrorClass !== null) {
		return { label: m.connect_error, tone: "danger" };
	}
	return { label: m.connect_disconnected, tone: "danger" };
}

const toneClass: Record<ConnectionTone, string> = {
	danger: "text-destructive",
	muted: "text-muted-foreground",
	success: "text-(--color-success)",
	warning: "text-warning",
};

export function TopBar({
	mobile,
	onToggleSidebar,
}: {
	mobile: boolean;
	onToggleSidebar: () => void;
}) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [theme, setTheme] = useState<Theme>(() => getInitialTheme());
	const diagnostics = useQuery(orpc.admin.diagnostics.status.queryOptions());
	const authStatus = useQuery(orpc.auth.status.queryOptions());
	const signOut = useMutation(
		orpc.auth.logout.mutationOptions({
			onSuccess: async () => {
				await queryClient.invalidateQueries({ queryKey: orpc.auth.status.queryKey() });
				void navigate({ replace: true, to: "/login" });
			},
		}),
	);
	const status = connectionStatus(diagnostics.data);

	const toggleTheme = () => {
		const next = theme === "dark" ? "light" : "dark";
		setTheme(next);
		applyTheme(next);
	};

	return (
		<header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-3 sm:px-4">
			<Button
				variant="ghost"
				size="icon"
				onClick={onToggleSidebar}
				aria-label={mobile ? m.topbar_sidebar_toggle() : m.topbar_sidebar_toggle()}
				className="size-9 rounded-lg"
			>
				<PanelLeft className="size-4" />
			</Button>
			<div className="flex min-w-0 items-center gap-2.5">
				<span className="grid size-8 place-items-center rounded-xl bg-primary text-primary-foreground">
					<Sparkles className="size-4" />
				</span>
				<div className="min-w-0">
					<div className="truncate text-sm font-semibold tracking-tight">Elaina</div>
					<div className="hidden text-[11px] text-muted-foreground sm:block">{m.app_title()}</div>
				</div>
			</div>

			<div className="ml-auto flex items-center gap-1">
				<span
					className={cn(
						"mr-1 hidden h-8 items-center gap-1.5 rounded-full border border-border px-3 text-xs font-medium sm:inline-flex",
						toneClass[status.tone],
					)}
					title={status.label()}
				>
					<Circle className="size-2 fill-current" />
					<span className="max-w-28 truncate">{status.label()}</span>
				</span>
				<span
					role="status"
					aria-label={status.label()}
					title={status.label()}
					className={cn(
						"inline-flex size-8 items-center justify-center text-[10px] font-medium sm:hidden",
						toneClass[status.tone],
					)}
				>
					<Circle className="size-2.5 fill-current" />
				</span>
				<Button
					variant="ghost"
					size="icon"
					onClick={() => void navigate({ to: "/plugins" })}
					aria-label={m.nav_plugins()}
					title={m.nav_plugins()}
					className="size-9 rounded-lg"
				>
					<Puzzle className="size-4" />
				</Button>
				<Button
					variant="ghost"
					size="icon"
					onClick={() => void navigate({ to: "/settings" })}
					aria-label={m.nav_settings()}
					title={m.nav_settings()}
					className="size-9 rounded-lg"
				>
					<Settings className="size-4" />
				</Button>
				<MorphPopover>
					<MorphPopoverTrigger>
						<Button
							variant="ghost"
							size="sm"
							aria-label={m.nav_more()}
							title={m.nav_more()}
							className="h-9 gap-1 rounded-lg px-2.5"
						>
							<span className="hidden text-xs sm:inline">{m.nav_more_short()}</span>
							<ChevronDown className="size-4" />
						</Button>
					</MorphPopoverTrigger>
					<MorphPopoverContent align="end" sideOffset={8} radius={12} className="w-56 p-1.5">
						<button
							type="button"
							onClick={() => void navigate({ to: "/policies" })}
							className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
						>
							<SlidersHorizontal className="size-4 text-muted-foreground" />
							{m.nav_policies()}
						</button>
						<button
							type="button"
							onClick={() => void navigate({ to: "/diagnostics" })}
							className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
						>
							<Activity className="size-4 text-muted-foreground" />
							{m.nav_diagnostics()}
						</button>
						<div className="my-1 h-px bg-border" />
						<button
							type="button"
							onClick={toggleTheme}
							className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
						>
							{theme === "dark" ? (
								<Sun className="size-4 text-muted-foreground" />
							) : (
								<Moon className="size-4 text-muted-foreground" />
							)}
							{m.theme_toggle()}
						</button>
						<div className="my-1 h-px bg-border" />
						{authStatus.data?.username === undefined ? null : (
							<div className="truncate px-2.5 pb-1 text-[11px] text-muted-foreground">
								{m.auth_signed_in_as({ username: authStatus.data.username })}
							</div>
						)}
						<button
							type="button"
							disabled={signOut.isPending}
							onClick={() => signOut.mutate()}
							className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
						>
							<LogOut className="size-4 text-muted-foreground" />
							{m.auth_sign_out()}
						</button>
					</MorphPopoverContent>
				</MorphPopover>
			</div>
		</header>
	);
}
