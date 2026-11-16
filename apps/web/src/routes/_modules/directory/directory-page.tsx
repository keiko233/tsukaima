"use client";

import { ChevronLeft, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@tsukaima/ui/components/motion/button";
import { cn } from "@tsukaima/ui/lib/utils";
import { m } from "@/paraglide/messages";
import { useShellNavigation } from "../shell/admin-shell";

export function DirectoryEmptyState({
	description,
	icon: Icon,
	title,
}: {
	description: string;
	icon: LucideIcon;
	title: string;
}) {
	return (
		<div className="grid h-full place-items-center px-6">
			<div className="flex max-w-xs flex-col items-center text-center">
				<span className="grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground">
					<Icon className="size-5" />
				</span>
				<h1 className="mt-3 text-[14px] font-semibold tracking-tight">{title}</h1>
				<p className="mt-1 text-[11.5px] leading-5 text-muted-foreground">{description}</p>
			</div>
		</div>
	);
}

export function DirectoryDetailPage({
	children,
	leading,
	subtitle,
	title,
	trailing,
}: {
	children: ReactNode;
	leading?: ReactNode;
	subtitle?: string;
	title: string;
	trailing?: ReactNode;
}) {
	const { mobile, showSidebar } = useShellNavigation();

	return (
		<div className="h-full min-h-0 overflow-y-auto">
			<div className="mx-auto w-full max-w-3xl px-4 py-4 sm:px-6 sm:py-5">
				{mobile ? (
					<Button
						variant="ghost"
						size="sm"
						onClick={showSidebar}
						leadingIcon={<ChevronLeft />}
						className="mb-2 -ml-1 h-7 rounded-md px-1.5 text-[11px]"
					>
						{m.back()}
					</Button>
				) : null}
				<header className="mb-4 flex min-w-0 items-center gap-3">
					{leading}
					<div className="min-w-0 flex-1">
						<h1 className="truncate text-[17px] font-semibold tracking-tight">{title}</h1>
						{subtitle ? (
							<p className="truncate text-[11.5px] text-muted-foreground">{subtitle}</p>
						) : null}
					</div>
					{trailing}
				</header>
				<div className="space-y-3">{children}</div>
			</div>
		</div>
	);
}

export function DetailSection({
	children,
	className,
	title,
}: {
	children: ReactNode;
	className?: string;
	title: string;
}) {
	return (
		<section className={cn("rounded-xl border border-border bg-card/40", className)}>
			<h2 className="border-b border-border px-3.5 py-2 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
				{title}
			</h2>
			<div className="p-3.5">{children}</div>
		</section>
	);
}

export function DetailField({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-start justify-between gap-4 py-1 text-xs">
			<span className="shrink-0 text-muted-foreground">{label}</span>
			<span className="min-w-0 text-right text-foreground">{value}</span>
		</div>
	);
}
