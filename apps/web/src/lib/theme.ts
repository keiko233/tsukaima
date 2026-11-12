const THEME_KEY = "tsukaima.webui.theme";

export type Theme = "light" | "dark";

export function getInitialTheme(): Theme {
	const stored = localStorage.getItem(THEME_KEY);
	if (stored === "light" || stored === "dark") return stored;
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: Theme): void {
	document.documentElement.classList.toggle("dark", theme === "dark");
	localStorage.setItem(THEME_KEY, theme);
}

export function initializeTheme(): void {
	const theme = getInitialTheme();
	document.documentElement.classList.toggle("dark", theme === "dark");
}
