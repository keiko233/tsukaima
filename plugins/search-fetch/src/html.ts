const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	apos: "'",
	cent: "¢",
	copy: "©",
	deg: "°",
	gt: ">",
	hellip: "…",
	laquo: "«",
	ldquo: "“",
	lsquo: "‘",
	lt: "<",
	mdash: "—",
	nbsp: " ",
	ndash: "–",
	quot: '"',
	raquo: "»",
	rdquo: "”",
	reg: "®",
	rsquo: "’",
	times: "×",
	trade: "™",
};

/** Decode the common HTML entities that appear in search snippets and page text. */
export function decodeEntities(input: string): string {
	return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/giu, (match, entity: string) => {
		if (entity.startsWith("#")) {
			const hex = entity[1]?.toLowerCase() === "x";
			const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
			if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return match;
			try {
				return String.fromCodePoint(value);
			} catch {
				return match;
			}
		}
		return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
	});
}

export function stripTags(input: string): string {
	return decodeEntities(
		input
			.replace(/<!\[CDATA\[/giu, "")
			.replace(/\]\]>/gu, "")
			.replace(/<[^>]*>/gu, " "),
	)
		.replace(/\s+/gu, " ")
		.trim();
}

export interface ExtractedContent {
	readonly description?: string;
	readonly language?: string;
	readonly text: string;
	readonly title: string;
}

const REMOVED_BLOCKS =
	/<(script|style|noscript|nav|header|footer|aside|iframe|svg|template|form|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;

/** Remove non-content containers, comments, metadata, and remaining markup. */
export function htmlToText(html: string): string {
	const withoutBlocks = html
		.replace(/<!--[\s\S]*?-->/gu, " ")
		.replace(/<!doctype[^>]*>/giu, " ")
		.replace(REMOVED_BLOCKS, " ")
		.replace(/<(?:head|meta|link)\b[^>]*>[\s\S]*?<\/head\s*>/giu, " ")
		.replace(/<(meta|link|base|input|source|track|wbr)\b[^>]*\/?>/giu, " ");
	return stripTags(withoutBlocks);
}

function readTitle(html: string): string {
	const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu.exec(html);
	return match?.[1] === undefined ? "" : stripTags(match[1]);
}

function readMeta(html: string, names: readonly string[]): string | undefined {
	const wanted = new Set(names);
	for (const tag of html.match(/<meta\b[^>]*>/giu) ?? []) {
		const name = /\b(?:name|property)\s*=\s*["']([^"']+)["']/iu.exec(tag)?.[1]?.toLowerCase() ?? "";
		if (!wanted.has(name)) continue;
		const content = /\bcontent\s*=\s*["']([\s\S]*?)["']/iu.exec(tag)?.[1];
		if (content !== undefined && content.trim().length > 0) return stripTags(content);
	}
	return undefined;
}

export function extractHtmlContent(html: string): ExtractedContent {
	const title = readTitle(html);
	const description = readMeta(html, ["description", "og:description"]);
	const language = /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/iu.exec(html)?.[1]?.trim();
	return {
		...(description === undefined ? {} : { description }),
		...(language === undefined || language.length === 0 ? {} : { language }),
		text: htmlToText(html),
		title,
	};
}
