import { createAuthClient } from "better-auth/react";
import { usernameClient } from "better-auth/client/plugins";

const baseUrl = import.meta.env.VITE_AUTH_URL;

/**
 * Better Auth owns sign-in, sign-out, and the session cookie. The client points at the native
 * `/api/auth/*` routes mounted by the Elysia server; TanStack Query wraps `getSession` below so
 * the rest of the WebUI continues to use one cache and one invalidation model.
 */
export const authClient = createAuthClient({
	...(baseUrl === undefined || baseUrl === "" ? {} : { baseURL: baseUrl }),
	plugins: [usernameClient()],
});

export const authSessionQueryKey = ["auth", "session"] as const;

export function authSessionQueryOptions() {
	return {
		queryFn: async () => {
			const { data, error } = await authClient.getSession();
			if (error !== null) throw error;
			return data;
		},
		queryKey: authSessionQueryKey,
		refetchInterval: 30_000,
		retry: false,
	} as const;
}
