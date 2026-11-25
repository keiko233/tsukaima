"use client";

import type { ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

export interface EditorialGroupProps {
	title?: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
}

export function EditorialGroup({
	title,
	description,
	actions,
	children,
	className,
}: EditorialGroupProps) {
	const hasHeader = title != null || description != null || actions != null;
	return (
		<section className={cn("border-t border-border pt-5", className)}>
			{hasHeader && (
				<header className="flex flex-wrap items-start justify-between gap-3">
					<div className="min-w-0">
						{title != null && (
							<h3 className="text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
								{title}
							</h3>
						)}
						{description != null && (
							<p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
						)}
					</div>
					{actions != null && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
				</header>
			)}
			<div className={cn(hasHeader && "pt-3")}>{children}</div>
		</section>
	);
}
