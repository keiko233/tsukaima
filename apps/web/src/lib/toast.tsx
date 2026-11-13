"use client";

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
} from "react";
import {
	AnimatedToastStack,
	type ToastInput,
	type ToastStatus,
	useAnimatedToastStack,
} from "@tsukaima/ui/components/motion/animated-toast-stack";
import { m } from "@/paraglide/messages";

type ToastOptions = Omit<ToastInput, "status" | "title">;

export interface ToastApi {
	show: (input: ToastInput) => string;
	success: (title: ReactNode, options?: ToastOptions) => string;
	error: (title: ReactNode, options?: ToastOptions) => string;
	info: (title: ReactNode, options?: ToastOptions) => string;
	loading: (title: ReactNode, options?: ToastOptions) => string;
	dismiss: (id: string) => void;
	update: (id: string, patch: Partial<ToastInput>) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function ToastProvider({ children }: { children: ReactNode }) {
	const stack = useAnimatedToastStack({ limit: 5 });
	const popoverRef = useRef<HTMLDivElement>(null);
	const show = useCallback(
		(status: ToastStatus) => {
			return (title: ReactNode, options: ToastOptions = {}) =>
				stack.showToast({ ...options, status, title });
		},
		[stack.showToast],
	);
	const success = useMemo(() => show("success"), [show]);
	const error = useMemo(() => show("error"), [show]);
	const info = useMemo(() => show("info"), [show]);
	const loading = useMemo(() => show("loading"), [show]);
	const api = useMemo<ToastApi>(
		() => ({
			dismiss: stack.dismissToast,
			error,
			info,
			loading,
			show: stack.showToast,
			success,
			update: stack.updateToast,
		}),
		[error, info, loading, stack.dismissToast, stack.showToast, stack.updateToast, success],
	);

	useEffect(() => {
		const node = popoverRef.current;
		if (!node) return;
		const isOpen = node.matches(":popover-open");
		if (stack.toasts.length === 0) {
			if (isOpen) node.hidePopover();
			return;
		}
		if (isOpen) node.hidePopover();
		node.showPopover();
	}, [stack.toasts.length]);

	return (
		<ToastContext.Provider value={api}>
			{children}
			<div
				ref={popoverRef}
				popover="manual"
				className="pointer-events-none fixed inset-0 m-0 h-auto max-h-none w-auto max-w-none overflow-visible border-0 bg-transparent p-0"
			>
				<AnimatedToastStack
					toasts={stack.toasts}
					onDismiss={stack.dismissToast}
					labels={{ dismiss: m.toast_dismiss() }}
					placement="fixed"
					position="bottom-center"
					portal={false}
					maxVisible={5}
				/>
			</div>
		</ToastContext.Provider>
	);
}

export function useToast(): ToastApi {
	const value = useContext(ToastContext);
	if (value === null) throw new Error("useToast must be used within ToastProvider");
	return value;
}
