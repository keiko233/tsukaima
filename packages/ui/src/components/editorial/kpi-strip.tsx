"use client";

import { Children, isValidElement, type ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

const toneClasses = {
	default: "text-ink",
	muted: "text-muted-foreground",
	success: "text-success",
	warning: "text-warning",
	danger: "text-danger",
} as const;

export interface KpiItem {
	id?: string;
	label: ReactNode;
	value: ReactNode;
	tone?: keyof typeof toneClasses;
}

export interface KpiStripProps {
	items: readonly KpiItem[];
	className?: string;
}

export function KpiStrip({ items, className }: KpiStripProps) {
	return (
		<dl
			className={cn(
				"grid grid-cols-2 gap-y-3 sm:flex sm:flex-wrap sm:divide-x sm:divide-border",
				className,
			)}
		>
			{Children.toArray(
				items.map(({ id, label, value, tone = "default" }) => {
					const key = id ?? (isValidElement(label) ? label.key : String(label));
					return (
						<div
							key={key ?? undefined}
							className="min-w-0 px-3 first:ps-0 max-sm:nth-[even]:border-s max-sm:nth-[even]:border-border max-sm:nth-[odd]:ps-0"
						>
							<dt className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</dt>
							<dd
								className={cn("mt-1 truncate font-serif text-xl tabular-nums", toneClasses[tone])}
							>
								{value}
							</dd>
						</div>
					);
				}),
			)}
		</dl>
	);
}
