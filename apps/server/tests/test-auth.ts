import { expect } from "bun:test";

interface TestApp {
	handle(request: Request): Promise<Response>;
}

function cookieFromResponse(response: Response): string {
	const setCookies =
		typeof response.headers.getSetCookie === "function"
			? response.headers.getSetCookie()
			: [response.headers.get("set-cookie") ?? ""];
	const sessionCookie = setCookies.find((value) => value.startsWith("elaina.session_token="));
	if (sessionCookie === undefined) {
		throw new Error(`sign-in did not set an Elaina session cookie: ${setCookies.join(" | ")}`);
	}
	return sessionCookie.split(";")[0] ?? "";
}

/** Signs in through Better Auth's real HTTP route and returns the Cookie header value. */
export async function signIn(
	app: TestApp,
	username: string,
	password: string,
	baseUrl = "http://localhost",
	origin?: string,
): Promise<string> {
	const response = await app.handle(
		new Request(`${baseUrl}/api/auth/sign-in/username`, {
			body: JSON.stringify({ password, username }),
			headers: {
				"content-type": "application/json",
				...(origin === undefined ? {} : { origin }),
			},
			method: "POST",
		}),
	);
	expect(response.status).toBe(200);
	return cookieFromResponse(response);
}

export async function signOut(
	app: TestApp,
	cookie: string,
	baseUrl = "http://localhost",
	origin?: string,
): Promise<Response> {
	return app.handle(
		new Request(`${baseUrl}/api/auth/sign-out`, {
			body: JSON.stringify({}),
			headers: {
				cookie,
				"content-type": "application/json",
				...(origin === undefined ? {} : { origin }),
			},
			method: "POST",
		}),
	);
}
