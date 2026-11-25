"use client";

import { ChevronLeft, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@tsukaima/ui/components/motion/button";
import { EditorialGroup } from "@tsukaima/ui";
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
			<div className="flex max-w-xs flex-col items-center border-t border-border pt-6 text-center">
				<Icon className="size-5 text-faint" aria-hidden="true" />
				<h1 className="mt-3 font-serif text-xl text-ink">{title}</h1>
				<p className="mt-1 text-[12px] leading-5 text-muted-foreground">{description}</p>
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
						className="mb-2 -ml-1 h-7 px-1.5 text-[11px]"
					>
						{m.back()}
					</Button>
				) : null}
				<header className="flex min-w-0 items-start gap-3 border-b border-border pb-4">
					{leading}
					<div className="min-w-0 flex-1">
						<h1 className="truncate font-serif text-2xl text-ink">{title}</h1>
						{subtitle ? (
							<p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
								{subtitle}
							</p>
						) : null}
					</div>
					{trailing}
				</header>
				<div className="space-y-4 pt-4">{children}</div>
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
		<EditorialGroup title={title} {...(className === undefined ? {} : { className })}>
			{children}
		</EditorialGroup>
	);
}

export function DetailField({
	label,
	mono = false,
	value,
}: {
	label: string;
	mono?: boolean;
	value: string;
}) {
	return (
		<div className="flex items-start justify-between gap-4 border-b border-border/60 py-1.5 text-xs last:border-b-0">
			<span className="shrink-0 text-muted-foreground">{label}</span>
			<span
				className={cn("min-w-0 break-all text-right text-ink", mono && "font-mono text-[11px]")}
			>
				{value}
			</span>
		</div>
	);
}
