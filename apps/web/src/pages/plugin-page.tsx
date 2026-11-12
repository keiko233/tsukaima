"use client";

import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/motion/card";
import { CardContent } from "@/components/motion/card";
import { api } from "@/lib/api";
import { m } from "@/paraglide/messages";

export function PluginPage() {
	const pluginsQuery = useQuery({
		queryFn: api.plugins.list,
		queryKey: ["admin", "plugins"],
	});

	if (pluginsQuery.isPending) {
		return <Card className="p-4">{m.plugins_empty()}</Card>;
	}

	if (pluginsQuery.isError) {
		return <Card className="p-4">{pluginsQuery.error.message}</Card>;
	}

	const plugins = pluginsQuery.data ?? [];

	if (plugins.length === 0) {
		return <Card className="p-4">{m.plugins_empty()}</Card>;
	}

	return (
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
	);
}
