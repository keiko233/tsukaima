const timeFormatter = new Intl.DateTimeFormat(undefined, {
	hour: "2-digit",
	minute: "2-digit",
});

const dayFormatter = new Intl.DateTimeFormat(undefined, {
	day: "2-digit",
	month: "short",
});

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "short",
});

export function formatTimestamp(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	const now = new Date();
	if (date.toDateString() === now.toDateString()) return timeFormatter.format(date);
	if (date.getFullYear() === now.getFullYear()) return dayFormatter.format(date);
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export function formatDateTime(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return dateTimeFormatter.format(date);
}

export function previewText(value: string | null | undefined, fallback: string): string {
	if (value === null || value === undefined || value.trim().length === 0) return fallback;
	return value.replace(/\s+/g, " ").trim();
}
