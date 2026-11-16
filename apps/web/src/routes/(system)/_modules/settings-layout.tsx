"use client";

import { Link, useRouterState } from "@tanstack/react-router";
import { GitBranch, ServerCog, SlidersHorizontal, Wrench, type LucideIcon } from "lucide-react";
import { cn } from "@tsukaima/ui/lib/utils";
import { m } from "@/paraglide/messages";
import { useMediaQuery } from "../../_modules/hooks/use-media-query";

type SettingsSection = "general" | "policies" | "maintenance" | "upgrades";

const SECTIONS: ReadonlyArray<{
	readonly description: () => string;
	readonly icon: LucideIcon;
	readonly id: SettingsSection;
	readonly label: () => string;
	readonly to: "/settings" | "/settings/policies" | "/settings/maintenance" | "/settings/upgrades";
}> = [
	{
		description: () => m.settings_general_description(),
		icon: SlidersHorizontal,
		id: "general",
		label: () => m.settings_tab_general(),
		to: "/settings",
	},
	{
		description: () => m.settings_policies_description(),
		icon: ServerCog,
		id: "policies",
		label: () => m.settings_tab_policies(),
		to: "/settings/policies",
	},
	{
		description: () => m.settings_maintenance_description(),
		icon: Wrench,
		id: "maintenance",
		label: () => m.settings_tab_maintenance(),
		to: "/settings/maintenance",
	},
	{
		description: () => m.settings_upgrades_description(),
		icon: GitBranch,
		id: "upgrades",
		label: () => m.settings_tab_upgrades(),
		to: "/settings/upgrades",
	},
];

function sectionFor(pathname: string): SettingsSection {
	if (pathname === "/settings/policies") return "policies";
	if (pathname === "/settings/maintenance") return "maintenance";
	if (pathname === "/settings/upgrades") return "upgrades";
	return "general";
}

export function SettingsSidebar({ onNavigate }: { readonly onNavigate: () => void }) {
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const active = sectionFor(pathname);
	return (
		<nav aria-label={m.nav_settings()} className="flex min-h-0 flex-1 flex-col">
			<div className="shrink-0 px-2.5 pt-2 pb-1.5">
				<h1 className="text-[13px] font-semibold tracking-tight">{m.nav_settings()}</h1>
				<p className="mt-0.5 text-[10.5px] leading-4 text-muted-foreground">
					{m.settings_sidebar_description()}
				</p>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
				<ul className="space-y-1">
					{SECTIONS.map((section) => {
						const selected = section.id === active;
						const Icon = section.icon;
						return (
							<li key={section.id}>
								<Link
									to={section.to}
									aria-current={selected ? "page" : undefined}
									onClick={onNavigate}
									className={cn(
										"flex w-full items-start gap-2 rounded-md border border-transparent px-1.5 py-1.5 text-left outline-none transition-colors",
										"hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
										selected && "border-border bg-muted/70",
									)}
								>
									<Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
									<span className="min-w-0 flex-1">
										<span className="block truncate text-[12.5px] font-medium">
											{section.label()}
										</span>
										<span className="mt-0.5 block text-[10.5px] leading-4 text-muted-foreground">
											{section.description()}
										</span>
									</span>
								</Link>
							</li>
						);
					})}
				</ul>
			</div>
		</nav>
	);
}

export function SettingsLayout({ children }: { readonly children: React.ReactNode }) {
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const mobile = useMediaQuery("(max-width: 767px)");
	const detail = pathname !== "/settings" && pathname !== "/settings/";
	const showList = !mobile || !detail;
	const showDetail = !mobile || detail;
	return (
		<div className="flex min-h-0 flex-1 overflow-hidden">
			<aside
				className={cn(
					"min-h-0 shrink-0 flex-col border-border bg-sidebar md:flex md:w-60 md:border-r lg:w-64",
					showList ? "flex w-full" : "hidden",
				)}
			>
				<SettingsSidebar onNavigate={() => undefined} />
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
