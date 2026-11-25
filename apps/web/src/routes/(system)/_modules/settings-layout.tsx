"use client";

import { Link, useRouterState } from "@tanstack/react-router";
import { FileText, GitBranch, ServerCog, SlidersHorizontal, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@tsukaima/ui/lib/utils";
import { m } from "@/paraglide/messages";
import { useMediaQuery } from "../../_modules/hooks/use-media-query";

type SettingsSection = "general" | "policies" | "prompts" | "maintenance" | "upgrades";

const SECTIONS: ReadonlyArray<{
	readonly icon: LucideIcon;
	readonly id: SettingsSection;
	readonly label: () => string;
	readonly to:
		| "/settings"
		| "/settings/policies"
		| "/settings/prompts"
		| "/settings/maintenance"
		| "/settings/upgrades";
}> = [
	{
		icon: SlidersHorizontal,
		id: "general",
		label: () => m.settings_tab_general(),
		to: "/settings",
	},
	{
		icon: ServerCog,
		id: "policies",
		label: () => m.settings_tab_policies(),
		to: "/settings/policies",
	},
	{
		icon: FileText,
		id: "prompts",
		label: m.prompts_title,
		to: "/settings/prompts",
	},
	{
		icon: Wrench,
		id: "maintenance",
		label: () => m.settings_tab_maintenance(),
		to: "/settings/maintenance",
	},
	{
		icon: GitBranch,
		id: "upgrades",
		label: () => m.settings_tab_upgrades(),
		to: "/settings/upgrades",
	},
];

function sectionFor(pathname: string): SettingsSection {
	if (pathname === "/settings/policies") return "policies";
	if (pathname === "/settings/prompts") return "prompts";
	if (pathname === "/settings/maintenance") return "maintenance";
	if (pathname === "/settings/upgrades") return "upgrades";
	return "general";
}

export function SettingsSidebar({ onNavigate }: { readonly onNavigate: () => void }) {
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const active = sectionFor(pathname);
	return (
		<nav aria-label={m.nav_settings()} className="flex min-h-0 flex-1 flex-col">
			<div className="shrink-0 px-3 pt-4 pb-2">
				<h1 className="text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
					{m.nav_settings()}
				</h1>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto pb-3">
				<ul>
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
										"flex w-full items-center gap-2.5 border-s-2 border-transparent py-2 pe-3 ps-3 text-[13px] outline-none transition-colors",
										"text-muted-foreground hover:bg-accent-soft hover:text-ink",
										"focus-visible:bg-accent-soft focus-visible:text-ink",
										selected && "border-accent-ink bg-accent-soft font-medium text-ink",
									)}
								>
									<Icon aria-hidden="true" className="size-3.5 shrink-0" />
									<span className="min-w-0 flex-1 truncate">{section.label()}</span>
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
					"min-h-0 shrink-0 flex-col bg-sidebar md:flex md:w-60 md:border-e md:border-border lg:w-64",
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
				<div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-4 py-5 sm:px-6">
					{children}
				</div>
			</div>
		</div>
	);
}
