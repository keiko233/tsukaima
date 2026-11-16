"use client";

import { AnimatePresence, type HTMLMotionProps, motion, useReducedMotion } from "motion/react";
import {
	forwardRef,
	type PointerEvent,
	type ReactNode,
	useCallback,
	useRef,
	useState,
} from "react";
import { EASE_OUT, SPRING_PRESS } from "@tsukaima/ui/lib/ease";
import { useHoverCapable } from "@tsukaima/ui/lib/hooks/use-hover-capable";
import { cn } from "@tsukaima/ui/lib/utils";

export type ButtonVariant =
	| "primary"
	| "secondary"
	| "outline"
	| "ghost"
	| "danger"
	| "soft"
	| "link";
export type ButtonSize = "xs" | "sm" | "md" | "lg" | "icon" | "iconSm" | "iconLg";

export interface ButtonProps extends Omit<HTMLMotionProps<"button">, "children"> {
	variant?: ButtonVariant;
	size?: ButtonSize;
	pressScale?: number;
	/** Spawn a Material-style ripple from the press point. Off by default. */
	ripple?: boolean;
	/** Replaces the leading content with a spinner and disables the button. */
	loading?: boolean;
	leadingIcon?: ReactNode;
	trailingIcon?: ReactNode;
	fullWidth?: boolean;
	children?: ReactNode;
}

export interface ButtonLinkProps extends Omit<HTMLMotionProps<"a">, "children"> {
	variant?: ButtonVariant;
	size?: ButtonSize;
	pressScale?: number;
	leadingIcon?: ReactNode;
	trailingIcon?: ReactNode;
	fullWidth?: boolean;
	children?: ReactNode;
}

type Ripple = { id: number; x: number; y: number; size: number };

const VARIANT_CLASS: Record<ButtonVariant, string> = {
	primary: "bg-primary text-primary-foreground hover:bg-primary/90",
	secondary: "border border-border bg-card text-foreground hover:bg-card/80",
	ghost: "text-muted-foreground hover:text-foreground hover:bg-muted/60",
	outline: "border border-border bg-transparent text-foreground hover:bg-muted/60",
	danger: "bg-destructive text-white hover:bg-destructive/90",
	soft: "bg-primary/10 text-primary hover:bg-primary/15",
	link: "text-primary underline-offset-4 hover:underline",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
	xs: "h-6 px-2 text-[11px] gap-1 rounded-md",
	sm: "h-7 px-2.5 text-[12px] gap-1.5 rounded-md",
	md: "h-8 px-3.5 text-[13px] gap-1.5 rounded-lg",
	lg: "h-10 px-5 text-sm gap-2 rounded-lg",
	icon: "h-8 w-8 rounded-md",
	iconSm: "h-6 w-6 rounded-md",
	iconLg: "h-9 w-9 rounded-lg",
};

const ICON_SIZE_CLASS: Record<ButtonSize, string> = {
	xs: "[&>svg]:size-3.5",
	sm: "[&>svg]:size-3.5",
	md: "[&>svg]:size-4",
	lg: "[&>svg]:size-5",
	icon: "[&>svg]:size-4",
	iconSm: "[&>svg]:size-3.5",
	iconLg: "[&>svg]:size-5",
};

function spinner() {
	return (
		<span
			aria-hidden="true"
			className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent"
		/>
	);
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
	{
		variant = "primary",
		size = "md",
		pressScale = 0.93,
		ripple = false,
		loading = false,
		leadingIcon,
		trailingIcon,
		fullWidth = false,
		className,
		children,
		disabled,
		onPointerDown,
		...rest
	},
	ref,
) {
	const reduce = useReducedMotion();
	const canHover = useHoverCapable();
	const [ripples, setRipples] = useState<Ripple[]>([]);
	const nextId = useRef(0);

	const handlePointerDown = useCallback(
		(event: PointerEvent<HTMLButtonElement>) => {
			if (ripple && !reduce) {
				const rect = event.currentTarget.getBoundingClientRect();
				const rippleSize = Math.max(rect.width, rect.height) * 2;
				const id = nextId.current++;
				setRipples((prev) => [
					...prev,
					{
						id,
						x: event.clientX - rect.left,
						y: event.clientY - rect.top,
						size: rippleSize,
					},
				]);
			}
			onPointerDown?.(event);
		},
		[ripple, reduce, onPointerDown],
	);

	return (
		<motion.button
			ref={ref}
			type="button"
			whileTap={reduce ? undefined : { scale: pressScale }}
			whileHover={reduce || !canHover ? undefined : { scale: 1.02 }}
			transition={SPRING_PRESS}
			onPointerDown={handlePointerDown}
			className={cn(
				"inline-flex items-center justify-center font-medium select-none",
				"transition-colors",
				"disabled:pointer-events-none disabled:opacity-50",
				ripple && "relative overflow-hidden",
				VARIANT_CLASS[variant],
				SIZE_CLASS[size],
				variant === "link" && "h-auto rounded-none px-0",
				fullWidth && "w-full",
				className,
			)}
			disabled={disabled || loading}
			aria-busy={loading || undefined}
			{...rest}
		>
			{ripple && !reduce ? (
				<span className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
					<AnimatePresence>
						{ripples.map((r) => (
							<motion.span
								key={r.id}
								className="absolute rounded-full bg-current"
								style={{
									left: r.x,
									top: r.y,
									width: r.size,
									height: r.size,
									x: "-50%",
									y: "-50%",
								}}
								initial={{ scale: 0.05, opacity: 0.3 }}
								animate={{ scale: 1, opacity: 0 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 1.6, ease: EASE_OUT }}
								onAnimationComplete={() => setRipples((prev) => prev.filter((x) => x.id !== r.id))}
							/>
						))}
					</AnimatePresence>
				</span>
			) : null}
			{loading ? spinner() : null}
			{!loading && leadingIcon ? (
				<span className={cn("shrink-0", ICON_SIZE_CLASS[size])}>{leadingIcon}</span>
			) : null}
			{children}
			{trailingIcon ? (
				<span className={cn("shrink-0", ICON_SIZE_CLASS[size])}>{trailingIcon}</span>
			) : null}
		</motion.button>
	);
});

export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(function ButtonLink(
	{
		variant = "primary",
		size = "md",
		pressScale = 0.93,
		leadingIcon,
		trailingIcon,
		fullWidth = false,
		className,
		children,
		...rest
	},
	ref,
) {
	const reduce = useReducedMotion();
	const canHover = useHoverCapable();

	return (
		<motion.a
			ref={ref}
			whileTap={reduce ? undefined : { scale: pressScale }}
			whileHover={reduce || !canHover ? undefined : { scale: 1.02 }}
			transition={SPRING_PRESS}
			className={cn(
				"inline-flex items-center justify-center font-medium select-none",
				"transition-colors",
				VARIANT_CLASS[variant],
				SIZE_CLASS[size],
				variant === "link" && "h-auto rounded-none px-0",
				fullWidth && "w-full",
				className,
			)}
			{...rest}
		>
			{leadingIcon ? (
				<span className={cn("shrink-0", ICON_SIZE_CLASS[size])}>{leadingIcon}</span>
			) : null}
			{children}
			{trailingIcon ? (
				<span className={cn("shrink-0", ICON_SIZE_CLASS[size])}>{trailingIcon}</span>
			) : null}
		</motion.a>
	);
});

export interface IconButtonProps
	extends Omit<ButtonProps, "children" | "size" | "leadingIcon" | "trailingIcon"> {
	/** Accessible name; icon-only controls have no visible label. */
	label: string;
	size?: "sm" | "md" | "lg";
	children: ReactNode;
}

export function IconButton({
	label,
	size = "md",
	variant = "ghost",
	className,
	children,
	...rest
}: IconButtonProps) {
	return (
		<Button
			aria-label={label}
			className={cn(
				"p-0",
				size === "sm"
					? "[&_svg]:size-3.5"
					: size === "lg"
						? "[&_svg]:size-5"
						: "[&_svg]:size-4",
				className,
			)}
			size={size === "sm" ? "iconSm" : size === "lg" ? "iconLg" : "icon"}
			variant={variant}
			{...rest}
		>
			{children}
		</Button>
	);
}
