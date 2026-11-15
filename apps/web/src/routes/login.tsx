import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import { Button } from "@elaina/ui/components/motion/button";
import { Input } from "@elaina/ui/components/motion/input";
import { orpc } from "@/lib/api";
import { authClient, authSessionQueryKey } from "@/lib/auth";
import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/login")({ component: LoginPage });

interface AuthClientError extends Error {
	readonly code?: string;
	readonly status?: number;
}

function loginErrorMessage(error: unknown): string {
	const failure = error as Partial<AuthClientError> | null;
	if (failure?.status === 429 || failure?.code === "RATE_LIMITED") {
		return m.auth_rate_limited();
	}
	if (failure?.status === 401 || failure?.code === "INVALID_USERNAME_OR_PASSWORD") {
		return m.auth_invalid_credentials();
	}
	return m.auth_sign_in_failed();
}

function LoginPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const status = useQuery(orpc.auth.status.queryOptions({ retry: false }));
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const login = useMutation({
		mutationFn: async (input: { password: string; username: string }) => {
			const { data, error } = await authClient.signIn.username(input);
			if (error !== null) {
				const failure = new Error(error.message) as Error & {
					code?: string;
					status?: number;
				};
				failure.code = error.code;
				failure.status = error.status;
				throw failure;
			}
			return data;
		},
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: authSessionQueryKey }),
				queryClient.invalidateQueries({ queryKey: orpc.auth.status.queryKey() }),
			]);
			void navigate({ replace: true, to: "/" });
		},
	});

	const configured = status.data?.configured !== false;
	const errorText = login.error === null ? null : loginErrorMessage(login.error);

	return (
		<div className="grid h-dvh place-items-center bg-background px-4">
			<div className="w-full max-w-[320px] rounded-xl border border-border bg-card p-5 shadow-sm">
				<div className="mb-5 flex items-center gap-2.5">
					<span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
						<Sparkles className="size-4" />
					</span>
					<div className="min-w-0">
						<div className="text-[13px] font-semibold tracking-tight">Elaina</div>
						<div className="text-[10.5px] text-muted-foreground">
							{m.auth_sign_in_subtitle()}
						</div>
					</div>
				</div>
				{configured ? (
					<form
						className="flex flex-col gap-3"
						onSubmit={(event) => {
							event.preventDefault();
							login.mutate({ password, username: username.trim() });
						}}
					>
						<Input
							autoComplete="username"
							autoFocus
							label={m.auth_username()}
							onChange={setUsername}
							value={username}
						/>
						<Input
							autoComplete="current-password"
							label={m.auth_password()}
							onChange={setPassword}
							type="password"
							value={password}
						/>
						{errorText === null ? null : <p className="text-xs text-destructive">{errorText}</p>}
						<Button
							className="w-full"
							disabled={login.isPending || username.trim() === "" || password === ""}
							type="submit"
						>
							{login.isPending ? m.auth_signing_in() : m.auth_sign_in_action()}
						</Button>
					</form>
				) : (
					<p className="text-sm leading-relaxed text-muted-foreground">{m.auth_not_configured()}</p>
				)}
			</div>
		</div>
	);
}
