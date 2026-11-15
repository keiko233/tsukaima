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
import { cn } from "@elaina/ui/lib/utils";
import { useMediaQuery } from "../hooks/use-media-query";
import { AppSidebar } from "./app-sidebar";
import { TopBar } from "./top-bar";

type MobilePane = "content" | "sidebar";

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

const SIDEBAR_WIDTH_KEY = "elaina.webui.sidebar-width.v2";
const MIN_SIDEBAR_WIDTH = 232;
const MAX_SIDEBAR_WIDTH = 360;
const DEFAULT_SIDEBAR_WIDTH = 264;

function storedSidebarWidth(): number {
	const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
	if (stored === null) return DEFAULT_SIDEBAR_WIDTH;
	const value = Number(stored);
	if (!Number.isFinite(value)) return DEFAULT_SIDEBAR_WIDTH;
	return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value));
}

function isContentRoute(pathname: string): boolean {
	return pathname !== "/";
}

function isChatRoute(pathname: string): boolean {
	return pathname === "/" || pathname.startsWith("/chat/");
}

export function AdminShell({ children }: { readonly children?: ReactNode }) {
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const mobile = useMediaQuery("(max-width: 767px)");
	const [mobilePane, setMobilePane] = useState<MobilePane>(() =>
		isContentRoute(pathname) ? "content" : "sidebar",
	);
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [sidebarWidth, setSidebarWidth] = useState(() => storedSidebarWidth());
	const resizeRef = useRef<{ pointerId: number; startWidth: number; startX: number } | null>(null);

	useEffect(() => {
		localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
	}, [sidebarWidth]);

	useEffect(() => {
		if (mobile && isContentRoute(pathname)) setMobilePane("content");
	}, [mobile, pathname]);

	const showSidebar = useCallback(() => setMobilePane("sidebar"), []);
	const showContent = useCallback(() => setMobilePane("content"), []);
	const toggleSidebar = () => {
		if (mobile) {
			setMobilePane((current) => (current === "sidebar" ? "content" : "sidebar"));
			return;
		}
		setSidebarOpen((open) => !open);
	};

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

	const sidebarVisible = mobile ? mobilePane === "sidebar" : sidebarOpen;
	const contentVisible = mobile ? mobilePane === "content" : true;
	const chatRoute = isChatRoute(pathname);
	const pluginRoute = pathname === "/plugins" || pathname.startsWith("/plugins/");
	const fullBleedRoute = pathname === "/diagnostics";

	return (
		<ShellNavigationContext.Provider value={{ mobile, showContent, showSidebar }}>
			<div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground">
				<TopBar mobile={mobile} onToggleSidebar={toggleSidebar} />
				<div className="flex min-h-0 flex-1">
					<aside
						aria-label="Elaina"
						style={{ width: mobile ? "100%" : sidebarWidth }}
						className={cn(
							"relative flex min-h-0 shrink-0 flex-col bg-sidebar",
							!sidebarVisible && "hidden",
							!mobile && "border-r border-border",
						)}
					>
						<AppSidebar onNavigate={showContent} />
						{!mobile && sidebarOpen ? (
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
					<main
						className={cn(
							"flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
							!contentVisible && "hidden",
						)}
					>
						{chatRoute || pluginRoute ? (
							(children ?? <Outlet />)
						) : (
							<div className="min-h-0 flex-1 overflow-y-auto">
								<div
									className={cn(
										fullBleedRoute
											? "flex h-full min-h-0 w-full flex-col px-3 py-3 sm:px-4"
											: "mx-auto w-full max-w-4xl px-4 py-4 sm:px-6 sm:py-5",
									)}
								>
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
