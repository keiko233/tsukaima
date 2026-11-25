"use client";

import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

export type EditorialTabsProps<Value extends string = string> = Omit<
	ComponentProps<typeof Tabs<Value>>,
	"onValueChange"
> & { onValueChange?: (value: Value) => void };

export function EditorialTabs<Value extends string>({
	onValueChange,
	...props
}: EditorialTabsProps<Value>) {
	return (
		<Tabs<Value>
			{...props}
			onValueChange={(value) => {
				if (value !== null) onValueChange?.(value);
			}}
		/>
	);
}

export function EditorialTabsList({
	className,
	...props
}: ComponentProps<typeof TabsList> & { className?: string }) {
	return (
		<TabsList {...props} className={cn("flex flex-wrap gap-x-1 border-b border-line", className)} />
	);
}

export function EditorialTabsTrigger({
	children,
	icon,
	className,
	...props
}: Omit<ComponentProps<typeof TabsTab>, "children" | "className"> & {
	children: ReactNode;
	icon?: ReactNode;
	className?: string;
}) {
	return (
		<TabsTab
			{...props}
			className={cn(
				"-mb-px inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground hover:text-ink data-selected:border-accent-ink data-selected:text-ink data-disabled:opacity-50",
				className,
			)}
		>
			{icon && <span aria-hidden="true">{icon}</span>}
			{children}
		</TabsTab>
	);
}

export function EditorialTabsContent({
	className,
	...props
}: ComponentProps<typeof TabsPanel> & { className?: string }) {
	return <TabsPanel keepMounted {...props} className={cn("mt-4", className)} />;
}
