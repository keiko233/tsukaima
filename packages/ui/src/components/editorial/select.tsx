"use client";

import {
	Select,
	SelectContent,
	SelectItem,
	SelectItemIndicator,
	SelectTrigger,
	SelectValue,
	type SelectProps,
} from "@ui-sdk/react/select";
import { Check, ChevronDown } from "lucide-react";
import { Children, isValidElement, type ComponentProps, type ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

export type EditorialSelectProps<Value extends string = string> = Omit<
	SelectProps<Value>,
	"multiple" | "value" | "defaultValue" | "onValueChange"
> & {
	value?: Value | null;
	defaultValue?: Value | null;
	className?: string;
	onValueChange?: (value: Value) => void;
};

function collectLabels(children: ReactNode, labels: Map<string, string>) {
	Children.forEach(children, (child) => {
		if (!isValidElement<{ children?: ReactNode; value?: string; label?: string }>(child)) return;
		if (child.type === EditorialSelectItem && child.props.value !== undefined) {
			const { value, label, children: content } = child.props;
			labels.set(value, label ?? (typeof content === "string" ? content : value));
		} else {
			collectLabels(child.props.children, labels);
		}
	});
}

export function EditorialSelect<Value extends string>({
	children,
	className,
	itemToLabel,
	items,
	onValueChange,
	...props
}: EditorialSelectProps<Value>) {
	// Composed options are unmounted in a closed popup, including during SSR.
	const labels = new Map<string, string>();
	if (items === undefined && itemToLabel === undefined) collectLabels(children, labels);
	return (
		<div className={cn("min-w-0", className)}>
			<Select<Value>
				{...props}
				{...(items === undefined ? {} : { items })}
				{...(labels.size === 0 && itemToLabel === undefined
					? {}
					: { itemToLabel: itemToLabel ?? ((value: Value) => labels.get(value) ?? value) })}
				onValueChange={(value) => {
					if (value !== null) onValueChange?.(value);
				}}
			>
				{children}
			</Select>
		</div>
	);
}

export function EditorialSelectTrigger({
	children,
	className,
	...props
}: Omit<ComponentProps<typeof SelectTrigger>, "children" | "className"> & {
	children: ReactNode;
	className?: string;
}) {
	return (
		<SelectTrigger
			{...props}
			className={cn(
				"inline-flex h-7 max-w-full min-w-0 items-center justify-between gap-2 rounded-sm border border-muted-foreground bg-paper px-2 text-start text-sm data-open:border-accent-ink data-disabled:opacity-50 [&>[data-slot=select-value]]:truncate",
				className,
			)}
		>
			{children}
			<ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
		</SelectTrigger>
	);
}

export const EditorialSelectValue = SelectValue;

export function EditorialSelectContent({
	className,
	...props
}: ComponentProps<typeof SelectContent> & { className?: string }) {
	return (
		<SelectContent
			sideOffset={4}
			{...props}
			className={cn(
				"z-50 max-h-(--available-height) min-w-(--anchor-width) overflow-auto rounded-sm border border-line2 bg-popover p-1 text-popover-foreground shadow-md",
				className,
			)}
		/>
	);
}

export function EditorialSelectItem({
	children,
	className,
	...props
}: Omit<ComponentProps<typeof SelectItem<string>>, "children" | "className"> & {
	children: ReactNode;
	className?: string;
}) {
	return (
		<SelectItem
			{...props}
			label={props.label ?? (typeof children === "string" ? children : props.value)}
			className={cn(
				"flex min-h-7 cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1 text-sm data-highlighted:bg-accent-soft data-selected:font-medium data-disabled:cursor-default data-disabled:opacity-50",
				className,
			)}
		>
			{children}
			<SelectItemIndicator className="shrink-0 text-accent-ink">
				<Check className="size-3.5" aria-hidden="true" />
			</SelectItemIndicator>
		</SelectItem>
	);
}
