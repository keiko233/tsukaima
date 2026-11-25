"use client";

import {
	Popover,
	PopoverClose,
	PopoverContent,
	PopoverDescription,
	PopoverTitle,
	PopoverTrigger,
} from "@ui-sdk/react/popover";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

export {
	Popover as EditorialPopover,
	PopoverTrigger as EditorialPopoverTrigger,
	PopoverClose as EditorialPopoverClose,
};

export function EditorialPopoverContent<Payload = unknown>({
	className,
	...props
}: ComponentProps<typeof PopoverContent<Payload>> & { className?: string }) {
	return (
		<PopoverContent<Payload>
			sideOffset={6}
			{...props}
			className={cn(
				"z-50 max-h-(--available-height) max-w-[calc(100vw-2rem)] overflow-auto rounded-sm border border-line2 bg-popover p-3 text-popover-foreground shadow-md",
				className,
			)}
		/>
	);
}

export function EditorialPopoverTitle({
	className,
	...props
}: ComponentProps<typeof PopoverTitle> & { className?: string }) {
	return <PopoverTitle {...props} className={cn("font-serif text-lg", className)} />;
}

export function EditorialPopoverDescription({
	className,
	...props
}: ComponentProps<typeof PopoverDescription> & { className?: string }) {
	return (
		<PopoverDescription
			{...props}
			className={cn("mt-1 text-sm text-muted-foreground", className)}
		/>
	);
}
