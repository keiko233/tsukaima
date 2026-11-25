"use client";

import type { ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

export interface PreferenceRowProps {
	label: ReactNode;
	hint?: ReactNode;
	htmlFor?: string;
	labelId?: string;
	hintId?: string;
	align?: "center" | "start";
	children: ReactNode;
	className?: string;
}

export function PreferenceRow({
	label,
	hint,
	htmlFor,
	labelId,
	hintId,
	align = "center",
	children,
	className,
}: PreferenceRowProps) {
	return (
		<div
			className={cn(
				"grid gap-x-4 gap-y-2 border-b border-border/70 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto]",
				align === "start" ? "items-start" : "items-center",
				className,
			)}
		>
			<div className="min-w-0">
				{htmlFor === undefined ? (
					<div id={labelId} className="font-medium">
						{label}
					</div>
				) : (
					<label id={labelId} htmlFor={htmlFor} className="font-medium">
						{label}
					</label>
				)}
				{hint != null && (
					<div id={hintId} className="mt-0.5 text-xs text-muted-foreground">
						{hint}
					</div>
				)}
			</div>
			<div className="min-w-0 sm:max-w-sm">{children}</div>
		</div>
	);
}
