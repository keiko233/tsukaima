"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "@elaina/ui/lib/utils";
import { m } from "@/paraglide/messages";

export interface ModalProps {
	children: ReactNode;
	className?: string;
	description?: ReactNode;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	title: ReactNode;
}

export function Modal({ children, className, description, onOpenChange, open, title }: ModalProps) {
	const dialogRef = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	const descriptionId = useId();

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		if (!open && dialog.open) dialog.close();
	}, [open]);

	return (
		<dialog
			ref={dialogRef}
			aria-labelledby={titleId}
			aria-describedby={description ? descriptionId : undefined}
			onCancel={(event) => {
				event.preventDefault();
				onOpenChange(false);
			}}
			onClose={() => onOpenChange(false)}
			className={cn(
				"m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-border bg-background p-0 text-foreground shadow-2xl",
				"backdrop:bg-black/40 backdrop:backdrop-blur-[2px]",
				className,
			)}
		>
			<div className="flex items-start gap-4 border-b border-border px-5 py-4">
				<div className="min-w-0 flex-1">
					<h2 id={titleId} className="text-base font-semibold">
						{title}
					</h2>
					{description ? (
						<p id={descriptionId} className="mt-1 text-sm leading-5 text-muted-foreground">
							{description}
						</p>
					) : null}
				</div>
				<button
					type="button"
					onClick={() => onOpenChange(false)}
					aria-label={m.close()}
					className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				>
					<X className="size-4" />
				</button>
			</div>
			<div className="px-5 py-4">{children}</div>
		</dialog>
	);
}

export function ModalActions({ children }: { children: ReactNode }) {
	return <div className="mt-5 flex justify-end gap-2">{children}</div>;
}
