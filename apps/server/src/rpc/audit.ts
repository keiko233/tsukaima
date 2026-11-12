import { randomUUID } from "node:crypto";
import { auditLog } from "@tsukaima/db";
import type { TsukaimaLifecycle } from "../lifecycle.ts";

export interface AdminAuditInput {
	readonly action: string;
	readonly actorId: string;
	readonly payload?: unknown;
	readonly result?: "denied" | "failed" | "ok";
}

/**
 * Supplementary audit rows written by the RPC layer with the real `admin:<username>` actor.
 *
 * `lifecycle.writeAudit` hardcodes its actor and lives outside this change's write set, so admin
 * sign-in/sign-out and state-changing admin RPC calls additionally record here. The proper fix is
 * an optional `actorId` on the SDK's `AuditEntry` threaded through `lifecycle.writeAudit`; until
 * that lands, these rows keep admin actions attributable.
 *
 * Auditing must never break the request path: failures are logged and swallowed.
 */
export async function recordAdminAudit(
	lifecycle: TsukaimaLifecycle,
	entry: AdminAuditInput,
): Promise<void> {
	const database = lifecycle.domainDatabase;
	if (database === undefined) return;
	try {
		await database.insert(auditLog).values({
			action: entry.action,
			actorId: entry.actorId,
			actorKind: "user",
			id: randomUUID(),
			occurredAt: new Date().toISOString(),
			...(entry.payload === undefined ? {} : { payloadJson: JSON.stringify(entry.payload) }),
			result: entry.result ?? "ok",
			targetKind: "admin",
		});
	} catch (error) {
		lifecycle.logger.child("tsukaima::server::rpc").warn("admin audit write failed", {
			action: entry.action,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
