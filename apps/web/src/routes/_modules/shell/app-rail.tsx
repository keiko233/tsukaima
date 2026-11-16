"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
	Brain,
	Inbox,
	LogOut,
	MessageSquare,
	Moon,
	MoreHorizontal,
	Puzzle,
	Settings,
	Sparkles,
	Sun,
	Terminal,
	Users,
	UsersRound,
	type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@tsukaima/ui/components/motion/button";
import {
	MorphPopover,
	MorphPopoverContent,
	MorphPopoverTrigger,
} from "@tsukaima/ui/components/motion/popover-morph";
import { cn } from "@tsukaima/ui/lib/utils";
import { orpc } from "@/lib/api";
import { authClient, authSessionQueryKey, authSessionQueryOptions } from "@/lib/auth";
import { applyTheme, getInitialTheme, type Theme } from "@/lib/theme";
import { m } from "@/paraglide/messages";
import { LogPanel } from "./log-panel";

type RailDestination =
	| "/"
	| "/groups"
	| "/memories"
	| "/plugins"
	| "/requests"
	| "/settings"
	| "/users";

function destinationActive(destination: RailDestination, pathname: string): boolean {
	if (destination === "/") return pathname === "/" || pathname.startsWith("/chat/");
	return pathname === destination || pathname.startsWith(`${destination}/`);
}

function RailItem({
	active = false,
	badge,
	icon: Icon,
	label,
	onClick,
}: {
	active?: boolean;
	badge?: number;
	icon: LucideIcon;
	label: string;
	onClick?: () => void;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			aria-pressed={onClick === undefined ? undefined : active}
			title={label}
			onClick={onClick}
			className={cn(
				"relative grid size-9 place-items-center rounded-lg text-muted-foreground outline-none transition-colors",
				"hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
				active && "bg-primary/12 text-primary hover:bg-primary/15 hover:text-primary",
			)}
		>
			<Icon className="size-[18px]" />
			{badge !== undefined && badge > 0 ? (
				<span className="absolute top-0.5 right-0.5 grid min-w-3.5 place-items-center rounded-full bg-primary px-1 text-[8.5px] leading-3.5 font-medium text-primary-foreground">
					{badge > 99 ? "99+" : badge}
				</span>
			) : null}
		</button>
	);
}

function RailLink({
	active,
	badge,
	icon,
	label,
	to,
}: {
	active: boolean;
	badge?: number;
	icon: LucideIcon;
	label: string;
	to: RailDestination;
}) {
	const Icon = icon;
	return (
		<Link
			to={to}
			aria-current={active ? "page" : undefined}
			aria-label={label}
			title={label}
			className={cn(
				"relative grid size-9 place-items-center rounded-lg text-muted-foreground outline-none transition-colors",
				"hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
				active && "bg-primary/12 text-primary hover:bg-primary/15 hover:text-primary",
			)}
		>
			<Icon className="size-[18px]" />
			{badge !== undefined && badge > 0 ? (
				<span className="absolute top-0.5 right-0.5 grid min-w-3.5 place-items-center rounded-full bg-primary px-1 text-[8.5px] leading-3.5 font-medium text-primary-foreground">
					{badge > 99 ? "99+" : badge}
				</span>
			) : null}
		</Link>
	);
}

/**
 * Primary navigation rail. Every destination is a route; utility destinations sit at the bottom
 * of the rail in a stable order so the rail can replace the old top bar outright.
 */
export function AppRail() {
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [logsOpen, setLogsOpen] = useState(false);
	const [moreOpen, setMoreOpen] = useState(false);
	const [theme, setTheme] = useState<Theme>(() => getInitialTheme());
	const session = useQuery(authSessionQueryOptions());
	const pendingRequests = useQuery(
		orpc.admin.requests.list.queryOptions({ input: { status: "pending" } }),
	);
	const pendingCount = pendingRequests.data?.length ?? 0;
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
			<nav
				aria-label="Tsukaima"
				className="flex h-full w-[52px] shrink-0 flex-col items-center border-r border-border bg-sidebar py-2"
			>
				<Link
					to="/"
					aria-label="Tsukaima"
					title="Tsukaima"
					className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<Sparkles className="size-4" />
				</Link>

				<div className="mt-3 flex flex-col items-center gap-1">
					<RailLink
						active={destinationActive("/", pathname)}
						icon={MessageSquare}
						label={m.tab_chats()}
						to="/"
					/>
					<RailLink
						active={destinationActive("/users", pathname)}
						icon={UsersRound}
						label={m.tab_users()}
						to="/users"
					/>
					<RailLink
						active={destinationActive("/groups", pathname)}
						icon={Users}
						label={m.tab_groups()}
						to="/groups"
					/>
					<RailLink
						active={destinationActive("/requests", pathname)}
						badge={pendingCount}
						icon={Inbox}
						label={m.tab_requests()}
						to="/requests"
					/>
				</div>

				<div className="mt-auto flex flex-col items-center gap-1">
					<RailLink
						active={destinationActive("/plugins", pathname)}
						icon={Puzzle}
						label={m.nav_plugins()}
						to="/plugins"
					/>
					<RailLink
						active={destinationActive("/settings", pathname)}
						icon={Settings}
						label={m.nav_settings()}
						to="/settings"
					/>
					<RailItem
						active={logsOpen}
						icon={Terminal}
						label={`${m.logs_title()} (${m.logs_shortcut()})`}
						onClick={() => setLogsOpen((value) => !value)}
					/>
					<RailLink
						active={destinationActive("/memories", pathname)}
						icon={Brain}
						label={m.nav_memories()}
						to="/memories"
					/>
					<MorphPopover open={moreOpen} onOpenChange={setMoreOpen}>
						<MorphPopoverTrigger>
							<Button
								type="button"
								variant="ghost"
								size="iconLg"
								aria-label={m.nav_more()}
								title={m.nav_more()}
								className="size-9 rounded-lg p-0 text-muted-foreground hover:text-foreground"
							>
								<MoreHorizontal className="size-[18px]" />
							</Button>
						</MorphPopoverTrigger>
						<MorphPopoverContent
							align="start"
							side="top"
							sideOffset={8}
							radius={10}
							className="w-52 p-1"
						>
							<Button
								className="h-auto justify-start rounded-md px-2 py-1.5 text-xs"
								fullWidth
								leadingIcon={theme === "dark" ? <Sun /> : <Moon />}
								onClick={toggleTheme}
								variant="ghost"
							>
								{m.theme_toggle()}
							</Button>
							<div className="my-1 h-px bg-border" />
							{session.data?.user === undefined ? null : (
								<div className="truncate px-2 pb-1 text-[10.5px] text-muted-foreground">
									{m.auth_signed_in_as({
										username: session.data.user.username ?? session.data.user.name,
									})}
								</div>
							)}
							<Button
								className="h-auto justify-start rounded-md px-2 py-1.5 text-xs"
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
			</nav>
			<LogPanel open={logsOpen} onClose={() => setLogsOpen(false)} />
		</>
	);
}
