"use client";

import { useMutation } from "@tanstack/react-query";
import {
	ArrowDownToLine,
	Circle,
	Search,
	Terminal,
	Trash2,
	X,
} from "lucide-react";
import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent,
} from "react";
import { Button, IconButton } from "@elaina/ui/components/motion/button";
import { Input } from "@elaina/ui/components/motion/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@elaina/ui/components/motion/select";
import { logLevels as LOG_LEVELS, orpc, type LogLevel } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { useLogStream } from "@/lib/use-log-stream";
import { cn } from "@elaina/ui/lib/utils";
import { m } from "@/paraglide/messages";
import { LogTerminal } from "@/routes/(system)/_modules/log-terminal";

const HEIGHT_KEY = "elaina.webui.log-panel-height";
const MIN_HEIGHT = 200;
const DEFAULT_HEIGHT = 340;

type LogFilter = "all" | LogLevel;

function storedHeight(): number {
	if (typeof window === "undefined") return DEFAULT_HEIGHT;
	const value = Number(localStorage.getItem(HEIGHT_KEY));
	if (!Number.isFinite(value) || value <= 0) return DEFAULT_HEIGHT;
	return Math.max(MIN_HEIGHT, Math.min(value, window.innerHeight * 0.8));
}

export function LogPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
	const toast = useToast();
	const { capacity, clearLocal, entries, streamState } = useLogStream(open);
	const [search, setSearch] = useState("");
	const [filterLevel, setFilterLevel] = useState<LogFilter>("all");
	const [follow, setFollow] = useState(true);
	const [height, setHeight] = useState(storedHeight);
	const heightRef = useRef(height);
	const resizeRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(
		null,
	);

	const clearLogs = useMutation(
		orpc.admin.diagnostics.clearLogs.mutationOptions({
			onError: (error) =>
				toast.error(m.toast_logs_clear_failed(), { description: errorMessage(error) }),
			onSuccess: ({ cleared }) => {
				clearLocal();
				toast.success(m.toast_logs_cleared(), {
					description: m.toast_logs_cleared_description({ count: cleared }),
				});
			},
		}),
	);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose, open]);

	useEffect(() => {
		const onResize = () =>
			setHeight((current) =>
				Math.max(MIN_HEIGHT, Math.min(current, window.innerHeight * 0.8)),
			);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	const filtered = useMemo(() => {
		const query = search.trim().toLowerCase();
		return entries.filter(
			(entry) =>
				(filterLevel === "all" || entry.level === filterLevel) &&
				(query.length === 0 || entry.text.toLowerCase().includes(query)),
		);
	}, [entries, filterLevel, search]);

	const resize = (next: number) => {
		const bounded = Math.max(MIN_HEIGHT, Math.min(next, window.innerHeight * 0.8));
		heightRef.current = bounded;
		setHeight(bounded);
		return bounded;
	};

	const startResize = (event: PointerEvent<HTMLDivElement>) => {
		resizeRef.current = {
			pointerId: event.pointerId,
			startHeight: height,
			startY: event.clientY,
		};
		event.currentTarget.setPointerCapture(event.pointerId);
	};

	const moveResize = (event: PointerEvent<HTMLDivElement>) => {
		const active = resizeRef.current;
		if (active === null || active.pointerId !== event.pointerId) return;
		resize(active.startHeight + (active.startY - event.clientY));
	};

	const endResize = () => {
		if (resizeRef.current === null) return;
		resizeRef.current = null;
		localStorage.setItem(HEIGHT_KEY, String(heightRef.current));
	};

	const resizeByKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
		event.preventDefault();
		const next = resize(height + (event.key === "ArrowUp" ? 24 : -24));
		localStorage.setItem(HEIGHT_KEY, String(next));
	};

	if (!open) return null;

	const streamLabel =
		streamState === "live"
			? m.diagnostics_logs_live()
			: streamState === "reconnecting"
				? m.diagnostics_logs_reconnecting()
				: m.diagnostics_logs_connecting();

	return (
		<section
			aria-label={m.logs_title()}
			className="fixed inset-x-0 bottom-0 z-40 flex flex-col overflow-hidden border-t border-border bg-background/95 shadow-[0_-24px_60px_-24px_rgb(0_0_0/0.5)] backdrop-blur-xl"
			style={{ height }}
		>
			<div
				role="separator"
				aria-label={m.logs_resize()}
				aria-orientation="horizontal"
				aria-valuenow={height}
				tabIndex={0}
				onPointerDown={startResize}
				onPointerMove={moveResize}
				onPointerUp={endResize}
				onPointerCancel={endResize}
				onKeyDown={resizeByKeyboard}
				className="absolute inset-x-0 top-0 z-10 h-1.5 cursor-row-resize touch-none outline-none hover:bg-primary/25 focus-visible:bg-primary/30"
			/>
			<header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 pl-4">
				<div className="flex min-w-0 items-center gap-2">
					<Terminal className="size-4 text-muted-foreground" />
					<h2 className="text-xs font-semibold tracking-wide">{m.logs_title()}</h2>
					<kbd className="hidden rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">
						{m.logs_shortcut()}
					</kbd>
				</div>
				<span
					className={cn(
						"inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
						streamState === "live"
							? "border-success/30 bg-success/10 text-success"
							: "border-border text-muted-foreground",
					)}
				>
					<Circle
						className={cn(
							"size-1.5 fill-current",
							streamState === "live" && "animate-pulse",
						)}
					/>
					{streamLabel}
				</span>
				<div className="ml-auto flex flex-wrap items-center gap-1.5">
					<Input
						aria-label={m.logs_search()}
						classNames={{
							field: "h-8 bg-background/60",
							input: "text-xs",
							root: "w-36 gap-0 sm:w-52",
						}}
						leftIcon={<Search />}
						placeholder={m.logs_search()}
						value={search}
						onChange={setSearch}
					/>
					<Select
						value={filterLevel}
						onValueChange={(value) => setFilterLevel(value as LogFilter)}
					>
						<SelectTrigger className="h-8 w-32 text-xs">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">{m.diagnostics_logs_all_levels()}</SelectItem>
							{LOG_LEVELS.map((level) => (
								<SelectItem key={level} value={level}>
									{level}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Button
						aria-pressed={follow}
						leadingIcon={<ArrowDownToLine />}
						size="xs"
						variant={follow ? "secondary" : "ghost"}
						onClick={() => setFollow((value) => !value)}
					>
						<span className="hidden sm:inline">{m.diagnostics_logs_follow()}</span>
					</Button>
					<IconButton
						label={m.diagnostics_logs_clear()}
						className="size-7"
						disabled={clearLogs.isPending || entries.length === 0}
						size="sm"
						onClick={() => clearLogs.mutate()}
					>
						<Trash2 />
					</IconButton>
					<IconButton
						label={m.logs_close()}
						className="size-7"
						size="sm"
						onClick={onClose}
					>
						<X />
					</IconButton>
				</div>
			</header>
			<div className="dark flex min-h-0 flex-1 flex-col bg-[#0a0c10]">
				<LogTerminal
					className="min-h-0 max-h-none flex-1 rounded-none border-0"
					emptyLabel={m.diagnostics_logs_empty()}
					entries={filtered}
					follow={follow}
				/>
			</div>
			<footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
				<span>
					{m.diagnostics_logs_buffer({
						capacity,
						count: entries.length,
					})}
				</span>
				<span className="flex items-center gap-3">
					{filtered.length !== entries.length ? (
						<span>{m.diagnostics_logs_filtered({ count: filtered.length })}</span>
					) : null}
					<span className="font-mono">ansi</span>
				</span>
			</footer>
		</section>
	);
}
