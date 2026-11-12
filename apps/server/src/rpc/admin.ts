import { os } from "@orpc/server";
import { z } from "zod";
import { conversations, modelPolicies, plugins } from "@elaina/db";
import type { ElainaApiContext } from "./health.ts";

export const adminRouter = {
	conversations: {
		list: os.$context<ElainaApiContext>().handler(async ({ context }) => {
			const database = context.lifecycle.domainDatabase;
			return database?.select().from(conversations) ?? [];
		}),
	},
	diagnostics: {
		status: os.$context<ElainaApiContext>().handler(async ({ context }) => {
			const lifecycle = context.lifecycle;
			return {
				...(lifecycle.lastProcessingError === undefined
					? {}
					: { lastError: lifecycle.lastProcessingError.message }),
				onebotConnected: lifecycle.onebotChannel !== undefined,
				processedMessages: lifecycle.processedMessageCount,
				routingPolicies: lifecycle.routingPolicies,
				state: lifecycle.state,
			};
		}),
	},
	modelPolicies: {
		list: os.$context<ElainaApiContext>().handler(async ({ context }) => {
			const database = context.lifecycle.domainDatabase;
			return database?.select().from(modelPolicies) ?? [];
		}),
		set: os
			.$context<ElainaApiContext>()
			.input(
				z.object({
					capability: z.string().min(1),
					maxOutputTokens: z.number().int().positive().optional(),
					primaryModel: z.string().min(1),
					primaryProvider: z.string().min(1),
				}),
			)
			.handler(async ({ context, input }) => {
				const database = context.lifecycle.domainDatabase;
				if (database === undefined) throw new Error("Database not ready");
				await database
					.insert(modelPolicies)
					.values({
						capability: input.capability,
						fallbacksJson: "[]",
						id: input.capability,
						primaryModel: input.primaryModel,
						primaryProvider: input.primaryProvider,
					})
					.onConflictDoUpdate({
						target: modelPolicies.capability,
						set: {
							primaryModel: input.primaryModel,
							primaryProvider: input.primaryProvider,
						},
					});
				context.lifecycle.routingPolicies = [
					...context.lifecycle.routingPolicies.filter(
						(policy) => policy.capability !== input.capability,
					),
					{
						capability: input.capability,
						primary: {
							modelId: input.primaryModel,
							providerId: input.primaryProvider,
						},
					},
				];
				return context.lifecycle.routingPolicies;
			}),
	},
	plugins: {
		list: os.$context<ElainaApiContext>().handler(async ({ context }) => {
			const database = context.lifecycle.domainDatabase;
			return database?.select().from(plugins) ?? [];
		}),
	},
};
