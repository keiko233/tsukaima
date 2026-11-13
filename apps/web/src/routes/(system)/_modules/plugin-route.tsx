"use client";

import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Skeleton } from "@elaina/sdk/ui";
import { orpc } from "@/lib/api";
import { m } from "@/paraglide/messages";
import { PluginDetail } from "./plugin-detail";

export function PluginRoute() {
	const { pluginId } = useParams({ from: "/(system)/plugins/$pluginId" });
	const pluginsQuery = useQuery(orpc.admin.plugins.list.queryOptions());
	const plugin = pluginsQuery.data?.find((candidate) => candidate.id === pluginId);

	if (pluginsQuery.isPending) {
		return <Skeleton className="h-56 w-full" />;
	}
	if (pluginsQuery.isError) {
		return <p className="text-sm text-destructive">{pluginsQuery.error.message}</p>;
	}
	if (plugin === undefined) {
		return (
			<div className="grid min-h-64 place-items-center rounded-xl border border-dashed border-border text-center">
				<div className="space-y-2 p-6">
					<p className="text-sm font-medium">{m.plugins_unknown()}</p>
					<p className="text-xs text-muted-foreground">{m.plugins_unknown_description()}</p>
					<Link className="text-xs text-primary underline-offset-4 hover:underline" to="/plugins">
						{m.plugins_back_to_list()}
					</Link>
				</div>
			</div>
		);
	}
	return <PluginDetail plugin={plugin} />;
}
