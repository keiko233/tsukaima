"use client";

import { Code2 } from "lucide-react";
import { Button } from "@tsukaima/ui/components/motion/button";
import { m } from "@/paraglide/messages";
import { ChatPage } from "../../(messaging)/_modules/chat-page";
import { useShellNavigation } from "../../_modules/shell/admin-shell";

export function WorkspacePage({ sessionId }: { sessionId: string }) {
	return <ChatPage sessionId={sessionId} surface="workspace" />;
}

export function WorkspaceEmptyState() {
	const { mobile, showSidebar } = useShellNavigation();
	return (
		<div className="grid h-full place-items-center px-6">
			<div className="flex max-w-sm flex-col items-center text-center">
				<span className="grid size-10 place-items-center rounded-xl bg-violet/10 text-violet">
					<Code2 className="size-5" />
				</span>
				<h1 className="mt-3 text-[14px] font-semibold tracking-tight">
					{m.workspace_welcome_title()}
				</h1>
				<p className="mt-1 text-[11.5px] leading-5 text-muted-foreground">
					{m.workspace_welcome_description()}
				</p>
				{mobile ? (
					<Button variant="outline" size="sm" className="mt-4" onClick={showSidebar}>
						{m.topbar_back_to_sidebar()}
					</Button>
				) : null}
			</div>
		</div>
	);
}
