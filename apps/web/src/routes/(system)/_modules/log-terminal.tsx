"use client";

import { createHighlighter, type Highlighter } from "shiki";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry } from "@/lib/api";
import { cn } from "@tsukaima/ui/lib/utils";

const LIGHT_THEME = "github-light-high-contrast";
const DARK_THEME = "github-dark-high-contrast";

interface LogToken {
	readonly content: string;
	readonly style: CSSProperties | undefined;
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

const entryTokenCache = new WeakMap<LogEntry, readonly LogToken[]>();

function toLogTokens(line: readonly { content: string; htmlStyle?: Record<string, string> }[]): readonly LogToken[] {
	return line.map((token) => ({
		content: token.content,
		style:
			token.htmlStyle === undefined
				? undefined
				: ({
						...token.htmlStyle,
						"--runtime-log-light-color": token.htmlStyle.color,
					} as CSSProperties),
	}));
}

function useAnsiLogTokens(entries: readonly LogEntry[]): readonly (readonly LogToken[] | undefined)[] {
	const [version, setVersion] = useState(0);

	useEffect(() => {
		const missing = entries.filter((entry) => !entryTokenCache.has(entry));
		if (missing.length === 0) return;
		let cancelled = false;
		void getHighlighter().then((highlighter) => {
			if (cancelled) return;
			const code = missing.map((entry) => entry.ansi).join("\n");
			const result = highlighter.codeToTokens(code, {
				defaultColor: "light",
				lang: "ansi",
				themes: {
					dark: DARK_THEME,
					light: LIGHT_THEME,
				},
			});
			for (const [index, entry] of missing.entries()) {
				const line = result.tokens[index] as
					| readonly { content: string; htmlStyle?: Record<string, string> }[]
					| undefined;
				if (line !== undefined) {
					entryTokenCache.set(entry, toLogTokens(line));
				}
			}
			setVersion((current) => current + 1);
		});
		return () => {
			cancelled = true;
		};
	}, [entries]);

	return useMemo(
		() => entries.map((entry) => entryTokenCache.get(entry)),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[entries, version],
	);
}

export interface LogTerminalProps {
	readonly className?: string;
	readonly emptyLabel: string;
	readonly entries: readonly LogEntry[];
	readonly follow: boolean;
}

export function LogTerminal({ className, emptyLabel, entries, follow }: LogTerminalProps) {
	const viewportRef = useRef<HTMLDivElement>(null);
	const tokens = useAnsiLogTokens(entries);

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
				"bg-log text-foreground",
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
