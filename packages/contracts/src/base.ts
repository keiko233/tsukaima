import { z } from "zod";

/**
 * Leaf schemas shared by the domain model and the oRPC contract. They live in their own
 * module so `api.ts` can build the contract without importing `index.ts` back
 * (which would create a module evaluation cycle).
 */

export const messagePartSchema = z.discriminatedUnion("type", [
	z.object({ text: z.string(), type: z.literal("text") }),
	z.object({ sha256: z.string().min(1), type: z.literal("image") }),
	z.object({ sha256: z.string().min(1), type: z.literal("sticker") }),
]);

export type MessagePart = z.infer<typeof messagePartSchema>;

export const healthStateSchema = z.enum(["starting", "degraded", "ready", "maintenance", "failed"]);

export const healthResponseSchema = z.object({
	stage: z.string(),
	state: healthStateSchema,
	uptimeMs: z.number().int().nonnegative(),
	version: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
