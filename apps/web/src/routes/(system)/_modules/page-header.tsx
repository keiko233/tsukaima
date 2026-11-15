import type { ReactNode } from "react";

export function SystemPageHeader({ description, title }: { description: string; title: string }) {
	return (
		<header className="mb-4 flex items-start justify-between gap-4">
			<div>
				<h1 className="text-[17px] font-semibold tracking-tight">{title}</h1>
				<p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">{description}</p>
			</div>
		</header>
	);
}

export function SystemPage({
	children,
	title,
	description,
	fill = false,
}: {
	children: ReactNode;
	description: string;
	fill?: boolean;
	title: string;
}) {
	if (fill) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<SystemPageHeader description={description} title={title} />
				<div className="flex min-h-0 flex-1 flex-col">{children}</div>
			</div>
		);
	}

	return (
		<div>
			<SystemPageHeader description={description} title={title} />
			{children}
		</div>
	);
}
