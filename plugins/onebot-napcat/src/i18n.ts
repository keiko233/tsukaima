import { bindParaglide } from "@tsukaima/sdk/i18n";
import { m } from "./paraglide/messages.js";
import * as runtime from "./paraglide/runtime.js";

export const i18n = bindParaglide({
	baseLocale: "en",
	locales: ["en", "zh-cn"],
	messages: m,
	runtime,
});
