/**
 * Plugin i18n.
 *
 * The host locale is owned by the admin WebUI. A plugin can bind its own Paraglide
 * runtime (preferred) or provide plain dictionaries. Both paths produce the same
 * `PluginI18n` object, so panels never read a global locale store directly.
 */

export type PluginLocaleMessages = Record<string, string>;
export type PluginMessageCatalog = Record<string, PluginLocaleMessages>;

export interface PluginI18n {
	readonly locale: string;
	readonly locales: readonly string[];
	t(key: string, params?: Record<string, string | number>): string;
	formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
	formatDate(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string;
}

export interface PluginI18nSource {
	readonly locales: readonly string[];
	readonly baseLocale: string;
	bind(locale: string): PluginI18n;
}

export interface ParaglideRuntimeLike {
	readonly overwriteGetLocale?: (fn: () => never) => void;
	readonly overwriteSetLocale?: (fn: () => void) => void;
}

type ParaglideMessages = Record<
	string,
	((params?: Record<string, string | number>) => string) | string | undefined
>;

export interface BindParaglideOptions {
	readonly messages: ParaglideMessages;
	readonly runtime?: ParaglideRuntimeLike;
	readonly locales?: readonly string[];
	readonly baseLocale?: string;
}

function interpolate(template: string, params?: Record<string, string | number>): string {
	if (params === undefined) return template;
	return template.replace(/\{(\w+)\}/g, (match, name: string) => {
		const value = params[name];
		return value === undefined ? match : String(value);
	});
}

function formatDateValue(
	value: Date | number | string,
	locale: string,
	options?: Intl.DateTimeFormatOptions,
): string {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return String(value);
	return new Intl.DateTimeFormat(locale, options).format(date);
}

function createI18n(
	locale: string,
	locales: readonly string[],
	baseLocale: string,
	resolve: (locale: string, key: string) => string | undefined,
	warnMissing: (key: string) => void,
): PluginI18n {
	const resolved = locales.includes(locale) ? locale : baseLocale;
	return {
		formatDate: (value, options) => formatDateValue(value, resolved, options),
		formatNumber: (value, options) => new Intl.NumberFormat(resolved, options).format(value),
		locale: resolved,
		locales,
		t(key, params) {
			const template = resolve(resolved, key) ?? resolve(baseLocale, key) ?? undefined;
			if (template === undefined) {
				warnMissing(key);
				return key;
			}
			return interpolate(template, params);
		},
	};
}

/**
 * Binds a Paraglide-compiled message catalog to the host locale. The plugin runtime's
 * locale getter is overwritten so any nested Paraglide helpers agree with `t`.
 */
export function bindParaglide(options: BindParaglideOptions): PluginI18nSource {
	const locales = options.locales ?? ["en"];
	const baseLocale = options.baseLocale ?? locales[0] ?? "en";
	let active = baseLocale;
	const missing = new Set<string>();
	const overwriteGetLocale = options.runtime?.overwriteGetLocale as
		| ((fn: () => string) => void)
		| undefined;
	const overwriteSetLocale = options.runtime?.overwriteSetLocale as
		| ((fn: () => void) => void)
		| undefined;
	overwriteGetLocale?.(() => active);
	overwriteSetLocale?.(() => {});

	const warnMissing = (key: string) => {
		if (missing.has(key)) return;
		missing.add(key);
		console.warn(`elaina: missing plugin message "${key}"`);
	};

	return {
		baseLocale,
		locales,
		bind(locale) {
			active = locales.includes(locale) ? locale : baseLocale;
			return createI18n(
				active,
				locales,
				baseLocale,
				(_which, key) => {
					const entry = options.messages[key];
					if (typeof entry === "string") return entry;
					if (typeof entry === "function") {
						try {
							return entry({});
						} catch {
							return undefined;
						}
					}
					return undefined;
				},
				warnMissing,
			);
		},
	};
}

export interface DictionaryI18nOptions {
	readonly messages: PluginMessageCatalog;
	readonly locales?: readonly string[];
	readonly baseLocale?: string;
}

/** Plain-JSON fallback for plugins that do not compile Paraglide messages. */
export function createDictionaryI18n(options: DictionaryI18nOptions): PluginI18nSource {
	const locales = options.locales ?? Object.keys(options.messages);
	const baseLocale = options.baseLocale ?? locales[0] ?? "en";
	const missing = new Set<string>();
	return {
		baseLocale,
		locales,
		bind(locale) {
			const resolved = locales.includes(locale) ? locale : baseLocale;
			return createI18n(
				resolved,
				locales,
				baseLocale,
				(which, key) => options.messages[which]?.[key],
				(key) => {
					if (missing.has(key)) return;
					missing.add(key);
					console.warn(`elaina: missing plugin message "${key}"`);
				},
			);
		},
	};
}

/** Resolves status `code` with the plugin catalog, falling back to the host-provided summary. */
export function statusText(
	i18n: PluginI18n,
	status: { readonly code?: string; readonly summary?: string } | null | undefined,
	params?: Record<string, string | number>,
): string | undefined {
	if (status === null || status === undefined) return undefined;
	if (status.code !== undefined) {
		const value = i18n.t(status.code, params);
		if (value !== status.code) return value;
	}
	return status.summary;
}
