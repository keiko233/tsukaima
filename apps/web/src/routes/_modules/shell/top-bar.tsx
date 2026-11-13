"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	ChevronDown,
	LogOut,
	Moon,
	PanelLeft,
	Puzzle,
	Settings,
	Sparkles,
	Sun,
	Terminal,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button, IconButton } from "@elaina/ui/components/motion/button";
import {
	MorphPopover,
	MorphPopoverContent,
	MorphPopoverTrigger,
} from "@elaina/ui/components/motion/popover-morph";
import { orpc } from "@/lib/api";
import { authClient, authSessionQueryKey, authSessionQueryOptions } from "@/lib/auth";
import { applyTheme, getInitialTheme, type Theme } from "@/lib/theme";
import { cn } from "@elaina/ui/lib/utils";
import { m } from "@/paraglide/messages";
import { LogPanel } from "./log-panel";

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
	const [logsOpen, setLogsOpen] = useState(false);
	const session = useQuery(authSessionQueryOptions());
	const signOut = useMutation({
		mutationFn: async () => {
			const { error } = await authClient.signOut();
			if (error !== null) throw error;
		},
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: authSessionQueryKey }),
				queryClient.invalidateQueries({ queryKey: orpc.auth.status.queryKey() }),
			]);
			void navigate({ replace: true, to: "/login" });
		},
	});
	const toggleTheme = () => {
		const next = theme === "dark" ? "light" : "dark";
		setTheme(next);
		applyTheme(next);
	};

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!(event.ctrlKey || event.metaKey) || event.key !== "`") return;
			event.preventDefault();
			setLogsOpen((value) => !value);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	return (
		<>
			<header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-3 sm:px-4">
				<IconButton
					label={mobile ? m.topbar_sidebar_toggle() : m.topbar_sidebar_toggle()}
					className="size-9 rounded-lg"
					onClick={onToggleSidebar}
				>
					<PanelLeft className="size-4" />
				</IconButton>
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
					<IconButton
						label={m.logs_title()}
						title={`${m.logs_title()} (${m.logs_shortcut()})`}
						className={cn("size-9 rounded-lg", logsOpen && "bg-muted text-foreground")}
						onClick={() => setLogsOpen((value) => !value)}
					>
						<Terminal className="size-4" />
					</IconButton>
					<IconButton
						label={m.nav_plugins()}
						className="size-9 rounded-lg"
						onClick={() => void navigate({ to: "/plugins" })}
					>
						<Puzzle className="size-4" />
					</IconButton>
					<IconButton
						label={m.nav_settings()}
						className="size-9 rounded-lg"
						onClick={() => void navigate({ to: "/settings" })}
					>
						<Settings className="size-4" />
					</IconButton>
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
						<Button
							className="h-auto justify-start rounded-lg px-2.5 py-2"
							fullWidth
							leadingIcon={theme === "dark" ? <Sun /> : <Moon />}
							onClick={toggleTheme}
							variant="ghost"
						>
							{m.theme_toggle()}
						</Button>
						<div className="my-1 h-px bg-border" />
						{session.data?.user === undefined ? null : (
							<div className="truncate px-2.5 pb-1 text-[11px] text-muted-foreground">
								{m.auth_signed_in_as({
									username: session.data.user.username ?? session.data.user.name,
								})}
							</div>
						)}
						<Button
							className="h-auto justify-start rounded-lg px-2.5 py-2"
							disabled={signOut.isPending}
							fullWidth
							leadingIcon={<LogOut />}
							onClick={() => signOut.mutate()}
							variant="ghost"
						>
							{m.auth_sign_out()}
						</Button>
					</MorphPopoverContent>
				</MorphPopover>
				</div>
			</header>
			<LogPanel open={logsOpen} onClose={() => setLogsOpen(false)} />
		</>
	);
}
