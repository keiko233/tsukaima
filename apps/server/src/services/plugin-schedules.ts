import type { PluginSchedulesApi, PluginScheduleSummary } from "@tsukaima/sdk";
import type { ScheduleService } from "./schedule-service.ts";

/**
 * Plugin-scoped view of host schedules. A plugin can only address conversations it can already
 * read, and every schedule it creates is tagged with its plugin id. The host owns recurrence,
 * occurrence claims, and execution.
 */
function toSummary(schedule: {
	readonly actionKind: PluginScheduleSummary["actionKind"];
	readonly id: string;
	readonly nextRunAt: string | null;
	readonly ownerKind: PluginScheduleSummary["ownerKind"];
	readonly status: PluginScheduleSummary["status"];
	readonly targetSessionId: string;
	readonly title: string;
}): PluginScheduleSummary {
	return {
		actionKind: schedule.actionKind,
		id: schedule.id,
		nextRunAt: schedule.nextRunAt,
		ownerKind: schedule.ownerKind,
		status: schedule.status,
		targetSessionId: schedule.targetSessionId,
		title: schedule.title,
	};
}

export function createPluginSchedulesApi(
	schedules: ScheduleService,
	pluginId: string,
	canReadConversation: (conversationId: string) => Promise<boolean>,
): PluginSchedulesApi {
	const listeners = new Set<(schedule: PluginScheduleSummary) => void>();
	schedules.onChanged((schedule) => {
		if (schedule.ownerKind !== "plugin" || schedule.ownerId !== pluginId) return;
		const summary = toSummary(schedule);
		for (const listener of listeners) {
			try {
				listener(summary);
			} catch {}
		}
	});
	return {
		cancel: async (scheduleId) => {
			const detail = await schedules.get(scheduleId);
			if (detail === null || detail.ownerKind !== "plugin" || detail.ownerId !== pluginId) {
				return false;
			}
			await schedules.cancel(scheduleId);
			return true;
		},
		create: async (input) => {
			if (!(await canReadConversation(input.targetSessionId))) {
				throw new Error("Plugin cannot read the target conversation");
			}
			const detail = await schedules.create({
				actionKind: input.actionKind,
				...(input.catchUp === undefined ? {} : { catchUp: input.catchUp }),
				...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
				...(input.graceMs === undefined ? {} : { graceMs: input.graceMs }),
				...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
				...(input.maxRuns === undefined ? {} : { maxRuns: input.maxRuns }),
				ownerId: pluginId,
				ownerKind: "plugin",
				ownerPluginId: pluginId,
				prompt: input.prompt,
				recurrence: input.recurrence,
				...(input.respectQuietHours === undefined
					? {}
					: { respectQuietHours: input.respectQuietHours }),
				source: `plugin:${pluginId}`,
				targetSessionId: input.targetSessionId,
				timeZone: input.timeZone,
				title: input.title,
			});
			return toSummary(detail);
		},
		list: async (query = {}) => {
			const rows = await schedules.list({
				limit: query.limit,
				...(query.targetSessionId === undefined ? {} : { sessionId: query.targetSessionId }),
			});
			return rows
				.filter((row) => row.ownerKind === "plugin")
				.filter((row) => row.source === `plugin:${pluginId}`)
				.map(toSummary);
		},
		onChanged: (handler) => {
			listeners.add(handler);
			return () => {
				listeners.delete(handler);
			};
		},
	};
}
