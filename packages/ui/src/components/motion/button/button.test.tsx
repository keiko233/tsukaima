import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, IconButton } from "./index.tsx";

describe("Button", () => {
	test("renders variants, sizes, and icon slots", () => {
		const html = renderToStaticMarkup(
			<Button
				fullWidth
				leadingIcon={<span>+</span>}
				size="lg"
				trailingIcon={<span>-&gt;</span>}
				variant="danger"
			>
				Delete
			</Button>,
		);
		expect(html).toContain("bg-destructive");
		expect(html).toContain("h-12");
		expect(html).toContain("w-full");
		expect(html).toContain("Delete");
		expect(html.match(/shrink-0/g)).toHaveLength(2);
	});

	test("disables itself and exposes a busy state while loading", () => {
		const html = renderToStaticMarkup(
			<Button loading variant="soft">
				Saving
			</Button>,
		);
		expect(html).toContain("disabled");
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain("animate-spin");
	});

	test("IconButton supplies an accessible name", () => {
		const html = renderToStaticMarkup(
			<IconButton label="Refresh" size="sm" variant="ghost">
				<span>R</span>
			</IconButton>,
		);
		expect(html).toContain('aria-label="Refresh"');
		expect(html).toContain("h-7");
	});
});
