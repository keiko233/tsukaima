"use client";

import { MessageCircle, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { PromptInput } from "@/components/agents/prompt-input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/motion/select";
import type { MessageSummary } from "@/lib/api";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

type DeliveryTarget = "channel" | "elaina";

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
	onSend: (input: { target: DeliveryTarget; text: string }) => Promise<MessageSummary>;
	sending: boolean;
	sessionId: string;
}) {
	const draftKey = `elaina.webui.draft.${sessionId}`;
	const targetKey = `elaina.webui.target.${sessionId}`;
	const [text, setText] = useState(() => localStorage.getItem(draftKey) ?? "");
	const [target, setTarget] = useState<DeliveryTarget>(() => {
		const stored = localStorage.getItem(targetKey);
		return stored === "channel" ? "channel" : "elaina";
	});

	useEffect(() => {
		if (!externalEligible || !channelConnected) setTarget("elaina");
	}, [channelConnected, externalEligible]);

	const updateText = (next: string) => {
		setText(next);
		localStorage.setItem(draftKey, next);
	};

	const updateTarget = (next: DeliveryTarget) => {
		setTarget(next);
		localStorage.setItem(targetKey, next);
	};

	const submit = async (value: string) => {
		try {
			const message = await onSend({ target, text: value });
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
				className="h-8 w-auto max-w-48 rounded-xl border-0 bg-transparent px-2 py-0 text-xs hover:bg-muted focus-visible:ring-2"
				aria-label={m.session_target()}
			>
				<span className="flex min-w-0 items-center gap-1.5">
					{target === "channel" ? (
						<Send className="size-3.5 text-muted-foreground" />
					) : (
						<MessageCircle className="size-3.5 text-muted-foreground" />
					)}
					<span className="truncate text-muted-foreground">
						{target === "channel" ? m.send_to_channel() : m.send_to_elaina()}
					</span>
				</span>
			</SelectTrigger>
			<SelectContent className="right-auto w-60 shadow-none">
				<SelectItem value="elaina" className="py-2">
					<span className="block">
						<span className="block text-sm text-foreground">{m.send_to_elaina()}</span>
						<span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
							{m.composer_hint_elaina()}
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

	return (
		<div className="shrink-0 border-t border-border bg-background px-3 pb-3 pt-2 sm:px-5">
			<div className="mx-auto w-full max-w-3xl">
				<PromptInput
					value={text}
					onValueChange={updateText}
					onSubmit={(value) => void submit(value)}
					placeholder={m.composer_placeholder()}
					aria-label={m.composer_placeholder()}
					disabled={disabled || sending}
					minRows={1}
					maxRows={8}
					leadingAction={targetSelect}
					className={cn("bg-background", sending && "opacity-80")}
				/>
				<p className="mt-1.5 px-2 text-[10px] leading-4 text-muted-foreground">
					{target === "channel" ? m.composer_hint_channel() : m.composer_hint_elaina()}
				</p>
			</div>
		</div>
	);
}
