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
				"m-auto w-[calc(100%-2rem)] max-w-[420px] rounded-xl border border-border bg-background p-0 text-foreground shadow-2xl",
				"backdrop:bg-black/40 backdrop:backdrop-blur-[2px]",
				className,
			)}
		>
			<div className="flex items-start gap-3 border-b border-border px-4 py-3">
				<div className="min-w-0 flex-1">
					<h2 id={titleId} className="text-[13.5px] font-semibold">
						{title}
					</h2>
					{description ? (
						<p id={descriptionId} className="mt-0.5 text-[11.5px] leading-4 text-muted-foreground">
							{description}
						</p>
					) : null}
				</div>
				<button
					type="button"
					onClick={() => onOpenChange(false)}
					aria-label={m.close()}
					className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				>
					<X className="size-3.5" />
				</button>
			</div>
			<div className="px-4 py-3.5">{children}</div>
		</dialog>
	);
}

export function ModalActions({ children }: { children: ReactNode }) {
	return <div className="mt-4 flex justify-end gap-1.5">{children}</div>;
}
