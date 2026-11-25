import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { PluginPage, PluginSection, StatGrid } from "../../../../sdk/src/ui/index.tsx";
import {
	Disclosure,
	DisclosurePanel,
	DisclosureTrigger,
	EditorialDialog,
	EditorialDialogClose,
	EditorialDialogContent,
	EditorialDialogDescription,
	EditorialDialogTitle,
	EditorialDialogTrigger,
	EditorialGroup,
	EditorialPageHeader,
	EditorialPopover,
	EditorialPopoverClose,
	EditorialPopoverContent,
	EditorialPopoverDescription,
	EditorialPopoverTitle,
	EditorialPopoverTrigger,
	EditorialSelect,
	EditorialSelectContent,
	EditorialSelectItem,
	EditorialSelectTrigger,
	EditorialSelectValue,
	EditorialSwitch,
	EditorialTabs,
	EditorialTabsContent,
	EditorialTabsList,
	EditorialTabsTrigger,
	ExpandableRow,
	KpiStrip,
	PreferenceRow,
	SegmentedControl,
} from "../../index.ts";

describe("editorial server rendering", () => {
	test("renders selected tabs, checked controls and visible preference text", () => {
		const html = renderToString(
			<EditorialTabs value="general">
				<EditorialPageHeader
					eyebrow="Settings"
					title="Preferences"
					meta="Personal"
					tabs={
						<EditorialTabsList aria-label="Settings pages">
							<EditorialTabsTrigger value="general">General</EditorialTabsTrigger>
							<EditorialTabsTrigger value="advanced">Advanced</EditorialTabsTrigger>
						</EditorialTabsList>
					}
				/>
				<EditorialTabsContent value="general">
					<EditorialGroup title="Appearance">
						<PreferenceRow htmlFor="digest" label="Digest" hint="Send a weekly summary">
							<EditorialSwitch id="digest" defaultChecked />
						</PreferenceRow>
						<SegmentedControl
							aria-label="Theme"
							value="paper"
							onValueChange={() => {}}
							options={[
								{ value: "paper", label: "Warm Paper" },
								{ value: "ink", label: "Deep Ink" },
							]}
						/>
						<KpiStrip items={[{ label: "Runs", value: 42, tone: "success" }]} />
					</EditorialGroup>
				</EditorialTabsContent>
				<EditorialTabsContent value="advanced">Advanced preferences</EditorialTabsContent>
			</EditorialTabs>,
		);
		expect(html).toContain('<h1 class="font-serif text-2xl text-ink">Preferences</h1>');
		expect(html).toContain('role="tablist"');
		expect(html).toContain('aria-selected="true"');
		expect(html).toContain('role="switch"');
		expect(html).toContain('for="digest"');
		expect(html).toContain("Send a weekly summary");
		expect(html).toContain('aria-checked="true"');
		expect(html).toContain("Warm Paper");
		expect(html).toContain("Deep Ink");
		expect(html).toContain("Runs");
		expect(html).toContain("Advanced preferences");
	});

	test("renders a composed select's localized value before the popup opens", () => {
		const html = renderToStaticMarkup(
			<EditorialSelect defaultValue="paper">
				<EditorialSelectTrigger aria-label="Theme">
					<EditorialSelectValue placeholder="Choose a theme" />
				</EditorialSelectTrigger>
				<EditorialSelectContent>
					<EditorialSelectItem value="paper">Warm Paper</EditorialSelectItem>
					<EditorialSelectItem value="ink" label="Deep Ink">
						<span>Deep Ink</span>
					</EditorialSelectItem>
				</EditorialSelectContent>
			</EditorialSelect>,
		);
		expect(html).toContain('aria-label="Theme"');
		expect(html).toContain('aria-expanded="false"');
		expect(html).toMatch(/data-slot="select-value"[^>]*>Warm Paper<\/span>/);
		expect(html).not.toContain("Deep Ink");
	});

	test("renders disclosure state and a panel with only the accent rail", () => {
		const html = renderToStaticMarkup(
			<>
				<Disclosure open={false}>
					<DisclosureTrigger>Closed summary</DisclosureTrigger>
					<DisclosurePanel>Closed details</DisclosurePanel>
				</Disclosure>
				<ExpandableRow summary="Open summary" defaultOpen>
					Open details
				</ExpandableRow>
			</>,
		);
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain('aria-expanded="true"');
		expect(html).toContain("Closed summary");
		expect(html).not.toContain("Closed details");
		expect(html).toContain("Open details");
		expect(html).toContain("border-s-2 border-accent-ink");
		expect(html).not.toMatch(/\b(?:bg-\S+|rounded-\S+)\b/);
	});

	test("renders open dialogs and popovers with accessible names", () => {
		const html = renderToString(
			<>
				<EditorialDialog defaultOpen>
					<EditorialDialogTrigger>Edit entry</EditorialDialogTrigger>
					<EditorialDialogContent>
						<EditorialDialogTitle>Entry details</EditorialDialogTitle>
						<EditorialDialogDescription>Change the entry</EditorialDialogDescription>
						<EditorialDialogClose>Finish editing</EditorialDialogClose>
					</EditorialDialogContent>
				</EditorialDialog>
				<EditorialPopover defaultOpen>
					<EditorialPopoverTrigger>More</EditorialPopoverTrigger>
					<EditorialPopoverContent>
						<EditorialPopoverTitle>More actions</EditorialPopoverTitle>
						<EditorialPopoverDescription>Choose an action</EditorialPopoverDescription>
						<EditorialPopoverClose>Close actions</EditorialPopoverClose>
					</EditorialPopoverContent>
				</EditorialPopover>
			</>,
		);
		expect(html).toContain('role="dialog"');
		expect(html).toContain("Edit entry");
		expect(html).toContain("Entry details");
		expect(html).toContain("Change the entry");
		expect(html).toContain("Finish editing");
		expect(html).toContain("More actions");
		expect(html).toContain("Choose an action");
		expect(html).toContain("Close actions");
	});
});

test("plugin sections and KPI strips use hairlines and retain embedded titles in SSR", () => {
	const html = renderToStaticMarkup(
		<PluginPage title="Panel title">
			<PluginSection title="Service status">
				<StatGrid
					items={[
						{ label: "Requests", value: 42 },
						{ label: "Retries", value: 0 },
					]}
				/>
			</PluginSection>
		</PluginPage>,
	);
	expect(html).toContain('<h2 class="sr-only">Panel title</h2>');
	expect(html).toContain("Service status");
	expect(html).toContain("Requests");
	expect(html).toContain("Retries");
	expect(html).toContain("divide-border");
	expect(html).toContain("font-serif text-xl tabular-nums");
	expect(html).not.toMatch(/rounded-xl|bg-card/);
	expect(
		renderToStaticMarkup(
			<PluginPage embedded={false} title="Standalone">
				{null}
			</PluginPage>,
		),
	).toContain('<h2 class="font-serif text-2xl text-ink">Standalone</h2>');
});
