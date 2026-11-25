"use client";

import {
	Accordion,
	AccordionHeader,
	AccordionItem,
	AccordionPanel,
	AccordionTrigger,
} from "@ui-sdk/react/accordion";
import { ChevronDown } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

const item = "disclosure";

export interface DisclosureProps {
	open?: boolean;
	defaultOpen?: boolean;
	onOpenChange?: (open: boolean) => void;
	disabled?: boolean;
	className?: string;
	children: ReactNode;
}

export function Disclosure({
	open,
	defaultOpen = false,
	onOpenChange,
	disabled,
	className,
	children,
}: DisclosureProps) {
	return (
		<Accordion
			collapsible
			defaultValue={defaultOpen ? [item] : []}
			{...(open === undefined ? {} : { value: open ? [item] : [] })}
			{...(disabled === undefined ? {} : { disabled })}
			{...(className === undefined ? {} : { className })}
		>
			<AccordionItem value={item} {...(onOpenChange === undefined ? {} : { onOpenChange })}>
				{children}
			</AccordionItem>
		</Accordion>
	);
}

export function DisclosureTrigger({
	children,
	className,
	...props
}: Omit<ComponentProps<typeof AccordionTrigger>, "children" | "className"> & {
	children: ReactNode;
	className?: string;
}) {
	return (
		<AccordionHeader>
			<AccordionTrigger
				{...props}
				className={cn(
					"group flex w-full items-center justify-between gap-3 py-3 text-start font-medium text-ink hover:text-accent-ink data-disabled:opacity-50",
					className,
				)}
			>
				<span className="min-w-0">{children}</span>
				<ChevronDown
					aria-hidden="true"
					className="size-4 shrink-0 text-muted-foreground motion-safe:transition-transform group-data-open:rotate-180"
				/>
			</AccordionTrigger>
		</AccordionHeader>
	);
}

export function DisclosurePanel({
	className,
	...props
}: ComponentProps<typeof AccordionPanel> & { className?: string }) {
	return (
		<AccordionPanel
			{...props}
			className={cn("ms-1 border-s-2 border-accent-ink py-3 ps-4", className)}
		/>
	);
}
