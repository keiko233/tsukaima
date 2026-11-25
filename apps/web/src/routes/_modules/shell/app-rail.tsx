"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
	CalendarClock,
	Inbox,
	LogOut,
	MessageSquare,
	Moon,
	MoreHorizontal,
	Puzzle,
	Settings,
	SquareTerminal,
	Sun,
	Terminal,
	Users,
	UsersRound,
	type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
	EditorialPopover,
	EditorialPopoverClose,
	EditorialPopoverContent,
	EditorialPopoverTitle,
	EditorialPopoverTrigger,
} from "@tsukaima/ui";
import { cn } from "@tsukaima/ui/lib/utils";
import { orpc } from "@/lib/api";
import { authClient, authSessionQueryKey, authSessionQueryOptions } from "@/lib/auth";
import { applyTheme, getInitialTheme, type Theme } from "@/lib/theme";
import { m } from "@/paraglide/messages";
import { LogPanel } from "./log-panel";

type RailDestination =
	| "/"
	| "/groups"
	| "/plugins"
	| "/requests"
	| "/settings"
	| "/tasks"
	| "/users"
	| "/workspace";

const RAIL_ITEM_CLASS =
	"relative grid size-9 place-items-center text-muted-foreground outline-none transition-colors hover:bg-ink/5 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring";

function destinationActive(destination: RailDestination, pathname: string): boolean {
	if (destination === "/") return pathname === "/" || pathname.startsWith("/chat/");
	if (destination === "/workspace") {
		return pathname === "/workspace" || pathname.startsWith("/workspace/");
	}
	return pathname === destination || pathname.startsWith(`${destination}/`);
}

function ActiveBar() {
	return (
		<span
			aria-hidden="true"
			className="absolute top-1/2 -left-2 h-4 w-0.5 -translate-y-1/2 bg-[var(--accent-ink)]"
		/>
	);
}

function RailBadge({ count }: { count: number }) {
	if (count <= 0) return null;
	return (
		<span className="absolute -top-0.5 -right-1 grid min-w-3.5 place-items-center rounded-full bg-[var(--accent-ink)] px-1 font-mono text-[9px] leading-3.5 tabular-nums text-accent-foreground">
			{count > 99 ? "99+" : count}
		</span>
	);
}

function RailButton({
	active = false,
	badge,
	icon: Icon,
	label,
	onClick,
	pressed,
}: {
	active?: boolean;
	badge?: number;
	icon: LucideIcon;
	label: string;
	onClick: () => void;
	pressed?: boolean;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			aria-pressed={pressed}
			title={label}
			onClick={onClick}
			className={cn(RAIL_ITEM_CLASS, active && "text-ink")}
		>
			{active ? <ActiveBar /> : null}
			<Icon className="size-[18px]" aria-hidden="true" />
			{badge === undefined ? null : <RailBadge count={badge} />}
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
			className={cn(RAIL_ITEM_CLASS, active && "text-ink")}
		>
			{active ? <ActiveBar /> : null}
			<Icon className="size-[18px]" aria-hidden="true" />
			{badge === undefined ? null : <RailBadge count={badge} />}
		</Link>
	);
}

/**
 * Primary navigation rail. Every destination is a route; utility destinations sit at the bottom
 * of the rail in a stable order so the rail can replace the old top bar outright. The rail owns
 * its own scroll: when a short viewport cannot fit both groups, focusing a hidden destination
 * scrolls the rail instead of the shell, which must stay fixed.
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
	const scheduleSummary = useQuery(orpc.admin.schedules.summary.queryOptions({ input: {} }));
	const pendingCount = pendingRequests.data?.length ?? 0;
	const scheduledCount =
		(scheduleSummary.data?.overdue ?? 0) + (scheduleSummary.data?.dueSoon ?? 0);
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
				className="scrollbar-hide flex h-full w-[52px] shrink-0 flex-col items-center overflow-x-hidden overflow-y-auto border-r border-border bg-rail py-2"
			>
				<Link
					to="/"
					aria-label="Tsukaima"
					title="Tsukaima"
					className="grid size-8 shrink-0 place-items-center outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<img src="/brand/tsukaima-square.svg" alt="" className="size-8" width={32} height={32} />
				</Link>

				<div className="scrollbar-hide mt-3 flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-x-hidden overflow-y-auto">
					<RailLink
						active={destinationActive("/", pathname)}
						icon={MessageSquare}
						label={m.tab_chats()}
						to="/"
					/>
					<RailLink
						active={destinationActive("/workspace", pathname)}
						icon={SquareTerminal}
						label={m.tab_workspace()}
						to="/workspace"
					/>
					<RailLink
						active={destinationActive("/tasks", pathname)}
						badge={scheduledCount}
						icon={CalendarClock}
						label={m.tab_tasks()}
						to="/tasks"
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

				<div className="mt-1 flex w-full shrink-0 flex-col items-center gap-1">
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
					<RailButton
						active={logsOpen}
						icon={Terminal}
						label={`${m.logs_title()} (${m.logs_shortcut()})`}
						onClick={() => setLogsOpen((value) => !value)}
						pressed={logsOpen}
					/>
					<RailButton
						icon={theme === "dark" ? Sun : Moon}
						label={m.theme_toggle()}
						onClick={toggleTheme}
					/>
					<EditorialPopover open={moreOpen} onOpenChange={setMoreOpen}>
						<EditorialPopoverTrigger
							aria-label={m.nav_more()}
							title={m.nav_more()}
							className={cn(RAIL_ITEM_CLASS, moreOpen && "text-ink")}
						>
							<MoreHorizontal className="size-[18px]" aria-hidden="true" />
						</EditorialPopoverTrigger>
						<EditorialPopoverContent side="right" align="end" className="w-56 p-2">
							<EditorialPopoverTitle className="sr-only">{m.nav_more()}</EditorialPopoverTitle>
							{session.data?.user === undefined ? null : (
								<div className="px-1 pb-2">
									<div className="text-[10px] tracking-[0.14em] text-faint uppercase">
										{m.nav_more()}
									</div>
									<div className="mt-0.5 truncate text-xs text-ink">
										{m.auth_signed_in_as({
											username: session.data.user.username ?? session.data.user.name,
										})}
									</div>
								</div>
							)}
							<div className="border-t border-border pt-1">
								<EditorialPopoverClose
									disabled={signOut.isPending}
									onClick={() => signOut.mutate()}
									className="flex h-8 w-full items-center gap-2 rounded-sm px-1.5 text-start text-xs text-ink outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
								>
									<LogOut className="size-3.5" aria-hidden="true" />
									{m.auth_sign_out()}
								</EditorialPopoverClose>
							</div>
						</EditorialPopoverContent>
					</EditorialPopover>
				</div>
			</nav>
			<LogPanel open={logsOpen} onClose={() => setLogsOpen(false)} />
		</>
	);
}
