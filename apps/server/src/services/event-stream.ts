import { z } from "zod";
import { liveEventSchema, type LiveEvent } from "@tsukaima/contracts";
import type { TsukaimaLifecycle } from "../lifecycle.ts";
import { encodeSseEvent, type LogBuffer, type Logger } from "../logging.ts";
import type { AuthService } from "./auth.ts";
import type { HookBus } from "./hook-bus.ts";

export const DEFAULT_EVENT_HEARTBEAT_MS = 15_000;

/** Bound queued frames so a browser that stops reading cannot grow server memory without limit. */
const MAX_QUEUED_FRAMES = 128;

export interface EventStreamOptions {
	readonly heartbeatMs?: number;
	readonly logger?: Logger;
}

const messageReceivedHookSchema = z.object({
	channelId: z.string().min(1),
	chatObjectId: z.string().min(1),
	envelope: z.object({ id: z.string().min(1) }),
	sessionId: z.string().min(1),
});

const activityHookSchema = z.object({
	activityId: z.string().min(1),
	conversationId: z.string().min(1),
	envelopeCount: z.number().int().nonnegative(),
});

const replyHookSchema = z.object({
	channelId: z.string().min(1).nullable(),
	chatObjectId: z.string().min(1),
	entryId: z.string().min(1),
	sessionId: z.string().min(1),
	text: z.string(),
});

const afterReplyHookSchema = replyHookSchema.extend({
	deliveryStatus: z.enum(["sent", "failed", "uncertain", "pending", "received", "accepted"]),
});

function heartbeatInterval(options: EventStreamOptions | undefined): number {
	if (options?.heartbeatMs === undefined) return DEFAULT_EVENT_HEARTBEAT_MS;
	return Math.max(10, Math.floor(options.heartbeatMs));
}

function timestamp(): string {
	return new Date().toISOString();
}

function unauthorized(): Response {
	return new Response(
		JSON.stringify({ code: "UNAUTHENTICATED", message: "Admin sign-in required" }),
		{
			headers: {
				"cache-control": "no-store",
				"content-type": "application/json; charset=utf-8",
			},
			status: 401,
		},
	);
}

/**
 * EventSource cannot attach an Authorization header, so browser sessions authenticate through
 * the same HttpOnly cookie as oRPC. A stream is never opened for an anonymous caller.
 */
export async function eventAuthResponse(
	auth: AuthService,
	request: Request,
): Promise<Response | undefined> {
	try {
		const session = await auth.getSession(request.headers);
		if (session !== undefined) return undefined;
	} catch {
		// Authentication failures fail closed.
	}
	return unauthorized();
}

function createSseResponse(
	request: Request,
	setup: (send: (event: string, data: unknown) => void) => () => void,
): Response {
	const encoder = new TextEncoder();
	let cleanup: (() => void) | undefined;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			let dispose: (() => void) | undefined;
			const close = () => {
				if (closed) return;
				closed = true;
				dispose?.();
				request.signal.removeEventListener("abort", close);
				try {
					controller.close();
				} catch {}
			};
			const send = (event: string, data: unknown) => {
				if (closed) return;
				const desiredSize = controller.desiredSize;
				if (desiredSize !== null && desiredSize < -MAX_QUEUED_FRAMES) {
					close();
					return;
				}
				try {
					controller.enqueue(encoder.encode(encodeSseEvent(event, data)));
				} catch {
					close();
				}
			};
			const currentDispose = setup(send);
			if (closed) currentDispose();
			else dispose = currentDispose;
			cleanup = close;
			if (request.signal.aborted) {
				close();
				return;
			}
			request.signal.addEventListener("abort", close, { once: true });
		},
		cancel() {
			cleanup?.();
		},
	});
	return new Response(body, {
		headers: {
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"content-type": "text/event-stream; charset=utf-8",
			"x-accel-buffering": "no",
		},
	});
}

export function createLogEventStream(
	logs: LogBuffer,
	request: Request,
	options?: EventStreamOptions,
): Response {
	const intervalMs = heartbeatInterval(options);
	return createSseResponse(request, (send) => {
		const unsubscribe = logs.subscribe((entry) => send("log", entry));
		const heartbeat = setInterval(() => send("heartbeat", {}), intervalMs);
		heartbeat.unref?.();
		send("snapshot", logs.snapshot());
		return () => {
			unsubscribe();
			clearInterval(heartbeat);
		};
	});
}

function publish(
	send: (event: string, data: unknown) => void,
	logger: Logger | undefined,
	event: LiveEvent,
): void {
	const parsed = liveEventSchema.safeParse(event);
	if (!parsed.success) {
		logger?.warn("dropped invalid live event", { type: event.type });
		return;
	}
	send(parsed.data.type, parsed.data);
}

export function createLiveEventStream(
	lifecycle: TsukaimaLifecycle,
	request: Request,
	options?: EventStreamOptions,
): Response {
	const intervalMs = heartbeatInterval(options);
	const logger = options?.logger?.child("tsukaima::server::events");
	return createSseResponse(request, (send) => {
		const hooks: HookBus = lifecycle.hooks;
		const disposers = [
			hooks.on("message.received", (payload) => {
				const parsed = messageReceivedHookSchema.safeParse(payload);
				if (!parsed.success) {
					logger?.warn("dropped invalid message.received hook payload");
					return;
				}
				publish(send, logger, {
					channelId: parsed.data.channelId,
					chatObjectId: parsed.data.chatObjectId,
					messageId: parsed.data.envelope.id,
					sessionId: parsed.data.sessionId,
					timestamp: timestamp(),
					type: "message.received",
				});
			}),
			hooks.on("activity.opened", (payload) => {
				const parsed = activityHookSchema.safeParse(payload);
				if (!parsed.success) {
					logger?.warn("dropped invalid activity.opened hook payload");
					return;
				}
				publish(send, logger, {
					...parsed.data,
					timestamp: timestamp(),
					type: "activity.opened",
				});
			}),
			hooks.on("activity.closed", (payload) => {
				const parsed = activityHookSchema.safeParse(payload);
				if (!parsed.success) {
					logger?.warn("dropped invalid activity.closed hook payload");
					return;
				}
				publish(send, logger, {
					...parsed.data,
					timestamp: timestamp(),
					type: "activity.closed",
				});
			}),
			hooks.on("before.reply", (payload) => {
				const parsed = replyHookSchema.safeParse(payload);
				if (!parsed.success) {
					logger?.warn("dropped invalid before.reply hook payload");
					return;
				}
				publish(send, logger, {
					...parsed.data,
					timestamp: timestamp(),
					type: "before.reply",
				});
			}),
			hooks.on("after.reply", (payload) => {
				const parsed = afterReplyHookSchema.safeParse(payload);
				if (!parsed.success) {
					logger?.warn("dropped invalid after.reply hook payload");
					return;
				}
				publish(send, logger, {
					...parsed.data,
					timestamp: timestamp(),
					type: "after.reply",
				});
			}),
		];
		const heartbeat = setInterval(() => {
			publish(send, logger, { timestamp: timestamp(), type: "heartbeat" });
		}, intervalMs);
		heartbeat.unref?.();
		const state = lifecycle.state;
		publish(send, logger, {
			lifecycle: {
				stage: state.stage,
				startedAtMs: state.startedAtMs,
				state: state.state,
				...(state.reason === undefined ? {} : { reason: state.reason }),
			},
			processedMessages: lifecycle.processedMessageCount,
			timestamp: timestamp(),
			type: "snapshot",
		});
		return () => {
			for (const dispose of disposers) dispose();
			clearInterval(heartbeat);
		};
	});
}
