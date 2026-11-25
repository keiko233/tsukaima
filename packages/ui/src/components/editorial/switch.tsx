"use client";

import { Switch, SwitchThumb } from "@ui-sdk/react/switch";
import { useId, type ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

export type EditorialSwitchProps = Omit<ComponentProps<typeof Switch>, "className" | "children"> & {
	ariaLabel?: string;
	label?: string;
	className?: string;
};

export function EditorialSwitch({
	id,
	ariaLabel,
	"aria-label": ariaLabelProp,
	label,
	className,
	...props
}: EditorialSwitchProps) {
	const generatedId = useId();
	const controlId = id ?? generatedId;
	const control = (
		<Switch
			{...props}
			id={controlId}
			aria-label={ariaLabelProp ?? ariaLabel ?? label}
			className={cn(
				"relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-muted-foreground bg-paper text-ink transition-colors data-checked:border-accent-ink data-checked:bg-accent-ink data-checked:text-accent-foreground data-disabled:opacity-50",
				className,
			)}
		>
			<SwitchThumb className="ms-0.5 size-3.5 rounded-full bg-current motion-safe:transition-transform data-checked:translate-x-4 rtl:data-checked:-translate-x-4" />
		</Switch>
	);
	return label ? (
		<label htmlFor={controlId} className="inline-flex items-center gap-2 text-sm">
			{control}
			{label}
		</label>
	) : (
		control
	);
}
