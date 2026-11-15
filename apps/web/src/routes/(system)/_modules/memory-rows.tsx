import { Pin } from "lucide-react";
import type { MemoryRow } from "@elaina/contracts";

/** Pure row renderer shared by the memories page and its WebUI smoke test. */
export function MemoryRows({
	emptyLabel = "No memories match these filters.",
	memories,
}: {
	readonly emptyLabel?: string;
	readonly memories: readonly MemoryRow[];
}) {
	if (memories.length === 0) {
		return <p className="px-1 py-4 text-[11px] text-muted-foreground">{emptyLabel}</p>;
	}
	return (
		<ul className="space-y-2">
			{memories.map((memory) => (
				<li
					key={memory.id}
					data-memory-id={memory.id}
					className="rounded-xl border border-border bg-card/40 px-3 py-3 text-sm"
				>
					<div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
						<span className="rounded-full border border-border px-2 py-0.5">
							{memory.scope}/{memory.kind}
						</span>
						<span className="rounded-full border border-border px-2 py-0.5">
							{memory.status}
						</span>
						{memory.pinned ? <Pin className="size-3" aria-label="Pinned" /> : null}
						<span>{memory.confidence.toFixed(2)}</span>
						<span className="ml-auto">{memory.updatedAt}</span>
					</div>
					<p className="mt-2 break-words">{memory.summary}</p>
					{memory.content !== memory.summary ? (
						<p className="mt-1 break-words text-xs text-muted-foreground">{memory.content}</p>
					) : null}
				</li>
			))}
		</ul>
	);
}
