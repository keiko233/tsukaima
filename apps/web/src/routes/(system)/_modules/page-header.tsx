import type { ReactNode } from "react";

export function SystemPageHeader({ description, title }: { description: string; title: string }) {
	return (
		<header className="mb-5 flex items-start justify-between gap-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">{title}</h1>
				<p className="mt-1 text-sm text-muted-foreground">{description}</p>
			</div>
		</header>
	);
}

export function SystemPage({
	children,
	title,
	description,
}: {
	children: ReactNode;
	description: string;
	title: string;
}) {
	return (
		<div>
			<SystemPageHeader description={description} title={title} />
			{children}
		</div>
	);
}
