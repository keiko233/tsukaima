"use client";

import { Outlet, useRouterState } from "@tanstack/react-router";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
} from "react";
import { cn } from "@tsukaima/ui/lib/utils";
import { useMediaQuery } from "../hooks/use-media-query";
import { AppRail } from "./app-rail";
import { ChatSidebar } from "./chat-sidebar";
import { GroupsSidebar } from "./groups-sidebar";
import { RequestsSidebar } from "./requests-sidebar";
import { UsersSidebar } from "./users-sidebar";
import { WorkspaceSidebar } from "./workspace-sidebar";

type MobilePane = "content" | "sidebar";
type ShellSection = "chats" | "groups" | "requests" | "users" | "workspace" | null;

interface ShellNavigation {
	mobile: boolean;
	showContent: () => void;
	showSidebar: () => void;
}

const ShellNavigationContext = createContext<ShellNavigation>({
	mobile: false,
	showContent: () => {},
	showSidebar: () => {},
});

export function useShellNavigation(): ShellNavigation {
	return useContext(ShellNavigationContext);
}

const SIDEBAR_WIDTH_KEY = "tsukaima.webui.sidebar-width.v2";
const MIN_SIDEBAR_WIDTH = 232;
const MAX_SIDEBAR_WIDTH = 380;
const DEFAULT_SIDEBAR_WIDTH = 272;

function storedSidebarWidth(): number {
	const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
	if (stored === null) return DEFAULT_SIDEBAR_WIDTH;
	const value = Number(stored);
	if (!Number.isFinite(value)) return DEFAULT_SIDEBAR_WIDTH;
	return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value));
}

function sectionFor(pathname: string): ShellSection {
	if (pathname === "/" || pathname.startsWith("/chat/")) return "chats";
	if (pathname === "/workspace" || pathname.startsWith("/workspace/")) return "workspace";
	if (pathname === "/users" || pathname.startsWith("/users/")) return "users";
	if (pathname === "/groups" || pathname.startsWith("/groups/")) return "groups";
	if (pathname === "/requests" || pathname.startsWith("/requests/")) return "requests";
	return null;
}

function selectedIdFor(
	pathname: string,
	section: "groups" | "requests" | "users",
): string | undefined {
	const prefix = `/${section}/`;
	if (!pathname.startsWith(prefix)) return undefined;
	const encoded = pathname.slice(prefix.length).split("/")[0];
	if (encoded === undefined || encoded.length === 0) return undefined;
	try {
		return decodeURIComponent(encoded);
	} catch {
		return encoded;
	}
}

function isMobileContentPath(pathname: string): boolean {
	return (
		pathname !== "/" &&
		pathname !== "/workspace" &&
		pathname !== "/users" &&
		pathname !== "/groups" &&
		pathname !== "/requests"
	);
}

function isFullBleedRoute(pathname: string): boolean {
	return (
		pathname === "/" ||
		pathname.startsWith("/chat/") ||
		pathname.startsWith("/workspace") ||
		pathname.startsWith("/users") ||
		pathname.startsWith("/groups") ||
		pathname.startsWith("/requests") ||
		pathname.startsWith("/plugins") ||
		pathname.startsWith("/settings")
	);
}

export function AdminShell({ children }: { readonly children?: ReactNode }) {
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const mobile = useMediaQuery("(max-width: 767px)");
	const [mobilePane, setMobilePane] = useState<MobilePane>(() =>
		isMobileContentPath(pathname) ? "content" : "sidebar",
	);
	const [sidebarWidth, setSidebarWidth] = useState(() => storedSidebarWidth());
	const resizeRef = useRef<{ pointerId: number; startWidth: number; startX: number } | null>(null);
	const section = sectionFor(pathname);
	const hasSidebar = section !== null;

	useEffect(() => {
		localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
	}, [sidebarWidth]);

	useEffect(() => {
		if (mobile && hasSidebar) {
			setMobilePane(isMobileContentPath(pathname) ? "content" : "sidebar");
		}
	}, [mobile, pathname, hasSidebar]);

	const showSidebar = useCallback(() => setMobilePane("sidebar"), []);
	const showContent = useCallback(() => setMobilePane("content"), []);

	const resize = (width: number) =>
		setSidebarWidth(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width)));

	const startResize = (event: PointerEvent<HTMLDivElement>) => {
		resizeRef.current = {
			pointerId: event.pointerId,
			startWidth: sidebarWidth,
			startX: event.clientX,
		};
		event.currentTarget.setPointerCapture(event.pointerId);
	};

	const moveResize = (event: PointerEvent<HTMLDivElement>) => {
		const active = resizeRef.current;
		if (active === null || active.pointerId !== event.pointerId) return;
		resize(active.startWidth + event.clientX - active.startX);
	};

	const endResize = () => {
		resizeRef.current = null;
	};

	const resizeByKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		resize(sidebarWidth + (event.key === "ArrowRight" ? 16 : -16));
	};

	const sidebarVisible = hasSidebar && (!mobile || mobilePane === "sidebar");
	const contentVisible = !hasSidebar || !mobile || mobilePane === "content";
	const fullBleed = isFullBleedRoute(pathname);
	const selectedId =
		section === "users" || section === "groups" || section === "requests"
			? selectedIdFor(pathname, section)
			: undefined;

	return (
		<ShellNavigationContext.Provider value={{ mobile, showContent, showSidebar }}>
			<div className="flex h-dvh min-h-0 overflow-hidden bg-background text-foreground">
				<AppRail />
				<div className="flex min-h-0 min-w-0 flex-1">
					{hasSidebar ? (
						<aside
							aria-label="Tsukaima sidebar"
							style={{ width: mobile ? "100%" : sidebarWidth }}
							className={cn(
								"relative min-h-0 shrink-0 flex-col bg-sidebar",
								sidebarVisible ? "flex" : "hidden",
								!mobile && "border-r border-border",
							)}
						>
							{section === "chats" ? <ChatSidebar onNavigate={showContent} /> : null}
							{section === "workspace" ? <WorkspaceSidebar onNavigate={showContent} /> : null}
							{section === "users" ? (
								<UsersSidebar onNavigate={showContent} selectedId={selectedId} />
							) : null}
							{section === "groups" ? (
								<GroupsSidebar onNavigate={showContent} selectedId={selectedId} />
							) : null}
							{section === "requests" ? (
								<RequestsSidebar onNavigate={showContent} selectedId={selectedId} />
							) : null}
							{!mobile && sidebarVisible ? (
								<div
									role="separator"
									aria-orientation="vertical"
									aria-label="Resize sidebar"
									aria-valuemax={MAX_SIDEBAR_WIDTH}
									aria-valuemin={MIN_SIDEBAR_WIDTH}
									aria-valuenow={sidebarWidth}
									tabIndex={0}
									onPointerDown={startResize}
									onPointerMove={moveResize}
									onPointerUp={endResize}
									onPointerCancel={endResize}
									onKeyDown={resizeByKeyboard}
									className="absolute inset-y-0 -right-[3px] z-20 w-[5px] cursor-col-resize touch-none outline-none hover:bg-primary/25 focus-visible:bg-primary/30"
								/>
							) : null}
						</aside>
					) : null}
					<main
						className={cn(
							"flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
							!contentVisible && "hidden",
						)}
					>
						{fullBleed ? (
							(children ?? <Outlet />)
						) : (
							<div className="min-h-0 flex-1 overflow-y-auto">
								<div className="mx-auto w-full max-w-4xl px-4 py-4 sm:px-6 sm:py-5">
									{children ?? <Outlet />}
								</div>
							</div>
						)}
					</main>
				</div>
			</div>
		</ShellNavigationContext.Provider>
	);
}
