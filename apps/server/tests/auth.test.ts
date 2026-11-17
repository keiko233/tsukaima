import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLog } from "@tsukaima/db";
import { createApp } from "../src/app.ts";
import { appRouter } from "../src/rpc/index.ts";
import { signIn, signOut } from "./test-auth.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function createDirectory(prefix: string): Promise<string> {
	const directory = await fs.mkdtemp(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

interface RpcResult {
	readonly body: Record<string, unknown>;
	readonly cookie: string | null;
	readonly status: number;
}

async function rpc(
	app: ReturnType<typeof createApp>["app"],
	path: string,
	input: unknown,
	cookie?: string,
): Promise<RpcResult> {
	const response = await app.handle(
		new Request(`http://localhost/rpc/${path}`, {
			body: JSON.stringify(input === undefined ? {} : { json: input }),
			headers: {
				"content-type": "application/json",
				...(cookie === undefined ? {} : { cookie }),
			},
			method: "POST",
		}),
	);
	const envelope = (await response.json()) as { json?: unknown };
	const value = envelope.json ?? envelope;
	return {
		body: typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {},
		cookie: response.headers.get("set-cookie"),
		status: response.status,
	};
}

async function authPost(
	app: ReturnType<typeof createApp>["app"],
	path: string,
	body: unknown,
	cookie?: string,
): Promise<Response> {
	return app.handle(
		new Request(`http://localhost/api/auth/${path}`, {
			body: JSON.stringify(body),
			headers: {
				"content-type": "application/json",
				...(cookie === undefined ? {} : { cookie }),
			},
			method: "POST",
		}),
	);
}

const adminEnv = (directory: string, password = "correct-horse"): Record<string, string> => ({
	TSUKAIMA_ADMIN_PASSWORD: password,
	TSUKAIMA_ADMIN_USERNAME: "tsukaima",
	TSUKAIMA_DATA_DIR: directory,
	TSUKAIMA_PORT: "7420",
});

/** Collects every procedure path under `appRouter.admin` so guard coverage is exhaustive. */
function collectAdminProcedurePaths(router: unknown, prefix = ""): string[] {
	const paths: string[] = [];
	if (typeof router !== "object" || router === null) return paths;
	// Implemented procedures are plain objects carrying their definition under `~orpc`.
	if (Object.hasOwn(router, "~orpc")) return prefix === "" ? paths : [prefix];
	for (const [key, value] of Object.entries(router)) {
		if (key.startsWith("~") || key.startsWith("_")) continue;
		const path = prefix === "" ? key : `${prefix}/${key}`;
		paths.push(...collectAdminProcedurePaths(value, path));
	}
	return paths;
}

describe("admin auth", () => {
	test("bootstraps from env, signs in through Better Auth, and protects admin procedures", async () => {
		const directory = await createDirectory("tsukaima-auth-");
		const { app, lifecycle } = createApp(adminEnv(directory));
		await lifecycle.start();

		const anonymousSession = await app.handle(new Request("http://localhost/api/auth/get-session"));
		expect(anonymousSession.status).toBe(200);
		expect(anonymousSession.headers.get("content-type")).toContain("application/json");
		expect(await anonymousSession.json()).toBeNull();

		const before = await rpc(app, "auth/status", {});
		expect(before.body).toEqual({ authenticated: false, configured: true });

		const denied = await rpc(app, "admin/diagnostics/status", {});
		expect(denied.status).toBe(401);
		expect(denied.body.code).toBe("UNAUTHENTICATED");

		const publicSignup = await authPost(app, "sign-up/email", {
			email: "intruder@example.com",
			name: "Intruder",
			password: "another-password",
		});
		expect(publicSignup.status).toBe(404);

		const wrongPassword = await authPost(app, "sign-in/username", {
			password: "wrong-password",
			username: "tsukaima",
		});
		expect(wrongPassword.status).toBe(401);
		expect(wrongPassword.headers.get("set-cookie")).toBeNull();

		const login = await authPost(app, "sign-in/username", {
			password: "correct-horse",
			username: "tsukaima",
		});
		expect(login.status).toBe(200);
		const loginBody = (await login.json()) as {
			token?: string;
			user?: { username?: string };
		};
		expect(loginBody.user?.username).toBe("tsukaima");
		expect(JSON.stringify(loginBody)).not.toContain("correct-horse");
		const setCookie = login.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("tsukaima.session_token=");
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Lax");
		expect(setCookie).toContain("Path=/");
		expect(setCookie).toContain("Max-Age=");
		expect(setCookie).not.toContain("correct-horse");

		const cookie = await signIn(app, "tsukaima", "correct-horse");
		const after = await rpc(app, "auth/status", {}, cookie);
		expect(after.body).toEqual({ authenticated: true, configured: true, username: "tsukaima" });

		const allowed = await rpc(app, "admin/diagnostics/status", {}, cookie);
		expect(allowed.status).toBe(200);
		expect(allowed.body.state).toBeDefined();

		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("domain database not ready");
		await rpc(app, "admin/chats/createLocal", { sessionTitle: "Audit", title: "Audit" }, cookie);
		const auditRows = await database.select().from(auditLog);
		expect(
			auditRows.some((row) => row.action === "admin.sign-in" && row.actorId === "admin:tsukaima"),
		).toBe(true);
		expect(
			auditRows.some((row) => row.action === "admin.sign-in-denied" && row.result === "denied"),
		).toBe(true);
		const adminActionRow = auditRows.find((row) => row.action === "admin.rpc");
		expect(adminActionRow?.actorId).toBe("admin:tsukaima");
		expect(adminActionRow?.payloadJson).toContain("admin/chats/createLocal");

		const failing = await rpc(
			app,
			"admin/sessions/send",
			{ sessionId: "missing", target: "tsukaima", text: "hello" },
			cookie,
		);
		expect(failing.status).toBe(500);
		const failedAudit = (await database.select().from(auditLog)).find(
			(row) =>
				row.action === "admin.rpc" &&
				row.result === "failed" &&
				row.payloadJson?.includes("admin/sessions/send") === true,
		);
		expect(failedAudit?.actorId).toBe("admin:tsukaima");

		// A read procedure is authenticated but must not add a mutation audit row.
		const beforeReads = (await database.select().from(auditLog)).length;
		await rpc(app, "admin/diagnostics/status", {}, cookie);
		expect((await database.select().from(auditLog)).length).toBe(beforeReads);

		const logout = await signOut(app, cookie);
		expect(logout.status).toBe(200);
		expect(logout.headers.get("set-cookie") ?? "").toContain("Max-Age=0");

		const revoked = await rpc(app, "admin/diagnostics/status", {}, cookie);
		expect(revoked.status).toBe(401);
		const afterLogout = await rpc(app, "auth/status", {}, cookie);
		expect(afterLogout.body).toEqual({ authenticated: false, configured: true });

		await lifecycle.stop();
	});

	test("stays locked when no credential is configured anywhere", async () => {
		const directory = await createDirectory("tsukaima-auth-unconfigured-");
		const { app, auth, lifecycle } = createApp({
			TSUKAIMA_DATA_DIR: directory,
			TSUKAIMA_PORT: "7420",
		});
		await lifecycle.start();
		await auth.ensureInitialized();

		const status = await rpc(app, "auth/status", {});
		expect(status.body).toEqual({ authenticated: false, configured: false });

		const login = await authPost(app, "sign-in/username", {
			password: "whatever",
			username: "admin",
		});
		expect(login.status).toBe(401);

		// There is intentionally no "unconfigured means allow" fallback.
		const denied = await rpc(app, "admin/users/list", {});
		expect(denied.status).toBe(401);
		expect(denied.body.code).toBe("UNAUTHENTICATED");

		const guidance = lifecycle.logs
			.list()
			.find((entry) => entry.message.includes("admin credentials are not configured"));
		expect(guidance).toBeDefined();
		const guidanceFields = JSON.stringify(guidance?.fields ?? {});
		expect(guidanceFields).toContain("TSUKAIMA_ADMIN_USERNAME");
		expect(guidanceFields).toContain("TSUKAIMA_ADMIN_PASSWORD");

		await lifecycle.stop();
	});

	test("persists the bootstrap credential and never rotates it from env", async () => {
		const directory = await createDirectory("tsukaima-auth-persist-");

		const first = createApp(adminEnv(directory, "first-password"));
		await first.lifecycle.start();
		await signIn(first.app, "tsukaima", "first-password");
		await first.lifecycle.stop();

		const second = createApp(adminEnv(directory, "second-password"));
		await second.lifecycle.start();
		const rotated = await authPost(second.app, "sign-in/username", {
			password: "second-password",
			username: "tsukaima",
		});
		expect(rotated.status).toBe(401);
		await signIn(second.app, "tsukaima", "first-password");
		await second.lifecycle.stop();
	});

	test("keeps a Better Auth session across a server restart", async () => {
		const directory = await createDirectory("tsukaima-auth-session-persist-");

		const first = createApp(adminEnv(directory));
		await first.lifecycle.start();
		const cookie = await signIn(first.app, "tsukaima", "correct-horse");
		await first.lifecycle.stop();

		const second = createApp(adminEnv(directory));
		await second.lifecycle.start();
		const allowed = await rpc(second.app, "admin/diagnostics/status", {}, cookie);
		expect(allowed.status).toBe(200);
		await second.lifecycle.stop();
	});

	test("accepts browser-origin sign-in and sign-out", async () => {
		const directory = await createDirectory("tsukaima-auth-origin-");
		const { app, lifecycle } = createApp({
			...adminEnv(directory),
			TSUKAIMA_PUBLIC_URL: "http://localhost:7420",
			TSUKAIMA_WEB_ORIGIN: "http://localhost:7420",
		});
		await lifecycle.start();

		const cookie = await signIn(
			app,
			"tsukaima",
			"correct-horse",
			"http://localhost",
			"http://localhost:7420",
		);
		const logout = await signOut(app, cookie, "http://localhost", "http://localhost:7420");
		expect(logout.status).toBe(200);
		const revoked = await rpc(app, "admin/diagnostics/status", {}, cookie);
		expect(revoked.status).toBe(401);

		await lifecycle.stop();
	});

	test("accepts the default Vite origin in development", async () => {
		const directory = await createDirectory("tsukaima-auth-vite-origin-");
		const { app, lifecycle } = createApp(adminEnv(directory));
		await lifecycle.start();

		const cookie = await signIn(
			app,
			"tsukaima",
			"correct-horse",
			"http://localhost",
			"http://127.0.0.1:7421",
		);
		expect(cookie).toContain("tsukaima.session_token=");

		await lifecycle.stop();
	});

	test("accepts additional origins from TSUKAIMA_TRUSTED_ORIGINS", async () => {
		const directory = await createDirectory("tsukaima-auth-extra-origin-");
		const { app, lifecycle } = createApp({
			...adminEnv(directory),
			TSUKAIMA_TRUSTED_ORIGINS: "http://app.example.test:7420",
		});
		await lifecycle.start();

		const cookie = await signIn(
			app,
			"tsukaima",
			"correct-horse",
			"http://localhost",
			"http://app.example.test:7420",
		);
		expect(cookie).toContain("tsukaima.session_token=");

		await lifecycle.stop();
	});

	test("locks sign-in after repeated failures", async () => {
		const directory = await createDirectory("tsukaima-auth-lockout-");
		const { app, lifecycle } = createApp(adminEnv(directory));
		await lifecycle.start();

		for (let attempt = 0; attempt < 5; attempt += 1) {
			const failure = await authPost(app, "sign-in/username", {
				password: "nope",
				username: "tsukaima",
			});
			expect(failure.status).toBe(401);
		}
		const locked = await authPost(app, "sign-in/username", {
			password: "correct-horse",
			username: "tsukaima",
		});
		expect(locked.status).toBe(429);
		expect(locked.headers.get("retry-after") ?? locked.headers.get("x-retry-after")).not.toBeNull();

		await lifecycle.stop();
	});

	test("rate limits per client address without trusting spoofed forwarded headers", async () => {
		const directory = await createDirectory("tsukaima-auth-ip-");
		const { auth, lifecycle } = createApp(adminEnv(directory));
		await lifecycle.start();

		const attempt = (address: string, forwarded?: string) => {
			const headers = new Headers({ "content-type": "application/json" });
			if (forwarded !== undefined) headers.set("x-forwarded-for", forwarded);
			return auth.handle(
				new Request("http://localhost/api/auth/sign-in/username", {
					body: JSON.stringify({ password: "nope", username: "tsukaima" }),
					headers,
					method: "POST",
				}),
				address,
			);
		};

		// A spoofed forwarded header cannot move the bucket while no proxy is trusted.
		for (let index = 0; index < 5; index += 1) {
			expect((await attempt("192.0.2.5", `198.51.100.${index + 1}`)).status).toBe(401);
		}
		expect((await attempt("192.0.2.5", "198.51.100.99")).status).toBe(429);

		// Another direct client has its own bucket.
		expect((await attempt("192.0.2.6")).status).toBe(401);

		await lifecycle.stop();
	});

	test("rejects every admin procedure without a session", async () => {
		const directory = await createDirectory("tsukaima-auth-guard-");
		const { app, lifecycle } = createApp(adminEnv(directory));
		await lifecycle.start();

		const paths = collectAdminProcedurePaths(appRouter.admin).toSorted();
		const sampleInputs: Record<string, unknown> = {
			"chats/createLocal": { sessionTitle: "Sample", title: "Sample" },
			"chats/list": {},
			"conversations/list": {},
			"diagnostics/clearLogs": {},
			"diagnostics/logs": {},
			"diagnostics/status": {},
			"github/clear": {},
			"github/configure": { appId: 1, installationId: 1, privateKey: "synthetic-key" },
			"github/issues": {},
			"github/pulls": {},
			"github/runs": {},
			"github/status": {},
			"groups/get": { groupId: "group-1" },
			"groups/list": {},
			"memory/approve": { id: "memory-1" },
			"memory/compact": { conversationId: "session-1" },
			"memory/create": { kind: "fact", scope: "global", summary: "Sample" },
			"memory/expire": {},
			"memory/get": { id: "memory-1" },
			"memory/list": {},
			"memory/pin": { id: "memory-1", pinned: true },
			"memory/reject": { id: "memory-1" },
			"memory/revoke": { id: "memory-1" },
			"memory/search": { query: "sample" },
			"memory/update": { id: "memory-1", summary: "Sample" },
			"modelPolicies/list": {},
			"modelPolicies/set": {
				capability: "basic-chat",
				primaryModel: "fake-deterministic",
				primaryProvider: "fake",
			},
			"personas/bindPersona": { personaId: "persona-1", scope: "global" },
			"personas/bindings": {},
			"personas/list": {},
			"personas/upsert": {
				name: "Sample",
				prompt: "You are a sample persona.",
				summary: "Sample persona",
			},
			"plugins/downgrade": {
				manifest: {
					apiVersion: "1",
					kind: "third-party",
					name: "sample",
					permissions: [],
					version: "0.1.0",
				},
				pluginId: "sample",
			},
			"plugins/install": {
				manifest: {
					apiVersion: "1",
					kind: "third-party",
					name: "sample",
					permissions: [],
					version: "0.1.0",
				},
			},
			"plugins/list": {},
			"plugins/reload": { pluginId: "onebot-napcat" },
			"plugins/uninstall": { pluginId: "sample" },
			"plugins/upgrade": {
				manifest: {
					apiVersion: "1",
					kind: "third-party",
					name: "sample",
					permissions: [],
					version: "0.2.0",
				},
				pluginId: "sample",
			},
			"policies/get": { conversationId: "session-1" },
			"policies/history": { conversationId: "session-1", scope: "conversation" },
			"policies/overrideAll": { policy: {} },
			"policies/update": { policy: {}, scope: "global" },
			"plugins/rpc": { input: {}, method: "test.ping" },
			"plugins/setEnabled": { enabled: false, pluginId: "onebot-napcat" },
			"plugins/updateConfig": { config: {}, pluginId: "onebot-napcat" },
			"repository/status": {},
			"requests/get": { requestId: "request-1" },
			"requests/list": {},
			"requests/respond": { action: "approve", requestId: "request-1" },
			"schedules/cancel": { confirm: true, scheduleId: "schedule-1" },
			"schedules/create": {
				prompt: "Synthetic reminder",
				recurrence: { at: "2026-12-01T09:00:00.000Z", kind: "once" },
				targetSessionId: "session-1",
				timeZone: "UTC",
				title: "Synthetic schedule",
			},
			"schedules/get": { scheduleId: "schedule-1" },
			"schedules/list": {},
			"schedules/occurrences": { scheduleId: "schedule-1" },
			"schedules/pause": { scheduleId: "schedule-1" },
			"schedules/preview": {
				recurrence: { at: "2026-12-01T09:00:00.000Z", kind: "once" },
				timeZone: "UTC",
			},
			"schedules/resume": { scheduleId: "schedule-1" },
			"schedules/runNow": { scheduleId: "schedule-1" },
			"schedules/summary": {},
			"schedules/update": { scheduleId: "schedule-1", title: "Updated" },
			"runtime/cancelRestart": {},
			"runtime/restartStatus": {},
			"runtime/scheduleRestart": { delaySeconds: 60, mode: "restart" },
			"sessions/abort": { sessionId: "session-1" },
			"sessions/compact": { sessionId: "session-1" },
			"sessions/contextStats": { sessionId: "session-1" },
			"sessions/create": { chatObjectId: "chat-1", title: "Sample" },
			"sessions/get": { sessionId: "session-1" },
			"sessions/message": { messageId: "message-1", sessionId: "session-1" },
			"sessions/messages": { sessionId: "session-1" },
			"sessions/resetContext": { sessionId: "session-1" },
			"sessions/runSteps": { entryId: "entry-1", sessionId: "session-1" },
			"sessions/search": { query: "Sample" },
			"sessions/send": { sessionId: "session-1", target: "tsukaima", text: "hello" },
			"sessions/setReceiving": { sessionId: "session-1" },
			"sessions/update": { sessionId: "session-1" },
			"settings/get": {},
			"settings/update": { logLevel: "info" },
			"upgrade/check": {},
			"upgrade/finalize": {},
			"upgrade/history": {},
			"upgrade/start": {},
			"upgrade/status": {},
			"users/get": { userId: "user-1" },
			"users/list": {},
			"workspace/create": { goal: "Sample workspace" },
			"workspace/get": { sessionId: "session-1" },
			"workspace/list": {},
			"workspace/todos": { sessionId: "session-1" },
			"workspace/update": { sessionId: "session-1", tags: ["patch"] },
		};

		// Coverage check in both directions: every real procedure has a sample and vice versa.
		expect(Object.keys(sampleInputs).toSorted()).toEqual(paths);

		for (const path of paths) {
			const response = await rpc(app, `admin/${path}`, sampleInputs[path]);
			expect(`${path} -> ${response.status}`).toBe(`${path} -> 401`);
			expect(response.body.code).toBe("UNAUTHENTICATED");
		}

		await lifecycle.stop();
	});
});
