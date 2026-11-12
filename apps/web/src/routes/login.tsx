import { ORPCError } from "@orpc/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { orpc } from "@/lib/api";
import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/login")({ component: LoginPage });

function loginErrorMessage(error: unknown): string {
	if (error instanceof ORPCError) {
		if (error.code === "TOO_MANY_REQUESTS") return m.auth_rate_limited();
		if (error.code === "UNAUTHENTICATED") return m.auth_invalid_credentials();
	}
	return m.auth_sign_in_failed();
}

function LoginPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const status = useQuery(orpc.auth.status.queryOptions({ retry: false }));
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const login = useMutation(
		orpc.auth.login.mutationOptions({
			onSuccess: async () => {
				// Wait for the gate query to observe the new session before navigating.
				await queryClient.invalidateQueries({ queryKey: orpc.auth.status.queryKey() });
				void navigate({ replace: true, to: "/" });
			},
		}),
	);

	const configured = status.data?.configured !== false;
	const errorText = login.error === null ? null : loginErrorMessage(login.error);

	return (
		<div className="grid h-dvh place-items-center bg-background px-4">
			<div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-sm">
				<div className="mb-6 flex items-center gap-3">
					<span className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground">
						<Sparkles className="size-5" />
					</span>
					<div className="min-w-0">
						<div className="text-base font-semibold tracking-tight">Tsukaima</div>
						<div className="text-xs text-muted-foreground">{m.auth_sign_in_subtitle()}</div>
					</div>
				</div>
				{configured ? (
					<form
						className="flex flex-col gap-4"
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
