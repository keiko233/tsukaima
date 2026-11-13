import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLog } from "@elaina/db";
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
	ELAINA_ADMIN_PASSWORD: password,
	ELAINA_ADMIN_USERNAME: "elaina",
	ELAINA_DATA_DIR: directory,
	ELAINA_PORT: "7420",
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
		const directory = await createDirectory("elaina-auth-");
		const { app, lifecycle } = createApp(adminEnv(directory));
		await lifecycle.start();

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
			username: "elaina",
		});
		expect(wrongPassword.status).toBe(401);
		expect(wrongPassword.headers.get("set-cookie")).toBeNull();

		const login = await authPost(app, "sign-in/username", {
			password: "correct-horse",
			username: "elaina",
		});
		expect(login.status).toBe(200);
		const loginBody = (await login.json()) as {
			token?: string;
			user?: { username?: string };
		};
		expect(loginBody.user?.username).toBe("elaina");
		expect(JSON.stringify(loginBody)).not.toContain("correct-horse");
		const setCookie = login.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("elaina.session_token=");
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Lax");
		expect(setCookie).toContain("Path=/");
		expect(setCookie).toContain("Max-Age=");
		expect(setCookie).not.toContain("correct-horse");

		const cookie = await signIn(app, "elaina", "correct-horse");
		const after = await rpc(app, "auth/status", {}, cookie);
		expect(after.body).toEqual({ authenticated: true, configured: true, username: "elaina" });

		const allowed = await rpc(app, "admin/diagnostics/status", {}, cookie);
		expect(allowed.status).toBe(200);
		expect(allowed.body.state).toBeDefined();

		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("domain database not ready");
		await rpc(app, "admin/chats/createLocal", { sessionTitle: "Audit", title: "Audit" }, cookie);
		const auditRows = await database.select().from(auditLog);
		expect(
			auditRows.some((row) => row.action === "admin.sign-in" && row.actorId === "admin:elaina"),
		).toBe(true);
		expect(
			auditRows.some((row) => row.action === "admin.sign-in-denied" && row.result === "denied"),
		).toBe(true);
		const adminActionRow = auditRows.find((row) => row.action === "admin.rpc");
		expect(adminActionRow?.actorId).toBe("admin:elaina");
		expect(adminActionRow?.payloadJson).toContain("admin/chats/createLocal");

		const failing = await rpc(
			app,
			"admin/sessions/send",
			{ sessionId: "missing", target: "elaina", text: "hello" },
			cookie,
		);
		expect(failing.status).toBe(500);
		const failedAudit = (await database.select().from(auditLog)).find(
			(row) =>
				row.action === "admin.rpc" &&
				row.result === "failed" &&
				row.payloadJson?.includes("admin/sessions/send") === true,
		);
		expect(failedAudit?.actorId).toBe("admin:elaina");

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
		const directory = await createDirectory("elaina-auth-unconfigured-");
		const { app, auth, lifecycle } = createApp({
			ELAINA_DATA_DIR: directory,
			ELAINA_PORT: "7420",
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
		expect(guidanceFields).toContain("ELAINA_ADMIN_USERNAME");
		expect(guidanceFields).toContain("ELAINA_ADMIN_PASSWORD");

		await lifecycle.stop();
	});

	test("persists the bootstrap credential and never rotates it from env", async () => {
		const directory = await createDirectory("elaina-auth-persist-");

		const first = createApp(adminEnv(directory, "first-password"));
		await first.lifecycle.start();
		await signIn(first.app, "elaina", "first-password");
		await first.lifecycle.stop();

		const second = createApp(adminEnv(directory, "second-password"));
		await second.lifecycle.start();
		const rotated = await authPost(second.app, "sign-in/username", {
			password: "second-password",
			username: "elaina",
		});
		expect(rotated.status).toBe(401);
		await signIn(second.app, "elaina", "first-password");
		await second.lifecycle.stop();
	});

	test("keeps a Better Auth session across a server restart", async () => {
		const directory = await createDirectory("elaina-auth-session-persist-");

		const first = createApp(adminEnv(directory));
		await first.lifecycle.start();
		const cookie = await signIn(first.app, "elaina", "correct-horse");
		await first.lifecycle.stop();

		const second = createApp(adminEnv(directory));
		await second.lifecycle.start();
		const allowed = await rpc(second.app, "admin/diagnostics/status", {}, cookie);
		expect(allowed.status).toBe(200);
		await second.lifecycle.stop();
	});

	test("accepts browser-origin sign-in and sign-out", async () => {
		const directory = await createDirectory("elaina-auth-origin-");
		const { app, lifecycle } = createApp({
			...adminEnv(directory),
			ELAINA_PUBLIC_URL: "http://localhost:7420",
			ELAINA_WEB_ORIGIN: "http://localhost:7420",
		});
		await lifecycle.start();

		const cookie = await signIn(
			app,
			"elaina",
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
		const directory = await createDirectory("elaina-auth-vite-origin-");
		const { app, lifecycle } = createApp(adminEnv(directory));
		await lifecycle.start();

		const cookie = await signIn(
			app,
			"elaina",
			"correct-horse",
			"http://localhost",
			"http://127.0.0.1:7421",
		);
		expect(cookie).toContain("elaina.session_token=");

		await lifecycle.stop();
	});

	test("accepts additional origins from ELAINA_TRUSTED_ORIGINS", async () => {
		const directory = await createDirectory("elaina-auth-extra-origin-");
		const { app, lifecycle } = createApp({
			...adminEnv(directory),
			ELAINA_TRUSTED_ORIGINS: "http://elaina.lan:7420",
		});
		await lifecycle.start();

		const cookie = await signIn(
			app,
			"elaina",
			"correct-horse",
			"http://localhost",
			"http://elaina.lan:7420",
		);
		expect(cookie).toContain("elaina.session_token=");

		await lifecycle.stop();
	});

	test("locks sign-in after repeated failures", async () => {
		const directory = await createDirectory("elaina-auth-lockout-");
		const { app, lifecycle } = createApp(adminEnv(directory));
		await lifecycle.start();

		for (let attempt = 0; attempt < 5; attempt += 1) {
			const failure = await authPost(app, "sign-in/username", {
				password: "nope",
				username: "elaina",
			});
			expect(failure.status).toBe(401);
		}
		const locked = await authPost(app, "sign-in/username", {
			password: "correct-horse",
			username: "elaina",
		});
		expect(locked.status).toBe(429);
		expect(locked.headers.get("retry-after") ?? locked.headers.get("x-retry-after")).not.toBeNull();

		await lifecycle.stop();
	});

	test("rate limits per client address without trusting spoofed forwarded headers", async () => {
		const directory = await createDirectory("elaina-auth-ip-");
		const { auth, lifecycle } = createApp(adminEnv(directory));
		await lifecycle.start();

		const attempt = (address: string, forwarded?: string) => {
			const headers = new Headers({ "content-type": "application/json" });
			if (forwarded !== undefined) headers.set("x-forwarded-for", forwarded);
			return auth.handle(
				new Request("http://localhost/api/auth/sign-in/username", {
					body: JSON.stringify({ password: "nope", username: "elaina" }),
					headers,
					method: "POST",
				}),
				address,
			);
		};

		// A spoofed forwarded header cannot move the bucket while no proxy is trusted.
		for (let index = 0; index < 5; index += 1) {
			expect((await attempt("10.0.0.5", `198.51.100.${index + 1}`)).status).toBe(401);
		}
		expect((await attempt("10.0.0.5", "198.51.100.99")).status).toBe(429);

		// Another direct client has its own bucket.
		expect((await attempt("10.0.0.6")).status).toBe(401);

		await lifecycle.stop();
	});

	test("rejects every admin procedure without a session", async () => {
		const directory = await createDirectory("elaina-auth-guard-");
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
			"groups/get": { groupId: "group-1" },
			"groups/list": {},
			"modelPolicies/list": {},
			"modelPolicies/set": {
				capability: "basic-chat",
				primaryModel: "fake-deterministic",
				primaryProvider: "fake",
			},
			"plugins/list": {},
			"plugins/rpc": { input: {}, method: "test.ping" },
			"plugins/setEnabled": { enabled: false, pluginId: "onebot-napcat" },
			"plugins/updateConfig": { config: {}, pluginId: "onebot-napcat" },
			"requests/get": { requestId: "request-1" },
			"requests/list": {},
			"requests/respond": { action: "approve", requestId: "request-1" },
			"sessions/create": { chatObjectId: "chat-1", title: "Sample" },
			"sessions/get": { sessionId: "session-1" },
			"sessions/messages": { sessionId: "session-1" },
			"sessions/send": { sessionId: "session-1", target: "elaina", text: "hello" },
			"sessions/setReceiving": { sessionId: "session-1" },
			"sessions/update": { sessionId: "session-1" },
			"settings/get": {},
			"settings/update": { logLevel: "info" },
			"users/get": { userId: "user-1" },
			"users/list": {},
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
