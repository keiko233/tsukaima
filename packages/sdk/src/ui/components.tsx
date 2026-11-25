"use client";

import type { PluginStatusLevel, PluginStatusSnapshot } from "@tsukaima/contracts";
import { EditorialGroup } from "@tsukaima/ui/components/editorial/group";
import { KpiStrip } from "@tsukaima/ui/components/editorial/kpi-strip";
import { Loader } from "@tsukaima/ui/components/motion/loader";
import { cn } from "@tsukaima/ui/lib/utils";
import { AlertTriangle, CheckCircle2, CircleHelp, Info, XCircle } from "lucide-react";
import { Children, isValidElement, type ComponentPropsWithRef, type ReactNode } from "react";

export function PluginPage({
	title,
	description,
	actions,
	children,
	embedded = true,
}: {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	embedded?: boolean;
}) {
	return (
		<section className="space-y-5">
			<h2 className={embedded ? "sr-only" : "font-serif text-2xl text-ink"}>{title}</h2>
			{(description != null || actions != null) && (
				<div className="flex flex-wrap items-center justify-between gap-3">
					{description != null && <p className="text-sm text-muted-foreground">{description}</p>}
					{actions != null && <div className="ms-auto flex items-center gap-2">{actions}</div>}
				</div>
			)}
			{children}
		</section>
	);
}

export function PluginSection({
	title,
	description,
	actions,
	children,
	className,
}: {
	title?: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<EditorialGroup
			title={title}
			description={description}
			actions={actions}
			className={cn("first:border-t-0 first:pt-0", className)}
		>
			{children}
		</EditorialGroup>
	);
}

export function PluginToolbar({ children }: { children: ReactNode }) {
	return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

const LEVEL_STYLE: Record<PluginStatusLevel, { dot: string; text: string; icon: ReactNode }> = {
	ok: {
		dot: "bg-success",
		icon: <CheckCircle2 className="size-4" />,
		text: "text-success",
	},
	warning: {
		dot: "bg-warning",
		icon: <AlertTriangle className="size-4" />,
		text: "text-warning",
	},
	error: {
		dot: "bg-destructive",
		icon: <XCircle className="size-4" />,
		text: "text-destructive",
	},
	unknown: {
		dot: "bg-muted-foreground",
		icon: <CircleHelp className="size-4" />,
		text: "text-muted-foreground",
	},
};

export function StatusDot({ level }: { level: PluginStatusLevel }) {
	return (
		<span
			aria-hidden="true"
			className={cn("inline-block size-2 shrink-0 rounded-full", LEVEL_STYLE[level].dot)}
		/>
	);
}

export function StatusBadge({
	status,
	label,
	disabled = false,
	stale = false,
	className,
}: {
	status: PluginStatusSnapshot | null;
	label: string;
	disabled?: boolean;
	stale?: boolean;
	className?: string;
}) {
	const level: PluginStatusLevel = disabled ? "unknown" : (status?.level ?? "unknown");
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 text-xs",
				LEVEL_STYLE[level].text,
				disabled && "opacity-60",
				className,
			)}
		>
			<StatusDot level={level} />
			{label}
			{stale ? <span className="text-muted-foreground">· stale</span> : null}
		</span>
	);
}

export function ProgressBar({
	current,
	total,
	label,
}: {
	current: number;
	total?: number;
	label?: string;
}) {
	const ratio = total === undefined || total <= 0 ? 0 : Math.min(1, Math.max(0, current / total));
	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between text-xs text-muted-foreground">
				<span>{label}</span>
				<span className="font-mono tabular-nums">
					{total === undefined ? current : `${current} / ${total}`}
				</span>
			</div>
			<div
				role="progressbar"
				aria-label={label}
				aria-valuemax={total}
				aria-valuemin={0}
				aria-valuenow={current}
				className="h-1 overflow-hidden bg-muted"
			>
				<div
					className="h-full bg-accent-ink transition-[width] duration-300"
					style={{ width: `${ratio * 100}%` }}
				/>
			</div>
		</div>
	);
}

export function Stat({ label, value }: { label: ReactNode; value: ReactNode }) {
	return <KpiStrip items={[{ label, value }]} className="grid-cols-1" />;
}

export function StatGrid({
	items,
	className,
}: {
	items: readonly { readonly label: ReactNode; readonly value: ReactNode }[];
	className?: string;
}) {
	return <KpiStrip items={items} {...(className === undefined ? {} : { className })} />;
}

export function KeyValueList({
	items,
	className,
}: {
	items: readonly { readonly id?: string; readonly label: ReactNode; readonly value: ReactNode }[];
	className?: string;
}) {
	return (
		<dl className={cn("grid text-sm sm:grid-cols-[minmax(7rem,auto)_1fr]", className)}>
			{Children.toArray(
				items.map(({ id, label, value }) => {
					const key = id ?? (isValidElement(label) ? label.key : String(label));
					return (
						<div
							key={key ?? undefined}
							className="grid gap-x-4 gap-y-1 border-b border-border/60 py-2 last:border-b-0 sm:col-span-2 sm:grid-cols-subgrid"
						>
							<dt className="text-muted-foreground">{label}</dt>
							<dd className="min-w-0 break-words">{value}</dd>
						</div>
					);
				}),
			)}
		</dl>
	);
}

export function EmptyState({
	icon,
	title,
	description,
	action,
}: {
	icon?: ReactNode;
	title: ReactNode;
	description?: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="grid place-items-center border-t border-border px-6 py-10 text-center">
			<div className="max-w-md space-y-2">
				{icon ? <div className="mx-auto text-muted-foreground">{icon}</div> : null}
				<div className="font-serif text-lg text-ink">{title}</div>
				{description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
				{action ? <div className="pt-2">{action}</div> : null}
			</div>
		</div>
	);
}

const ALERT_STYLE = {
	danger: "border-destructive text-destructive",
	info: "border-accent-ink text-foreground",
	success: "border-success text-foreground",
	warning: "border-warning text-foreground",
} as const;

export function Alert({
	tone = "info",
	title,
	children,
}: {
	tone?: keyof typeof ALERT_STYLE;
	title?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<div
			role={tone === "danger" ? "alert" : "status"}
			className={cn("border-s-2 px-3 py-2.5 text-sm", ALERT_STYLE[tone])}
		>
			<div className="flex items-start gap-2">
				<span className="mt-0.5 shrink-0">
					{tone === "danger" ? (
						<XCircle className="size-4" />
					) : tone === "warning" ? (
						<AlertTriangle className="size-4" />
					) : tone === "success" ? (
						<CheckCircle2 className="size-4" />
					) : (
						<Info className="size-4" />
					)}
				</span>
				<div className="min-w-0 space-y-1">
					{title ? <div className="font-medium">{title}</div> : null}
					{children ? <div className="text-xs leading-5">{children}</div> : null}
				</div>
			</div>
		</div>
	);
}

export function Spinner({ label }: { label?: string }) {
	return (
		<div className="flex items-center gap-2 text-sm text-muted-foreground">
			<Loader size={14} />
			{label}
		</div>
	);
}

export function Skeleton({ className }: { className?: string }) {
	return <div className={cn("animate-pulse rounded-md bg-muted", className)} />;
}

export function RelativeTime({
	value,
	formatter,
}: {
	value: string | number | Date;
	formatter: (value: string | number | Date) => string;
}) {
	const date = value instanceof Date ? value : new Date(value);
	const title = Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
	return (
		<time dateTime={title} title={title}>
			{formatter(value)}
		</time>
	);
}

export function CodeBlock({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<pre
			className={cn(
				"max-h-72 overflow-auto rounded-sm border border-line bg-muted/50 p-3 font-mono text-[11px] leading-5 tabular-nums",
				className,
			)}
		>
			<code>{children}</code>
		</pre>
	);
}

export interface FieldProps extends ComponentPropsWithRef<"div"> {
	label?: ReactNode;
	hint?: ReactNode;
	error?: ReactNode;
	required?: boolean;
}

export function Field({ label, hint, error, required, className, children, ...rest }: FieldProps) {
	return (
		<div className={cn("space-y-1.5", className)} {...rest}>
			{label ? (
				<div className="text-xs font-medium text-foreground">
					{label}
					{required ? <span className="ml-0.5 text-destructive">*</span> : null}
				</div>
			) : null}
			{children}
			{error ? (
				<p className="text-xs text-destructive">{error}</p>
			) : hint ? (
				<p className="text-xs text-muted-foreground">{hint}</p>
			) : null}
		</div>
	);
}
