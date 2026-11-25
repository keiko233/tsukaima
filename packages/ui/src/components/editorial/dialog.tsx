"use client";

import {
	Dialog,
	DialogBackdrop,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "@ui-sdk/react/dialog";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

export {
	Dialog as EditorialDialog,
	DialogTrigger as EditorialDialogTrigger,
	DialogClose as EditorialDialogClose,
};

export function EditorialDialogBackdrop({
	className,
	...props
}: ComponentProps<typeof DialogBackdrop> & { className?: string }) {
	return <DialogBackdrop {...props} className={cn("fixed inset-0 bg-black/45", className)} />;
}

export function EditorialDialogContent<Payload = unknown>({
	className,
	...props
}: ComponentProps<typeof DialogContent<Payload>> & { className?: string }) {
	return (
		<DialogContent<Payload>
			{...props}
			className={cn(
				"fixed inset-0 m-auto h-fit max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-auto border-t-2 border-accent-ink bg-popover p-5 text-popover-foreground shadow-lg backdrop:bg-black/45",
				className,
			)}
		/>
	);
}

export function EditorialDialogTitle({
	className,
	...props
}: ComponentProps<typeof DialogTitle> & { className?: string }) {
	return <DialogTitle {...props} className={cn("font-serif text-2xl", className)} />;
}

export function EditorialDialogDescription({
	className,
	...props
}: ComponentProps<typeof DialogDescription> & { className?: string }) {
	return (
		<DialogDescription {...props} className={cn("mt-1 text-sm text-muted-foreground", className)} />
	);
}
