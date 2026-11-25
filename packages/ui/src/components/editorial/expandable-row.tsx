"use client";

import type { ReactNode } from "react";
import { cn } from "../../lib/utils.ts";
import {
	Disclosure,
	DisclosurePanel,
	DisclosureTrigger,
	type DisclosureProps,
} from "./disclosure.tsx";

export interface ExpandableRowProps extends DisclosureProps {
	summary: ReactNode;
}

export function ExpandableRow({ summary, children, className, ...props }: ExpandableRowProps) {
	return (
		<Disclosure {...props} className={cn("border-t border-line", className)}>
			<DisclosureTrigger>{summary}</DisclosureTrigger>
			<DisclosurePanel>{children}</DisclosurePanel>
		</Disclosure>
	);
}
