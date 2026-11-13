"use client";

import { createHighlighter, type Highlighter } from "shiki";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry } from "@/lib/api";
import { cn } from "@elaina/ui/lib/utils";

const LIGHT_THEME = "github-light-high-contrast";
const DARK_THEME = "github-dark-high-contrast";

interface LogToken {
	readonly content: string;
	readonly style: CSSProperties | undefined;
}

interface LogTokenState {
	readonly code: string;
	readonly lines: readonly (readonly LogToken[])[];
}

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
	if (highlighterPromise === null) {
		highlighterPromise = createHighlighter({
			langs: [],
			themes: [LIGHT_THEME, DARK_THEME],
		});
	}
	return highlighterPromise;
}

function useAnsiLogTokens(code: string): readonly (readonly LogToken[])[] | null {
	const [state, setState] = useState<LogTokenState | null>(null);

	useEffect(() => {
		if (code.length === 0) {
			setState({ code, lines: [] });
			return;
		}
		let cancelled = false;
		void getHighlighter().then((highlighter) => {
			if (cancelled) return;
			const result = highlighter.codeToTokens(code, {
				defaultColor: "light",
				lang: "ansi",
				themes: {
					dark: DARK_THEME,
					light: LIGHT_THEME,
				},
			});
			setState({
				code,
				lines: result.tokens.map((line) =>
					line.map((token) => {
						const htmlStyle =
							"htmlStyle" in token
								? (token.htmlStyle as Record<string, string> | undefined)
								: undefined;
						return {
							content: token.content,
							style:
								htmlStyle === undefined
									? undefined
									: ({
											...htmlStyle,
											"--runtime-log-light-color": htmlStyle.color,
										} as CSSProperties),
						};
					}),
				),
			});
		});
		return () => {
			cancelled = true;
		};
	}, [code]);

	return state?.code === code ? state.lines : null;
}

export interface LogTerminalProps {
	readonly className?: string;
	readonly emptyLabel: string;
	readonly entries: readonly LogEntry[];
	readonly follow: boolean;
}

export function LogTerminal({ className, emptyLabel, entries, follow }: LogTerminalProps) {
	const viewportRef = useRef<HTMLDivElement>(null);
	const code = useMemo(() => entries.map((entry) => entry.ansi).join("\n"), [entries]);
	const tokens = useAnsiLogTokens(code);

	useEffect(() => {
		if (!follow) return;
		const viewport = viewportRef.current;
		if (viewport === null) return;
		const frame = requestAnimationFrame(() => {
			viewport.scrollTop = viewport.scrollHeight;
		});
		return () => cancelAnimationFrame(frame);
	}, [entries.length, follow]);

	return (
		<div
			ref={viewportRef}
			role="log"
			aria-live={follow ? "polite" : "off"}
			className={cn(
				"max-h-[min(60vh,44rem)] min-h-64 overflow-auto rounded-xl border border-border",
				"bg-[#ffffff] text-foreground dark:bg-[#0a0c10]",
				className,
			)}
		>
			{entries.length === 0 ? (
				<p className="px-4 py-10 text-center font-mono text-xs text-muted-foreground">
					{emptyLabel}
				</p>
			) : (
				<pre className="m-0 min-w-max py-2 font-mono text-[11px] leading-5">
					<code>
						{entries.map((entry, lineIndex) => {
							const line = tokens?.[lineIndex];
							return (
								<span
									key={entry.id}
									data-level={entry.level}
									className="block min-h-5 whitespace-pre px-3 hover:bg-foreground/[0.035]"
								>
									{line === undefined
										? entry.text
										: line.map((token, tokenIndex) => (
												<span
													key={`${tokenIndex}-${token.content}`}
													className="runtime-log-token"
													style={token.style}
												>
													{token.content}
												</span>
											))}
								</span>
							);
						})}
					</code>
				</pre>
			)}
		</div>
	);
}
