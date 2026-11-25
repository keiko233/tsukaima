"use client";

import { Radio, RadioGroup } from "@ui-sdk/react/radio";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

export type SegmentedControlProps<Value extends string = string> = Pick<
	ComponentProps<typeof RadioGroup<Value>>,
	"disabled" | "name" | "id" | "aria-label" | "aria-labelledby" | "aria-describedby"
> & {
	value: Value;
	onValueChange: (value: Value) => void;
	options: readonly { value: Value; label: ReactNode; disabled?: boolean }[];
	size?: "sm" | "md";
	className?: string;
};

export function SegmentedControl<Value extends string>({
	value,
	onValueChange,
	options,
	size = "md",
	className,
	...props
}: SegmentedControlProps<Value>) {
	return (
		<RadioGroup<Value>
			{...props}
			value={value}
			onValueChange={(next) => {
				if (next !== null) onValueChange(next);
			}}
			className={cn("inline-flex max-w-full flex-wrap gap-1", className)}
		>
			{options.map((option) => (
				<Radio
					key={option.value}
					value={option.value}
					{...(option.disabled === undefined ? {} : { disabled: option.disabled })}
					className={cn(
						"rounded-sm border border-muted-foreground px-2.5 text-sm text-ink hover:bg-accent-soft data-checked:border-accent-ink data-checked:bg-accent-ink data-checked:text-accent-foreground data-disabled:opacity-50",
						size === "sm" ? "min-h-7" : "min-h-8",
					)}
				>
					{option.label}
				</Radio>
			))}
		</RadioGroup>
	);
}
