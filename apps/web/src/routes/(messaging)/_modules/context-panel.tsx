"use client";

import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/api";
import { ContextPanelContent } from "./context-panel-view";

export function ContextPanel({
	embedded = false,
	enabled,
	onClose,
	sessionId,
}: {
	embedded?: boolean;
	enabled: boolean;
	onClose?: () => void;
	sessionId: string;
}) {
	const query = useQuery({
		...orpc.admin.sessions.contextStats.queryOptions({ input: { sessionId } }),
		enabled,
	});

	return (
		<ContextPanelContent
			embedded={embedded}
			errorMessage={query.error?.message}
			isError={query.isError}
			isFetching={query.isFetching}
			isPending={query.isPending}
			onClose={onClose}
			onRefresh={() => void query.refetch()}
			onRetry={() => void query.refetch()}
			stats={query.data}
		/>
	);
}
