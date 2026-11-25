"use client";

import type { ReactNode } from "react";
import { EditorialPageHeader } from "@tsukaima/ui";
import { cn } from "@tsukaima/ui/lib/utils";

export function SystemPageHeader({
	actions,
	className,
	description,
	eyebrow,
	meta,
	tabs,
	title,
}: {
	actions?: ReactNode;
	className?: string;
	description: string;
	eyebrow?: ReactNode;
	meta?: ReactNode;
	tabs?: ReactNode;
	title: string;
}) {
	return (
		<EditorialPageHeader
			{...(eyebrow === undefined ? {} : { eyebrow })}
			{...(actions === undefined ? {} : { actions })}
			{...(tabs === undefined ? {} : { tabs })}
			className={cn("mb-4", className)}
			meta={meta ?? <span>{description}</span>}
			title={title}
		/>
	);
}

export function SystemPage({
	actions,
	children,
	description,
	eyebrow,
	fill = false,
	meta,
	tabs,
	title,
}: {
	actions?: ReactNode;
	children: ReactNode;
	description: string;
	eyebrow?: ReactNode;
	fill?: boolean;
	meta?: ReactNode;
	tabs?: ReactNode;
	title: string;
}) {
	const header = (
		<SystemPageHeader
			{...(eyebrow === undefined ? {} : { eyebrow })}
			{...(meta === undefined ? {} : { meta })}
			{...(actions === undefined ? {} : { actions })}
			{...(tabs === undefined ? {} : { tabs })}
			description={description}
			title={title}
		/>
	);

	if (fill) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				{header}
				<div className="flex min-h-0 flex-1 flex-col">{children}</div>
			</div>
		);
	}

	return (
		<div>
			{header}
			{children}
		</div>
	);
}
