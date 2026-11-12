"use client";

import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/motion/card";
import { CardContent } from "@/components/motion/card";
import { api } from "@/lib/api";
import { m } from "@/paraglide/messages";
import { SystemPage } from "./page-header";

export function PluginPage() {
	const pluginsQuery = useQuery({
		queryFn: api.plugins.list,
		queryKey: ["admin", "plugins"],
	});

	if (pluginsQuery.isPending) {
		return (
			<SystemPage description={m.plugins_page_description()} title={m.nav_plugins()}>
				<Card className="p-4">{m.loading()}</Card>
			</SystemPage>
		);
	}

	if (pluginsQuery.isError) {
		return (
			<SystemPage description={m.plugins_page_description()} title={m.nav_plugins()}>
				<Card className="p-4">{pluginsQuery.error.message}</Card>
			</SystemPage>
		);
	}

	const plugins = pluginsQuery.data ?? [];

	if (plugins.length === 0) {
		return (
			<SystemPage description={m.plugins_page_description()} title={m.nav_plugins()}>
				<Card className="p-4">{m.plugins_empty()}</Card>
			</SystemPage>
		);
	}

	return (
		<SystemPage description={m.plugins_page_description()} title={m.nav_plugins()}>
			<div className="space-y-3">
				{plugins.map((plugin) => (
					<Card key={plugin.id} size="compact">
						<CardContent className="space-y-2 text-sm">
							<span className="font-medium">{plugin.name}</span>
							<div className="grid gap-1 text-muted-foreground">
								<span>
									{m.plugins_kind()} {plugin.kind}
								</span>
								<span>
									{m.plugins_run_mode()} {plugin.runMode}
								</span>
								<span>
									{m.plugins_enabled()} {plugin.enabled === 1 ? "true" : "false"}
								</span>
							</div>
						</CardContent>
					</Card>
				))}
			</div>
		</SystemPage>
	);
}
