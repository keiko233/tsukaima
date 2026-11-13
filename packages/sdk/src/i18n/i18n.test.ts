import { describe, expect, test } from "bun:test";
import { bindParaglide, createDictionaryI18n, statusText } from "./index.ts";

const defaultLocale = () => "en";

describe("plugin i18n", () => {
	test("resolves locale, falls back to the base locale, then the key", () => {
		const source = createDictionaryI18n({
			baseLocale: "en",
			locales: ["en", "zh-cn"],
			messages: {
				en: { greeting: "Hello {name}", only_en: "English only" },
				"zh-cn": { greeting: "你好 {name}" },
			},
		});

		const zh = source.bind("zh-cn");
		expect(zh.locale).toBe("zh-cn");
		expect(zh.t("greeting", { name: "Elaina" })).toBe("你好 Elaina");
		expect(zh.t("only_en")).toBe("English only");
		expect(zh.t("missing_key")).toBe("missing_key");
		expect(source.bind("fr").locale).toBe("en");
	});

	test("formats numbers and dates for the bound locale", () => {
		const source = createDictionaryI18n({
			messages: { en: {}, "zh-cn": {} },
		});
		expect(source.bind("en").formatNumber(1234.5)).toBe("1,234.5");
		expect(source.bind("en").formatDate(Date.UTC(2026, 0, 2))).toContain("2026");
	});

	test("binds Paraglide messages to the host locale and pins the runtime getter", () => {
		let getLocale: () => string = defaultLocale;
		const runtime = {
			overwriteGetLocale: (fn: () => string) => {
				getLocale = fn;
			},
			overwriteSetLocale: () => {},
		};
		const source = bindParaglide({
			baseLocale: "en",
			locales: ["en", "zh-cn"],
			messages: {
				greeting: () => (getLocale() === "zh-cn" ? "你好" : "Hello"),
			},
			runtime: runtime as never,
		});
		expect(source.bind("zh-cn").t("greeting")).toBe("你好");
		expect(source.bind("en").t("greeting")).toBe("Hello");
	});
});

describe("statusText", () => {
	test("localizes a status code and falls back to the summary", () => {
		const i18n = createDictionaryI18n({
			messages: { en: { status_ok: "Connected" } },
		}).bind("en");
		expect(statusText(i18n, { code: "status_ok", summary: "raw" })).toBe("Connected");
		expect(statusText(i18n, { code: "unknown_code", summary: "raw" })).toBe("raw");
		expect(statusText(i18n, null)).toBeUndefined();
	});
});
