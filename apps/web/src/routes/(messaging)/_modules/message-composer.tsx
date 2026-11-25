"use client";

import { AtSign, CornerDownRight, ListEnd, X, Zap } from "lucide-react";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PromptInput } from "@tsukaima/ui/components/agents/prompt-input";
import { Button } from "@tsukaima/ui/components/motion/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
} from "@tsukaima/ui/components/motion/select";
import type { MessageDeliveryMode, MessageSummary } from "@/lib/api";
import { orpc } from "@/lib/api";
import { cn } from "@tsukaima/ui/lib/utils";
import { m } from "@/paraglide/messages";

type DeliveryTarget = "channel" | "tsukaima";

/** Read the per-session mode, upgrading the old `queue` value written before steer existed. */
function storedDeliveryMode(key: string): MessageDeliveryMode {
	let stored: string | null = null;
	try {
		stored = localStorage.getItem(key);
	} catch {
		return "steer";
	}
	if (stored === "queue") {
		try {
			localStorage.setItem(key, "steer");
		} catch {
			// Storage can be unavailable; the in-memory default is still steer.
		}
		return "steer";
	}
	return stored === "interrupt" || stored === "follow-up" || stored === "steer" ? stored : "steer";
}

export function MessageComposer({
	channelConnected,
	disabled,
	externalEligible,
	onSend,
	sending,
	sessionId,
	workspace = false,
}: {
	channelConnected: boolean;
	disabled: boolean;
	externalEligible: boolean;
	onSend: (input: {
		mode: MessageDeliveryMode;
		references?: { messageId?: string; sessionId: string }[];
		target: DeliveryTarget;
		text: string;
	}) => Promise<MessageSummary>;
	sending: boolean;
	sessionId: string;
	workspace?: boolean;
}) {
	const draftKey = `tsukaima.webui.draft.${sessionId}`;
	const modeKey = `tsukaima.webui.delivery-mode.${sessionId}`;
	const [text, setText] = useState(() => localStorage.getItem(draftKey) ?? "");
	const [mode, setMode] = useState<MessageDeliveryMode>(() => storedDeliveryMode(modeKey));
	// External chats only send directly to the channel from the WebUI; internal Tsukaima turns
	// are not exposed in the external composer so operator interventions never surface as chat UX.
	const target: DeliveryTarget = externalEligible ? "channel" : "tsukaima";
	const channelUnavailable = externalEligible && !channelConnected;
	const [references, setReferences] = useState<
		Array<{ kind: string; sessionId: string; title: string }>
	>([]);
	const [referenceOpen, setReferenceOpen] = useState(false);
	const [referenceQuery, setReferenceQuery] = useState("");
	const referenceInputRef = useRef<HTMLInputElement>(null);
	const referenceSearch = useQuery({
		...orpc.admin.sessions.search.queryOptions({
			input: {
				...(referenceQuery.trim().length === 0 ? {} : { query: referenceQuery.trim() }),
				limit: 12,
			},
		}),
		enabled: workspace && referenceOpen,
	});

	const updateText = (next: string) => {
		setText(next);
		localStorage.setItem(draftKey, next);
	};

	const updateMode = (next: MessageDeliveryMode) => {
		setMode(next);
		localStorage.setItem(modeKey, next);
	};

	const submit = async (value: string) => {
		try {
			const message = await onSend({
				mode,
				...(references.length === 0
					? {}
					: { references: references.map((reference) => ({ sessionId: reference.sessionId })) }),
				target,
				text: value,
			});
			if (message.deliveryStatus !== "failed" && message.deliveryStatus !== "uncertain") {
				updateText("");
				setReferences([]);
				localStorage.removeItem(draftKey);
			}
		} catch {
			// The page-level mutation renders the error and keeps the draft intact.
		}
	};

	const addReference = (reference: { kind: string; sessionId: string; title: string }) => {
		if (reference.sessionId === sessionId) return;
		setReferences((current) =>
			current.some((entry) => entry.sessionId === reference.sessionId)
				? current
				: [...current, reference].slice(0, 10),
		);
		setReferenceOpen(false);
		setReferenceQuery("");
	};

	const referencePicker = workspace ? (
		<div className="relative">
			<Button
				type="button"
				variant="ghost"
				size="icon"
				disabled={disabled || sending}
				aria-label={m.workspace_reference_insert()}
				title={m.workspace_reference_insert()}
				onClick={() => {
					setReferenceOpen((current) => !current);
					requestAnimationFrame(() => referenceInputRef.current?.focus());
				}}
				className="size-7 rounded-md"
			>
				<AtSign className="size-4" />
			</Button>
			{referenceOpen ? (
				<div className="absolute bottom-9 left-0 z-30 w-72 rounded-lg border border-border bg-popover p-1.5 shadow-lg">
					<input
						ref={referenceInputRef}
						value={referenceQuery}
						onChange={(event) => setReferenceQuery(event.target.value)}
						placeholder={m.composer_reference_placeholder()}
						className="mb-1 w-full rounded-md border border-border bg-background px-2 py-1 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
					/>
					<div className="max-h-56 overflow-y-auto">
						{referenceSearch.isPending ? (
							<div className="px-2 py-3 text-[11px] text-muted-foreground">{m.loading()}</div>
						) : referenceSearch.isError ? (
							<div className="px-2 py-3 text-[11px] text-destructive">
								{referenceSearch.error.message}
							</div>
						) : (referenceSearch.data ?? []).length === 0 ? (
							<div className="px-2 py-3 text-[11px] text-muted-foreground">
								{m.workspace_references_empty()}
							</div>
						) : (
							(referenceSearch.data ?? []).map((reference) => (
								<button
									key={reference.id}
									type="button"
									disabled={reference.id === sessionId}
									onClick={() =>
										addReference({
											kind: reference.kind,
											sessionId: reference.id,
											title: reference.title,
										})
									}
									className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-muted disabled:opacity-40"
								>
									<span className="min-w-0 flex-1 truncate">{reference.title}</span>
									<span className="shrink-0 text-[10px] text-muted-foreground">
										{reference.kind}
									</span>
								</button>
							))
						)}
					</div>
				</div>
			) : null}
		</div>
	) : null;

	const modeSelect =
		target === "tsukaima" ? (
			<Select
				value={mode}
				onValueChange={(value) => updateMode(value as MessageDeliveryMode)}
				disabled={disabled || sending}
			>
				<SelectTrigger
					className="h-7 w-auto max-w-44 rounded-md border-0 bg-transparent px-1.5 py-0 text-[11px] hover:bg-muted focus-visible:ring-2"
					aria-label={m.delivery_mode()}
				>
					<span className="flex min-w-0 items-center gap-1.5">
						{mode === "interrupt" ? (
							<Zap className="size-3 text-muted-foreground" />
						) : mode === "follow-up" ? (
							<ListEnd className="size-3 text-muted-foreground" />
						) : (
							<CornerDownRight className="size-3 text-muted-foreground" />
						)}
						<span className="truncate text-muted-foreground">
							{mode === "interrupt"
								? m.delivery_mode_interrupt()
								: mode === "follow-up"
									? m.delivery_mode_follow_up()
									: m.delivery_mode_steer()}
						</span>
					</span>
				</SelectTrigger>
				<SelectContent className="right-auto w-64 shadow-none">
					<SelectItem value="steer" className="py-2">
						<span className="block">
							<span className="block text-sm text-foreground">{m.delivery_mode_steer()}</span>
							<span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
								{m.delivery_mode_steer_hint()}
							</span>
						</span>
					</SelectItem>
					<SelectItem value="follow-up" className="py-2">
						<span className="block">
							<span className="block text-sm text-foreground">{m.delivery_mode_follow_up()}</span>
							<span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
								{m.delivery_mode_follow_up_hint()}
							</span>
						</span>
					</SelectItem>
					<SelectItem value="interrupt" className="py-2">
						<span className="block">
							<span className="block text-sm text-foreground">{m.delivery_mode_interrupt()}</span>
							<span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
								{m.delivery_mode_interrupt_hint()}
							</span>
						</span>
					</SelectItem>
				</SelectContent>
			</Select>
		) : null;

	return (
		<div className="shrink-0 bg-background px-3 pb-2.5 pt-1 sm:px-5">
			<div className="mx-auto w-full max-w-4xl">
				{references.length > 0 ? (
					<div className="mb-1 flex flex-wrap gap-1">
						{references.map((reference) => (
							<span
								key={reference.sessionId}
								className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10.5px] text-foreground/85"
							>
								<AtSign className="size-3 shrink-0" />
								<span className="max-w-48 truncate">{reference.title}</span>
								<button
									type="button"
									aria-label={m.composer_reference_remove()}
									onClick={() =>
										setReferences((current) =>
											current.filter((entry) => entry.sessionId !== reference.sessionId),
										)
									}
									className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
								>
									<X className="size-3" />
								</button>
							</span>
						))}
					</div>
				) : null}
				<PromptInput
					value={text}
					onValueChange={updateText}
					onSubmit={(value) => void submit(value)}
					placeholder={m.composer_placeholder()}
					aria-label={m.composer_placeholder()}
					disabled={disabled || sending || channelUnavailable}
					minRows={1}
					maxRows={8}
					leadingAction={
						modeSelect !== null || referencePicker !== null ? (
							<span className="flex items-center gap-0.5">
								{referencePicker}
								{modeSelect}
							</span>
						) : null
					}
					className={cn(sending && "opacity-80")}
				/>
				<p className="mt-1 px-1.5 text-[10px] leading-4 text-muted-foreground/80">
					{target === "channel"
						? channelConnected
							? m.composer_hint_channel()
							: m.channel_not_connected()
						: workspace
							? m.composer_hint_workspace()
							: m.composer_hint_tsukaima()}
				</p>
			</div>
		</div>
	);
}
