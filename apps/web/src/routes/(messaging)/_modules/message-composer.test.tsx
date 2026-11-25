import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@/paraglide/messages", () => ({
	m: {
		channel_not_connected: () => "Channel is not connected.",
		composer_hint_channel: () => "This sends directly to the external chat.",
		composer_hint_tsukaima: () => "This creates a Tsukaima turn in this session only.",
		composer_hint_workspace: () => "This runs in the workspace session.",
		composer_placeholder: () => "Type a message...",
		composer_reference_placeholder: () => "Search sessions...",
		composer_reference_remove: () => "Remove reference",
		delivery_mode: () => "Delivery mode",
		delivery_mode_follow_up: () => "Follow-up",
		delivery_mode_follow_up_hint: () => "Wait for the current turn to finish, then run separately.",
		delivery_mode_interrupt: () => "Interrupt",
		delivery_mode_interrupt_hint: () => "Stop the current generation immediately and answer this now.",
		delivery_mode_steer: () => "Steer",
		delivery_mode_steer_hint: () => "Inject into the active run after the current step finishes.",
		loading: () => "Loading...",
		send_to_channel: () => "Send to channel",
		send_to_tsukaima: () => "Talk to Tsukaima",
		session_target: () => "Destination",
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

function renderComposer(props: {
	channelConnected: boolean;
	externalEligible: boolean;
	workspace?: boolean;
}) {
	const client = new QueryClient();
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<MessageComposer
				channelConnected={props.channelConnected}
				disabled={false}
				externalEligible={props.externalEligible}
				onSend={async () => {
					throw new Error("not expected in static render");
				}}
				sending={false}
				sessionId="session-1"
				workspace={props.workspace}
			/>
		</QueryClientProvider>,
	);
}

describe("MessageComposer", () => {
	test("hides the Tsukaima target selector and shows only channel hint for external chats", () => {
		const html = renderComposer({ channelConnected: true, externalEligible: true });
		expect(html).not.toContain("Talk to Tsukaima");
		expect(html).not.toContain("Steer");
		expect(html).toContain("This sends directly to the external chat.");
	});

	test("shows channel disconnected hint when external chat channel is offline", () => {
		const html = renderComposer({ channelConnected: false, externalEligible: true });
		expect(html).not.toContain("Talk to Tsukaima");
		expect(html).toContain("Channel is not connected.");
	});

	test("defaults to steer and keeps the delivery mode selector for non-external chats", () => {
		const html = renderComposer({ channelConnected: false, externalEligible: false });
		expect(html).toContain("Steer");
		expect(html).toContain("Inject into the active run after the current step finishes.");
		expect(html).toContain("This creates a Tsukaima turn in this session only.");
	});

	test("migrates a stored queue mode to steer", () => {
		localStorage.setItem("tsukaima.webui.delivery-mode.session-1", "queue");
		const html = renderComposer({ channelConnected: false, externalEligible: false });
		expect(html).toContain("Steer");
		expect(html).not.toContain("Queue");
		expect(localStorage.getItem("tsukaima.webui.delivery-mode.session-1")).toBe("steer");
	});
});
