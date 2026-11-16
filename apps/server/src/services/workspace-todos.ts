import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { WorkspaceTodo, WorkspaceTodoStatus } from "@tsukaima/contracts";
import { workspaceTodos, type TsukaimaDatabase } from "@tsukaima/db";

const MAX_TODOS = 50;

function toTodo(row: typeof workspaceTodos.$inferSelect): WorkspaceTodo {
	return {
		content: row.content,
		createdAt: new Date(row.createdAtMs).toISOString(),
		id: row.id,
		sortOrder: row.sortOrder,
		status: row.status,
		updatedAt: new Date(row.updatedAtMs).toISOString(),
	};
}

/**
 * Workspace-local checklist storage. `replace` is deliberately whole-list: a coding agent that
 * keeps its plan in a partial patch protocol tends to lose items on retries.
 */
export class WorkspaceTodoService {
	readonly #database: () => TsukaimaDatabase | undefined;

	constructor(options: { readonly database: () => TsukaimaDatabase | undefined }) {
		this.#database = options.database;
	}

	#db(): TsukaimaDatabase {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}

	async list(sessionId: string): Promise<WorkspaceTodo[]> {
		const rows = await this.#db()
			.select()
			.from(workspaceTodos)
			.where(eq(workspaceTodos.workspaceSessionId, sessionId))
			.orderBy(asc(workspaceTodos.sortOrder));
		return rows.map(toTodo);
	}

	async replace(
		sessionId: string,
		items: readonly { readonly content: string; readonly status?: WorkspaceTodoStatus }[],
	): Promise<WorkspaceTodo[]> {
		if (items.length > MAX_TODOS) throw new Error(`At most ${MAX_TODOS} todos are allowed`);
		const normalized = items.map((item, index) => ({
			content: item.content.trim(),
			sortOrder: index,
			status: item.status ?? (index === 0 ? "in_progress" : "pending"),
		}));
		if (normalized.some((item) => item.content.length === 0)) {
			throw new Error("Todo content is required");
		}
		if (normalized.filter((item) => item.status === "in_progress").length > 1) {
			throw new Error("At most one todo can be in progress");
		}
		const database = this.#db();
		const nowMs = Date.now();
		const rows = normalized.map((item) => ({
			content: item.content,
			createdAtMs: nowMs,
			id: randomUUID(),
			sortOrder: item.sortOrder,
			status: item.status,
			updatedAtMs: nowMs,
			workspaceSessionId: sessionId,
		}));
		database.transaction((tx) => {
			tx.delete(workspaceTodos).where(eq(workspaceTodos.workspaceSessionId, sessionId)).run();
			for (const row of rows) tx.insert(workspaceTodos).values(row).run();
		});
		return rows.map((row) => toTodo(row));
	}
}
