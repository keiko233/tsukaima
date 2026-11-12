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
import { m } from "@/paraglide/messages";

const views = [
	{ to: "/", label: m.nav_conversations },
	{ to: "/policies", label: m.nav_policies },
	{ to: "/plugins", label: m.nav_plugins },
	{ to: "/diagnostics", label: m.nav_diagnostics },
	{ to: "/settings", label: m.nav_settings },
] as const;

export function AdminShell({ children }: { readonly children: ReactNode }) {
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	return (
		<main className="h-dvh bg-background p-4">
			<ChatApp className="h-full">
				<AnimatedSidebar ariaLabel="Elaina admin">
					<AnimatedSidebarHeader>
						<AnimatedSidebarGroup>
							<AnimatedSidebarGroupLabel>{m.app_title()}</AnimatedSidebarGroupLabel>
							<AnimatedSidebarGroupContent>
								<AnimatedSidebarMenu>
									{views.map((view) => (
										<AnimatedSidebarMenuItem key={view.to}>
											<AnimatedSidebarMenuButton
												href={view.to}
												isActive={pathname === view.to}
												onSelect={() => {}}
											>
												{view.label()}
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
