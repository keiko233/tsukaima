import type { ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { ChatApp } from "@/components/agents/chat-app";
import { AnimatedSidebar } from "@/components/motion/animated-sidebar";
import { AnimatedSidebarContent } from "@/components/motion/animated-sidebar";
import { AnimatedSidebarGroup } from "@/components/motion/animated-sidebar";
import { AnimatedSidebarGroupContent } from "@/components/motion/animated-sidebar";
import { AnimatedSidebarGroupLabel } from "@/components/motion/animated-sidebar";
import { AnimatedSidebarHeader } from "@/components/motion/animated-sidebar";
import { AnimatedSidebarMenu } from "@/components/motion/animated-sidebar";
import { AnimatedSidebarMenuItem } from "@/components/motion/animated-sidebar";
import { AnimatedSidebarMenuButton } from "@/components/motion/animated-sidebar";

const views = [
	{ to: "/", label: "Conversations" },
	{ to: "/policies", label: "Policies" },
	{ to: "/plugins", label: "Plugins" },
	{ to: "/diagnostics", label: "Diagnostics" },
] as const;

export function AdminShell({ children }: { readonly children: ReactNode }) {
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	return (
		<main className="h-dvh bg-background p-4">
			<ChatApp className="h-full">
				<AnimatedSidebar ariaLabel="Tsukaima admin">
					<AnimatedSidebarHeader>
						<AnimatedSidebarGroup>
							<AnimatedSidebarGroupLabel>Tsukaima</AnimatedSidebarGroupLabel>
							<AnimatedSidebarGroupContent>
								<AnimatedSidebarMenu>
									{views.map((view) => (
										<AnimatedSidebarMenuItem key={view.to}>
											<AnimatedSidebarMenuButton
												href={view.to}
												isActive={pathname === view.to}
												onSelect={() => {}}
											>
												{view.label}
											</AnimatedSidebarMenuButton>
										</AnimatedSidebarMenuItem>
									))}
								</AnimatedSidebarMenu>
							</AnimatedSidebarGroupContent>
						</AnimatedSidebarGroup>
					</AnimatedSidebarHeader>
					<AnimatedSidebarContent>{children}</AnimatedSidebarContent>
				</AnimatedSidebar>
			</ChatApp>
		</main>
	);
}
