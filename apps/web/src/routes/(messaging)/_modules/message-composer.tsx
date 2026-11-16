"use client";

import { ListEnd, MessageCircle, Send, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { PromptInput } from "@tsukaima/ui/components/agents/prompt-input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
} from "@tsukaima/ui/components/motion/select";
import type { MessageDeliveryMode, MessageSummary } from "@/lib/api";
import { cn } from "@tsukaima/ui/lib/utils";
import { m } from "@/paraglide/messages";

type DeliveryTarget = "channel" | "tsukaima";

export function MessageComposer({
	channelConnected,
	disabled,
	externalEligible,
	onSend,
	sending,
	sessionId,
}: {
	channelConnected: boolean;
	disabled: boolean;
	externalEligible: boolean;
	onSend: (input: {
		mode: MessageDeliveryMode;
		target: DeliveryTarget;
		text: string;
	}) => Promise<MessageSummary>;
	sending: boolean;
	sessionId: string;
}) {
	const draftKey = `tsukaima.webui.draft.${sessionId}`;
	const targetKey = `tsukaima.webui.target.${sessionId}`;
	const modeKey = `tsukaima.webui.delivery-mode.${sessionId}`;
	const [text, setText] = useState(() => localStorage.getItem(draftKey) ?? "");
	const [mode, setMode] = useState<MessageDeliveryMode>(() => {
		const stored = localStorage.getItem(modeKey);
		return stored === "interrupt" || stored === "follow-up" ? stored : "queue";
	});
	const [target, setTarget] = useState<DeliveryTarget>(() => {
		const stored = localStorage.getItem(targetKey);
		return stored === "channel" ? "channel" : "tsukaima";
	});

	useEffect(() => {
		if (!externalEligible || !channelConnected) setTarget("tsukaima");
	}, [channelConnected, externalEligible]);

	const updateText = (next: string) => {
		setText(next);
		localStorage.setItem(draftKey, next);
	};

	const updateTarget = (next: DeliveryTarget) => {
		setTarget(next);
		localStorage.setItem(targetKey, next);
	};

	const updateMode = (next: MessageDeliveryMode) => {
		setMode(next);
		localStorage.setItem(modeKey, next);
	};

	const submit = async (value: string) => {
		try {
			const message = await onSend({ mode, target, text: value });
			if (message.deliveryStatus !== "failed" && message.deliveryStatus !== "uncertain") {
				updateText("");
				localStorage.removeItem(draftKey);
			}
		} catch {
			// The page-level mutation renders the error and keeps the draft intact.
		}
	};

	const targetSelect = externalEligible ? (
		<Select
			value={target}
			onValueChange={(value) => updateTarget(value as DeliveryTarget)}
			disabled={disabled || sending}
		>
			<SelectTrigger
				className="h-7 w-auto max-w-48 rounded-md border-0 bg-transparent px-1.5 py-0 text-[11px] hover:bg-muted focus-visible:ring-2"
				aria-label={m.session_target()}
			>
				<span className="flex min-w-0 items-center gap-1.5">
					{target === "channel" ? (
						<Send className="size-3 text-muted-foreground" />
					) : (
						<MessageCircle className="size-3 text-muted-foreground" />
					)}
					<span className="truncate text-muted-foreground">
						{target === "channel" ? m.send_to_channel() : m.send_to_tsukaima()}
					</span>
				</span>
			</SelectTrigger>
			<SelectContent className="right-auto w-60 shadow-none">
				<SelectItem value="tsukaima" className="py-2">
					<span className="block">
						<span className="block text-sm text-foreground">{m.send_to_tsukaima()}</span>
						<span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
							{m.composer_hint_tsukaima()}
						</span>
					</span>
				</SelectItem>
				<SelectItem value="channel" disabled={!channelConnected} className="py-2">
					<span className="block">
						<span className="block text-sm text-foreground">{m.send_to_channel()}</span>
						<span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
							{channelConnected ? m.composer_hint_channel() : m.channel_not_connected()}
						</span>
					</span>
				</SelectItem>
			</SelectContent>
		</Select>
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
						) : (
							<ListEnd className="size-3 text-muted-foreground" />
						)}
						<span className="truncate text-muted-foreground">
							{mode === "interrupt"
								? m.delivery_mode_interrupt()
								: mode === "follow-up"
									? m.delivery_mode_follow_up()
									: m.delivery_mode_queue()}
						</span>
					</span>
				</SelectTrigger>
				<SelectContent className="right-auto w-64 shadow-none">
					<SelectItem value="queue" className="py-2">
						<span className="block">
							<span className="block text-sm text-foreground">{m.delivery_mode_queue()}</span>
							<span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
								{m.delivery_mode_queue_hint()}
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
					<SelectItem value="follow-up" className="py-2">
						<span className="block">
							<span className="block text-sm text-foreground">{m.delivery_mode_follow_up()}</span>
							<span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
								{m.delivery_mode_follow_up_hint()}
							</span>
						</span>
					</SelectItem>
				</SelectContent>
			</Select>
		) : null;

	return (
		<div className="shrink-0 bg-background px-3 pb-2.5 pt-1 sm:px-5">
			<div className="mx-auto w-full max-w-4xl">
				<PromptInput
					value={text}
					onValueChange={updateText}
					onSubmit={(value) => void submit(value)}
					placeholder={m.composer_placeholder()}
					aria-label={m.composer_placeholder()}
					disabled={disabled || sending}
					minRows={1}
					maxRows={8}
					leadingAction={
						targetSelect !== null || modeSelect !== null ? (
							<span className="flex items-center gap-0.5">
								{targetSelect}
								{modeSelect}
							</span>
						) : null
					}
					className={cn(sending && "opacity-80")}
				/>
				<p className="mt-1 px-1.5 text-[10px] leading-4 text-muted-foreground/80">
					{target === "channel" ? m.composer_hint_channel() : m.composer_hint_tsukaima()}
				</p>
			</div>
		</div>
	);
}
