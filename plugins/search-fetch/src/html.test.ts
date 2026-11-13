import { describe, expect, test } from "bun:test";
import { decodeEntities, extractHtmlContent, htmlToText } from "./html.ts";

describe("HTML extraction", () => {
	test("strips scripts, styles, navigation, headers, footers, and comments", () => {
		const html = `<!doctype html>
<html lang="en"><head>
<title>Elaina &amp; friends</title>
<meta name="description" content="A safe &amp; concise page">
<script>window.secret = "do-not-return";</script>
<style>.hidden { display: none; }</style>
</head><body>
<!-- private comment -->
<header>Site header</header>
<nav>Navigation</nav>
<main>
  <h1>Hello&nbsp;world</h1>
  <p>Useful&nbsp;text &lt;safe&gt; &amp; entities &#169;.</p>
</main>
<aside>Sidebar</aside>
<footer>Footer text</footer>
<noscript>Enable JavaScript</noscript>
</body></html>`;
		const text = htmlToText(html);
		expect(text).toContain("Hello world");
		expect(text).toContain("Useful text <safe> & entities ©");
		for (const forbidden of [
			"do-not-return",
			"display: none",
			"Site header",
			"Navigation",
			"Sidebar",
			"Footer text",
			"Enable JavaScript",
			"private comment",
		]) {
			expect(text).not.toContain(forbidden);
		}
		const extracted = extractHtmlContent(html);
		expect(extracted.title).toBe("Elaina & friends");
		expect(extracted.description).toBe("A safe & concise page");
		expect(extracted.language).toBe("en");
	});

	test("decodes numeric and named entities without double-decoding markup", () => {
		expect(decodeEntities("&lt;b&gt; &amp; &#x41; &#66;")).toBe("<b> & A B");
		expect(decodeEntities("&unknown;")).toBe("&unknown;");
	});

	test("normalizes whitespace", () => {
		expect(htmlToText("<p>a\n\n   b\tc</p>")).toBe("a b c");
	});
});
