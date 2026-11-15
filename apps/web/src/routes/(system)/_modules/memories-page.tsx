"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pin, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { MemoryRow, MemoryScope, MemoryStatus } from "@tsukaima/contracts";
import { Button } from "@tsukaima/ui/components/motion/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@tsukaima/ui/components/motion/card";
import { Input } from "@tsukaima/ui/components/motion/input";
import { orpc } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { m } from "@/paraglide/messages";
import { Modal, ModalActions } from "../../_modules/ui/modal";
import { MemoryRows } from "./memory-rows";
import { SystemPage } from "./page-header";

const SCOPES: readonly MemoryScope[] = [
	"global",
	"persona",
	"user",
	"conversation",
	"project",
	"ephemeral",
];
const KINDS = [
	"fact",
	"summary",
	"setting",
	"person",
	"preference",
	"style",
	"glossary",
	"todo",
	"event",
	"relationship",
	"observation",
] as const;
const STATUSES: readonly MemoryStatus[] = ["active", "pending", "rejected", "expired", "revoked"];

const fieldClass =
	"h-8 w-full rounded-md border border-border bg-background px-2 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";
const textareaClass =
	"min-h-16 w-full rounded-md border border-border bg-background px-2 py-1.5 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

function StatusFilter({
	value,
	onChange,
}: {
	value: MemoryStatus | "";
	onChange: (value: MemoryStatus | "") => void;
}) {
	return (
		<select
			aria-label={m.memories_filter_status()}
			className={fieldClass}
			value={value}
			onChange={(event) => onChange(event.target.value as MemoryStatus | "")}
		>
			<option value="">{m.memories_filter_all_statuses()}</option>
			{STATUSES.map((status) => (
				<option key={status} value={status}>
					{m.memories_status({ status })}
				</option>
			))}
		</select>
	);
}

export function MemoriesPage() {
	const toast = useToast();
	const queryClient = useQueryClient();
	const [scope, setScope] = useState<MemoryScope | "">("");
	const [kind, setKind] = useState("");
	const [status, setStatus] = useState<MemoryStatus | "">("");
	const [search, setSearch] = useState("");
	const [compactConversationId, setCompactConversationId] = useState("");
	const [editing, setEditing] = useState<MemoryRow | undefined>();
	const [summary, setSummary] = useState("");
	const [content, setContent] = useState("");
	const [importance, setImportance] = useState(0.5);
	const [expiresAt, setExpiresAt] = useState("");

	const filters = useMemo(
		() => ({
			...(scope === "" ? {} : { scope }),
			...(kind === "" ? {} : { kind }),
			...(status === "" ? {} : { status }),
			...(search.trim() === "" ? {} : { query: search.trim() }),
			limit: 200,
		}),
		[kind, scope, search, status],
	);
	const memories = useQuery(orpc.admin.memory.list.queryOptions({ input: filters }));

	const invalidate = async () => {
		await queryClient.invalidateQueries({ queryKey: orpc.admin.memory.key() });
	};
	const action = useMutation(
		orpc.admin.memory.approve.mutationOptions({
			onError: (error) =>
				toast.error(m.memories_action_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.memories_approved());
				await invalidate();
			},
		}),
	);
	const reject = useMutation(
		orpc.admin.memory.reject.mutationOptions({
			onError: (error) =>
				toast.error(m.memories_action_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.memories_rejected());
				await invalidate();
			},
		}),
	);
	const revoke = useMutation(
		orpc.admin.memory.revoke.mutationOptions({
			onError: (error) =>
				toast.error(m.memories_action_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.memories_revoked());
				await invalidate();
			},
		}),
	);
	const pin = useMutation(
		orpc.admin.memory.pin.mutationOptions({
			onError: (error) =>
				toast.error(m.memories_action_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.memories_pin_updated());
				await invalidate();
			},
		}),
	);
	const update = useMutation(
		orpc.admin.memory.update.mutationOptions({
			onError: (error) =>
				toast.error(m.memories_action_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.memories_updated());
				setEditing(undefined);
				await invalidate();
			},
		}),
	);
	const expire = useMutation(
		orpc.admin.memory.expire.mutationOptions({
			onError: (error) =>
				toast.error(m.memories_action_failed(), { description: errorMessage(error) }),
			onSuccess: async ({ expired }) => {
				toast.success(m.memories_expired({ count: expired }));
				await invalidate();
			},
		}),
	);
	const compact = useMutation(
		orpc.admin.memory.compact.mutationOptions({
			onError: (error) =>
				toast.error(m.memories_action_failed(), { description: errorMessage(error) }),
			onSuccess: async (result) => {
				toast.success(
					result.created ? m.memories_compacted() : m.memories_nothing_to_compact(),
				);
				await invalidate();
			},
		}),
	);

	const openEdit = (memory: MemoryRow) => {
		setEditing(memory);
		setSummary(memory.summary);
		setContent(memory.content);
		setImportance(memory.importance);
		setExpiresAt(memory.expiresAt ?? "");
	};
	const saveEdit = () => {
		if (editing === undefined) return;
		update.mutate({
			content,
			expiresAt: expiresAt.trim() === "" ? null : expiresAt,
			id: editing.id,
			importance,
			summary,
		});
	};

	return (
		<SystemPage description={m.memories_description()} title={m.nav_memories()}>
			<Card size="compact">
				<CardHeader>
					<CardTitle as="h2">{m.memories_list_title()}</CardTitle>
					<CardDescription>{m.memories_list_description()}</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3">
					<div className="grid gap-2 lg:grid-cols-4">
						<Input
							aria-label={m.memories_search_placeholder()}
							placeholder={m.memories_search_placeholder()}
							value={search}
							onChange={setSearch}
							leftIcon={<Search />}
						/>
						<select
							aria-label={m.memories_filter_scope()}
							className={fieldClass}
							value={scope}
							onChange={(event) => setScope(event.target.value as MemoryScope | "")}
						>
							<option value="">{m.memories_filter_all_scopes()}</option>
							{SCOPES.map((value) => (
								<option key={value} value={value}>
									{m.memories_scope({ scope: value })}
								</option>
							))}
						</select>
						<select
							aria-label={m.memories_filter_kind()}
							className={fieldClass}
							value={kind}
							onChange={(event) => setKind(event.target.value)}
						>
							<option value="">{m.memories_filter_all_kinds()}</option>
							{KINDS.map((value) => (
								<option key={value} value={value}>
									{m.memories_kind({ kind: value })}
								</option>
							))}
						</select>
						<StatusFilter value={status} onChange={setStatus} />
					</div>
					<div className="flex flex-wrap items-end gap-2">
						<Button
							variant="outline"
							size="sm"
							disabled={expire.isPending}
							onClick={() => expire.mutate(undefined)}
						>
							<RefreshCw className="size-3.5" />
							{m.memories_run_expiry()}
						</Button>
						<div className="flex flex-1 flex-wrap items-center gap-2">
							<Input
								aria-label={m.memories_compact_conversation()}
								placeholder={m.memories_compact_conversation()}
								value={compactConversationId}
								onChange={setCompactConversationId}
								classNames={{ field: "h-8 min-w-52", root: "max-w-sm gap-0" }}
							/>
							<Button
								variant="outline"
								size="sm"
								disabled={compact.isPending || compactConversationId.trim() === ""}
								onClick={() =>
									compact.mutate({ conversationId: compactConversationId.trim() })
								}
							>
								{m.memories_compact()}
							</Button>
						</div>
					</div>
					{memories.isPending ? (
						<p className="text-sm text-muted-foreground">{m.loading()}</p>
					) : memories.isError ? (
						<p className="text-sm text-destructive">{errorMessage(memories.error)}</p>
					) : (
						<>
							<MemoryRows emptyLabel={m.memories_empty()} memories={memories.data} />
							<div className="flex flex-wrap gap-2">
								{memories.data?.map((memory) => (
									<div
										key={`actions-${memory.id}`}
										className="flex items-center gap-1 rounded-lg border border-border px-2 py-1"
									>
										<span className="max-w-40 truncate text-xs text-muted-foreground">
											{memory.summary}
										</span>
										{memory.status === "pending" ? (
											<>
												<Button
													size="sm"
													variant="ghost"
													onClick={() => action.mutate({ id: memory.id })}
												>
													<Check className="size-3.5" />
													{m.memories_approve()}
												</Button>
												<Button
													size="sm"
													variant="ghost"
													onClick={() => reject.mutate({ id: memory.id })}
												>
													<X className="size-3.5" />
													{m.memories_reject()}
												</Button>
											</>
										) : null}
										<Button size="sm" variant="ghost" onClick={() => openEdit(memory)}>
											{m.memories_edit()}
										</Button>
										<Button
											size="sm"
											variant="ghost"
											onClick={() => pin.mutate({ id: memory.id, pinned: !memory.pinned })}
										>
											<Pin className="size-3.5" />
											{memory.pinned ? m.memories_unpin() : m.memories_pin()}
										</Button>
										<Button
											size="sm"
											variant="ghost"
											disabled={memory.status === "revoked"}
											onClick={() => revoke.mutate({ id: memory.id })}
										>
											<Trash2 className="size-3.5" />
											{m.memories_revoke()}
										</Button>
									</div>
								))}
							</div>
						</>
					)}
				</CardContent>
			</Card>
			<Modal
				open={editing !== undefined}
				onOpenChange={(open) => {
					if (!open) setEditing(undefined);
				}}
				title={m.memories_edit_title()}
				description={m.memories_edit_description()}
				className="max-w-xl"
			>
				<div className="space-y-3">
					<label className="flex flex-col gap-1.5 text-xs font-medium">
						<span>{m.memories_field_summary()}</span>
						<textarea
							className={textareaClass}
							value={summary}
							onChange={(event) => setSummary(event.target.value)}
						/>
					</label>
					<label className="flex flex-col gap-1.5 text-xs font-medium">
						<span>{m.memories_field_content()}</span>
						<textarea
							className={textareaClass}
							value={content}
							onChange={(event) => setContent(event.target.value)}
						/>
					</label>
					<div className="grid gap-3 sm:grid-cols-2">
						<label className="flex flex-col gap-1.5 text-xs font-medium">
							<span>{m.memories_field_importance()}</span>
							<input
								type="number"
								min={0}
								max={1}
								step={0.05}
								className={fieldClass}
								value={importance}
								onChange={(event) => setImportance(Number(event.target.value))}
							/>
						</label>
						<label className="flex flex-col gap-1.5 text-xs font-medium">
							<span>{m.memories_field_expires()}</span>
							<input
								type="datetime-local"
								className={fieldClass}
								value={expiresAt === "" ? "" : expiresAt.slice(0, 16)}
								onChange={(event) =>
									setExpiresAt(
										event.target.value === ""
											? ""
											: new Date(event.target.value).toISOString(),
									)
								}
							/>
						</label>
					</div>
					<ModalActions>
						<Button variant="ghost" onClick={() => setEditing(undefined)}>
							{m.cancel()}
						</Button>
						<Button disabled={update.isPending} onClick={saveEdit}>
							{m.save()}
						</Button>
					</ModalActions>
				</div>
			</Modal>
		</SystemPage>
	);
}
