import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@/paraglide/messages", () => ({
	m: {
		composer_placeholder: () => "Type a message...",
		composer_reference_placeholder: () => "Search sessions...",
		composer_reference_remove: () => "Remove reference",
		delivery_mode: () => "Delivery mode",
		delivery_mode_follow_up: () => "Follow-up",
		delivery_mode_follow_up_hint: () => "Wait for the current turn to finish, then run separately.",
		delivery_mode_interrupt: () => "Interrupt",
		delivery_mode_interrupt_hint: () =>
			"Stop the current generation immediately and answer this now.",
		delivery_mode_steer: () => "Steer",
		delivery_mode_steer_hint: () => "Inject into the active run after the current step finishes.",
		loading: () => "Loading...",
		workspace_reference_insert: () => "Reference session",
		workspace_references_empty: () => "No matching sessions.",
	},
}));

mock.module("@/lib/api", () => ({
	orpc: {
		admin: {
			sessions: {
				search: {
					queryOptions: () => ({
						queryFn: async () => [],
						queryKey: ["admin", "sessions", "search"],
					}),
				},
			},
		},
	},
}));

const { MessageComposer } = await import("./message-composer");

const originalLocalStorage = globalThis.localStorage;

beforeEach(() => {
	const store = new Map<string, string>();
	globalThis.localStorage = {
		clear: () => store.clear(),
		getItem: (key: string) => store.get(key) ?? null,
		key: (index: number) => [...store.keys()][index] ?? null,
		get length() {
			return store.size;
		},
		removeItem: (key: string) => {
			store.delete(key);
		},
		setItem: (key: string, value: string) => {
			store.set(key, value);
		},
	};
});

afterEach(() => {
	globalThis.localStorage = originalLocalStorage;
});

function renderComposer() {
	const client = new QueryClient();
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<MessageComposer
				disabled={false}
				onSend={async () => {
					throw new Error("not expected in static render");
				}}
				sending={false}
				sessionId="session-1"
			/>
		</QueryClientProvider>,
	);
}

describe("MessageComposer", () => {
	test("renders delivery controls without an explanatory hint", () => {
		const html = renderComposer();
		expect(html).toContain("Steer");
		expect(html).toContain("Reference session");
		expect(html).not.toContain("Describe the task");
	});

	test("migrates a stored queue mode to steer", () => {
		localStorage.setItem("tsukaima.webui.delivery-mode.session-1", "queue");
		const html = renderComposer();
		expect(html).toContain("Steer");
		expect(html).not.toContain("Queue");
		expect(localStorage.getItem("tsukaima.webui.delivery-mode.session-1")).toBe("steer");
	});
});
