import { getLocale, setLocale, type Locale } from "@/paraglide/runtime";

function documentLanguage(locale: Locale): string {
	return locale === "zh-cn" ? "zh-CN" : "en";
}

export function initializeLocale(): void {
	document.documentElement.lang = documentLanguage(getLocale());
}

export function applyLocale(locale: Locale): void {
	document.documentElement.lang = documentLanguage(locale);
	setLocale(locale);
}
