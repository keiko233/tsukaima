import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@tsukaima/ui/components/motion/button";
import { orpc } from "@/lib/api";
import { m } from "@/paraglide/messages";

function HighlightedCode({ code, language }: { code: string; language: string }) {
	const highlighted = useQuery({
		queryKey: ["workspace-code", language, code],
		gcTime: 0,
		queryFn: async () => {
			const { bundledLanguages, codeToHtml } = await import("shiki");
			const lang = Object.hasOwn(bundledLanguages, language)
				? (language as keyof typeof bundledLanguages)
				: "text";
			return codeToHtml(code, {
				lang,
				themes: { dark: "github-dark", light: "github-light" },
			});
		},
	});
	if (highlighted.data === undefined) return <pre className="p-2">{code}</pre>;
	return (
		<div
			className="workspace-git-code [&_pre]:p-2"
			dangerouslySetInnerHTML={{ __html: highlighted.data }}
		/>
	);
}

export function WorkspaceGitPanel({ sessionId }: { sessionId: string }) {
	const [path, setPath] = useState<string>();
	const [mode, setMode] = useState<"code" | "diff">("diff");
	const status = useQuery({
		...orpc.admin.workspace.git.queryOptions({ input: { sessionId } }),
		refetchInterval: 5_000,
	});
	const selected = status.data?.files.find((file) => file.path === path);
	const file = useQuery({
		...orpc.admin.workspace.git.queryOptions({ input: { sessionId, path: path ?? "" } }),
		enabled: selected !== undefined,
		refetchInterval: 5_000,
	});
	const entry = file.data?.file;
	const showCode = mode === "code" || selected?.status === "??";
	const code = showCode ? entry?.code : entry?.diff;
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden text-[11px]">
			<div className="flex items-center justify-between border-b border-border/60 px-3 py-1">
				<span>{m.workspace_git_changes()}</span>
				<Button
					type="button"
					variant="ghost"
					size="iconSm"
					aria-label={m.retry()}
					onClick={() => {
						void status.refetch();
						if (selected !== undefined) void file.refetch();
					}}
				>
					<RefreshCw className="size-3" />
				</Button>
			</div>
			{status.isError ? <p className="px-3 py-2">{m.error_generic()}</p> : null}
			{status.isPending ? <p className="px-3 py-2">{m.loading()}</p> : null}
			{status.data === null ? <p className="px-3 py-2">{m.workspace_git_unavailable()}</p> : null}
			{status.data?.files.length === 0 ? (
				<p className="px-3 py-2">{m.workspace_git_clean()}</p>
			) : null}
			{status.data?.truncated ? <p className="px-3 py-2">{m.workspace_git_truncated()}</p> : null}
			<ul className="max-h-40 shrink-0 overflow-y-auto">
				{status.data?.files.map((item) => (
					<li key={item.path}>
						<button
							type="button"
							title={item.path}
							aria-pressed={item.path === selected?.path}
							onClick={() => setPath(item.path)}
							className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-muted aria-pressed:bg-muted"
						>
							<span className="w-5 shrink-0 whitespace-pre font-mono">{item.status}</span>
							<span className="truncate font-mono">{item.path}</span>
						</button>
					</li>
				))}
			</ul>
			{selected === undefined ? null : (
				<>
					{selected.status === "??" ? null : (
						<div className="flex gap-2 border-y border-border/60 px-3 py-1">
							<Button
								size="xs"
								variant={mode === "diff" ? "outline" : "ghost"}
								onClick={() => setMode("diff")}
							>
								{m.workspace_git_diff()}
							</Button>
							<Button
								size="xs"
								variant={mode === "code" ? "outline" : "ghost"}
								onClick={() => setMode("code")}
							>
								{m.workspace_git_code()}
							</Button>
						</div>
					)}
					{file.isError ? <p className="px-3 py-2">{m.error_generic()}</p> : null}
					{file.isPending ? <p className="px-3 py-2">{m.loading()}</p> : null}
					{entry?.truncated ? <p className="px-3 py-2">{m.workspace_git_truncated()}</p> : null}
					{code === null ? <p className="px-3 py-2">{m.workspace_git_code_unavailable()}</p> : null}
					{code === undefined || code === null ? null : (
						<div className="min-h-0 flex-1 overflow-auto">
							<HighlightedCode
								code={code}
								language={
									showCode ? (selected.path.split(".").at(-1)?.toLowerCase() ?? "text") : "diff"
								}
							/>
						</div>
					)}
				</>
			)}
		</div>
	);
}
