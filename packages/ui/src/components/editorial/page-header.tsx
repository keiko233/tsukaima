"use client";

import type { ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

export interface EditorialPageHeaderProps {
	eyebrow?: ReactNode;
	title: ReactNode;
	meta?: ReactNode;
	actions?: ReactNode;
	tabs?: ReactNode;
	headingLevel?: 1 | 2;
	className?: string;
}

export function EditorialPageHeader({
	eyebrow,
	title,
	meta,
	actions,
	tabs,
	headingLevel = 1,
	className,
}: EditorialPageHeaderProps) {
	const Heading = headingLevel === 1 ? "h1" : "h2";
	return (
		<header className={cn("space-y-3", className)}>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0 space-y-1">
					{eyebrow != null && (
						<div className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
							{eyebrow}
						</div>
					)}
					<Heading className="font-serif text-2xl text-ink">{title}</Heading>
					{meta != null && (
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
							{meta}
						</div>
					)}
				</div>
				{actions != null && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
			</div>
			{tabs}
		</header>
	);
}
