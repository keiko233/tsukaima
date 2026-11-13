"use client";

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Brain, Search } from "lucide-react";
import { useState } from "react";
import { Button } from "@elaina/ui/components/motion/button";
import { Input } from "@elaina/ui/components/motion/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@elaina/ui/components/motion/tabs";
import { orpc } from "@/lib/api";
import { cn } from "@elaina/ui/lib/utils";
import { m } from "@/paraglide/messages";
import { ChatTree } from "./chat-tree";
import { GroupsSidebar } from "./groups-sidebar";
import { RequestsSidebar } from "./requests-sidebar";
import { UsersSidebar } from "./users-sidebar";

type Tab = "chats" | "users" | "groups" | "requests";
type ChatFilter = "active" | "archived" | "all";

const TAB_KEY = "elaina.webui.sidebar-tab";

function initialTab(): Tab {
	const stored = localStorage.getItem(TAB_KEY);
	return stored === "users" || stored === "groups" || stored === "requests" ? stored : "chats";
}

export function AppSidebar({ onNavigate }: { onNavigate: () => void }) {
	const [tab, setTab] = useState<Tab>(() => initialTab());
	const [search, setSearch] = useState<Record<Tab, string>>({
		chats: "",
		groups: "",
		requests: "",
		users: "",
	});
	const [chatFilter, setChatFilter] = useState<ChatFilter>("active");
	const navigate = useNavigate();
	const pendingRequests = useQuery(
		orpc.admin.requests.list.queryOptions({
			input: { status: "pending" },
		}),
	);
	const pendingCount = pendingRequests.data?.length ?? 0;

	const placeholders: Record<Tab, string> = {
		chats: m.search_chats(),
		groups: m.search_groups(),
		requests: m.search_requests(),
		users: m.search_users(),
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<Tabs
				variant="underline"
				value={tab}
				onValueChange={(value) => {
					const next = value as Tab;
					setTab(next);
					localStorage.setItem(TAB_KEY, next);
				}}
				className="flex min-h-0 flex-1 flex-col"
			>
				<div className="shrink-0 px-2 pt-1">
					<TabsList className="w-full justify-between gap-0">
						<TabsTrigger
							value="chats"
							indicatorClassName="h-0.5"
							className="flex-1 justify-center px-1 text-[13px]"
						>
							{m.tab_chats()}
						</TabsTrigger>
						<TabsTrigger
							value="users"
							indicatorClassName="h-0.5"
							className="flex-1 justify-center px-1 text-[13px]"
						>
							{m.tab_users()}
						</TabsTrigger>
						<TabsTrigger
							value="groups"
							indicatorClassName="h-0.5"
							className="flex-1 justify-center px-1 text-[13px]"
						>
							{m.tab_groups()}
						</TabsTrigger>
						<TabsTrigger
							value="requests"
							indicatorClassName="h-0.5"
							className="flex-1 justify-center px-1 text-[13px]"
						>
							<span className="inline-flex items-center gap-1">
								{m.tab_requests()}
								{pendingCount > 0 ? (
									<span className="grid min-w-4 place-items-center rounded-full bg-primary px-1 py-0.5 text-[9px] leading-none text-primary-foreground">
										{pendingCount > 99 ? "99+" : pendingCount}
									</span>
								) : null}
							</span>
						</TabsTrigger>
					</TabsList>
				</div>

				<div className="shrink-0 space-y-2 px-3 py-2.5">
					<Input
						aria-label={placeholders[tab]}
						placeholder={placeholders[tab]}
						value={search[tab]}
						onChange={(value) => setSearch((current) => ({ ...current, [tab]: value }))}
						leftIcon={<Search />}
						classNames={{ field: "h-9 bg-card/60", root: "gap-0" }}
					/>
					{tab === "chats" ? (
						<div className="flex items-center gap-1">
							{(["active", "archived", "all"] as const).map((value) => (
								<Button
									key={value}
									variant={chatFilter === value ? "secondary" : "ghost"}
									size="sm"
									onClick={() => setChatFilter(value)}
									className={cn(
										"h-6 rounded-full px-2 text-[10px]",
										chatFilter === value && "border-border-strong",
									)}
								>
									{value === "active"
										? m.active()
										: value === "archived"
											? m.filter_archived()
											: m.filter_all()}
								</Button>
							))}
						</div>
					) : null}
				</div>

				<TabsContent value="chats" className="mt-0 flex min-h-0 flex-1 flex-col">
					<ChatTree filter={chatFilter} onNavigate={onNavigate} search={search.chats} />
				</TabsContent>
				<TabsContent value="users" className="mt-0 flex min-h-0 flex-1 flex-col">
					<UsersSidebar onNavigate={onNavigate} search={search.users} />
				</TabsContent>
				<TabsContent value="groups" className="mt-0 flex min-h-0 flex-1 flex-col">
					<GroupsSidebar onNavigate={onNavigate} search={search.groups} />
				</TabsContent>
				<TabsContent value="requests" className="mt-0 flex min-h-0 flex-1 flex-col">
					<RequestsSidebar search={search.requests} />
				</TabsContent>
			</Tabs>
			<div className="shrink-0 border-t border-border p-2">
				<Button
					variant="ghost"
					size="sm"
					fullWidth
					leadingIcon={<Brain />}
					className="h-auto justify-start rounded-lg px-2.5 py-2 text-xs"
					onClick={() => void navigate({ to: "/memories" })}
				>
					{m.nav_memories()}
				</Button>
			</div>
		</div>
	);
}
