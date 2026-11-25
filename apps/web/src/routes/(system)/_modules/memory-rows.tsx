import { Pin } from "lucide-react";
import type { MemoryRow } from "@tsukaima/contracts";

/** Pure row renderer shared by the memories page and its WebUI smoke test. */
export function MemoryRows({
	emptyLabel = "No memories match these filters.",
	memories,
}: {
	readonly emptyLabel?: string;
	readonly memories: readonly MemoryRow[];
}) {
	if (memories.length === 0) {
		return (
			<p className="border-t border-border py-4 text-[11px] text-muted-foreground">{emptyLabel}</p>
		);
	}
	return (
		<ul>
			{memories.map((memory) => (
				<li
					key={memory.id}
					data-memory-id={memory.id}
					className="border-t border-border py-3 last:border-b"
				>
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-muted-foreground">
						<span className="tracking-wide uppercase">
							{memory.scope}/{memory.kind}
						</span>
						<span aria-hidden="true">·</span>
						<span>{memory.status}</span>
						{memory.pinned ? <Pin className="size-3 text-accent-ink" aria-label="Pinned" /> : null}
						<span className="tabular-nums">{memory.confidence.toFixed(2)}</span>
						<span className="min-w-0 truncate text-faint">{memory.id}</span>
						<span className="ms-auto tabular-nums text-faint">{memory.updatedAt}</span>
					</div>
					<p className="mt-1.5 break-words text-sm text-ink">{memory.summary}</p>
					{memory.content !== memory.summary ? (
						<p className="mt-1 break-words text-xs text-muted-foreground">{memory.content}</p>
					) : null}
				</li>
			))}
		</ul>
	);
}
