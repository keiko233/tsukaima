import { Bot, FolderOpen, MessageCircle, Users, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function Avatar({
	className,
	kind = "human",
	name,
}: {
	className?: string;
	kind?: "assistant" | "bot" | "group" | "human" | "webui";
	name: string;
}) {
	const initial = name.trim().slice(0, 1).toUpperCase() || "?";
	const Icon =
		kind === "assistant" || kind === "bot"
			? Bot
			: kind === "group"
				? Users
				: kind === "webui"
					? FolderOpen
					: null;
	return (
		<span
			aria-hidden="true"
			className={cn(
				"grid size-8 shrink-0 place-items-center rounded-full border border-border bg-card text-xs font-semibold text-muted-foreground",
				kind === "assistant" && "border-primary/20 bg-primary/10 text-primary",
				kind === "group" && "border-violet/20 bg-violet/10 text-violet",
				kind === "webui" && "border-border bg-muted text-foreground",
				className,
			)}
		>
			{Icon ? <Icon className="size-4" /> : initial}
		</span>
	);
}

export function IconTile({ className, icon: Icon }: { className?: string; icon: LucideIcon }) {
	return (
		<span
			className={cn(
				"grid size-8 shrink-0 place-items-center rounded-xl border border-border bg-card text-muted-foreground",
				className,
			)}
		>
			<Icon className="size-4" />
		</span>
	);
}

export function SidebarEmpty({
	action,
	description,
	icon: Icon = MessageCircle,
	title,
}: {
	action?: React.ReactNode;
	description: string;
	icon?: LucideIcon;
	title: string;
}) {
	return (
		<div className="mx-2 my-4 rounded-2xl border border-dashed border-border px-4 py-7 text-center">
			<div className="mx-auto grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
				<Icon className="size-4" />
			</div>
			<p className="mt-3 text-sm font-medium text-foreground">{title}</p>
			<p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
			{action ? <div className="mt-4 flex justify-center">{action}</div> : null}
		</div>
	);
}

export function InlineError({
	message,
	onRetry,
	retryLabel,
}: {
	message: string;
	onRetry?: () => void;
	retryLabel: string;
}) {
	return (
		<div
			role="alert"
			className="mx-2 my-3 rounded-xl border border-destructive/25 bg-destructive/5 p-3"
		>
			<p className="text-xs leading-5 text-destructive">{message}</p>
			{onRetry ? (
				<button
					type="button"
					onClick={onRetry}
					className="mt-1 text-xs font-medium text-destructive underline underline-offset-4"
				>
					{retryLabel}
				</button>
			) : null}
		</div>
	);
}
