import { describe, expect, test } from "bun:test";
import {
	fetchGuardedMedia,
	isNonPublicAddress,
	MediaFetchError,
	type MediaDnsResolver,
	type MediaFetchTransport,
} from "../src/services/media-fetch-guard.ts";

const publicResolver: MediaDnsResolver = async () => ["93.184.216.34"];
const failing: MediaFetchTransport = async () => {
	throw new DOMException("timed out", "TimeoutError");
};
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/**
 * Transport double that records every URL *and* the pinned address it was asked to connect to.
 * A handler receives the validated URL and can answer, fail, or inspect the pin.
 */
function transport(
	handler: (
		url: URL,
		address: { readonly address: string; readonly family: 4 | 6 },
	) => Response | Promise<Response>,
) {
	const calls: string[] = [];
	const pins: string[] = [];
	const impl: MediaFetchTransport = async (input) => {
		calls.push(input.url.toString());
		pins.push(input.address.address);
		return await handler(input.url, input.address);
	};
	return { calls, pins, transport: impl };
}

describe("isNonPublicAddress", () => {
	test("rejects loopback, private, link-local, metadata, and IPv6 equivalents", () => {
		for (const address of [
			"127.0.0.1",
			"10.1.2.3",
			"172.16.5.4",
			"192.168.1.1",
			"169.254.169.254",
			"100.64.0.1",
			"0.0.0.0",
			"::1",
			"fe80::1",
			"fd00::1",
			"::ffff:127.0.0.1",
			"not-an-ip",
		]) {
			expect(isNonPublicAddress(address)).toBe(true);
		}
		expect(isNonPublicAddress("93.184.216.34")).toBe(false);
		expect(isNonPublicAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
	});
});

describe("fetchGuardedMedia", () => {
	test("fetches a public image and returns the sniffed content", async () => {
		const remote = transport(
			() =>
				new Response(png, {
					headers: { "content-type": "image/png", "content-length": String(png.length) },
					status: 200,
				}),
		);
		const result = await fetchGuardedMedia("https://example.com/a.png", {
			transport: remote.transport,
			resolve: publicResolver,
		});
		expect(result.mimeType).toBe("image/png");
		expect(result.bytes).toEqual(png);
		expect(result.finalUrl).toBe("https://example.com/a.png");
	});

	test("rejects loopback, metadata, and private destinations before fetching", async () => {
		const remote = transport(() => new Response(png, { status: 200 }));
		for (const url of [
			"http://127.0.0.1/a.png",
			"http://169.254.169.254/latest/meta-data/",
			"http://10.0.0.5/a.png",
			"http://[::1]/a.png",
			"http://localhost/a.png",
			"http://service.internal/a.png",
		]) {
			await expect(
				fetchGuardedMedia(url, { transport: remote.transport, resolve: publicResolver }),
			).rejects.toBeInstanceOf(MediaFetchError);
		}
		expect(remote.calls).toHaveLength(0);
	});

	test("rejects a hostname that resolves to a private address", async () => {
		const remote = transport(() => new Response(png, { status: 200 }));
		await expect(
			fetchGuardedMedia("https://rebind.example/a.png", {
				transport: remote.transport,
				resolve: async () => ["10.0.0.9"],
			}),
		).rejects.toMatchObject({ code: "blocked_address" });
		expect(remote.calls).toHaveLength(0);
	});

	test("rejects non-http schemes, credentials, and non-image content", async () => {
		const remote = transport(
			() => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
		);
		await expect(
			fetchGuardedMedia("file:///etc/passwd", {
				transport: remote.transport,
				resolve: publicResolver,
			}),
		).rejects.toMatchObject({ code: "blocked_scheme" });
		await expect(
			fetchGuardedMedia("https://user:pass@example.com/a.png", {
				transport: remote.transport,
				resolve: publicResolver,
			}),
		).rejects.toMatchObject({ code: "invalid_url" });
		await expect(
			fetchGuardedMedia("https://example.com/page", {
				transport: remote.transport,
				resolve: publicResolver,
			}),
		).rejects.toMatchObject({ code: "blocked_content_type" });
	});

	test("re-validates every redirect and stops at the redirect limit", async () => {
		const remote = transport((url) => {
			if (url.pathname.endsWith("/start")) {
				return new Response(null, { headers: { location: "/hop" }, status: 302 });
			}
			if (url.pathname.endsWith("/hop")) {
				return new Response(null, {
					headers: { location: "http://169.254.169.254/latest" },
					status: 302,
				});
			}
			return new Response(png, { headers: { "content-type": "image/png" } });
		});
		await expect(
			fetchGuardedMedia("https://example.com/start", {
				transport: remote.transport,
				resolve: publicResolver,
			}),
		).rejects.toMatchObject({ code: "invalid_redirect" });
		// The public hop was fetched; the private redirect was rejected before any request to it.
		expect(remote.calls).toEqual(["https://example.com/start", "https://example.com/hop"]);

		const loop = transport(
			() => new Response(null, { headers: { location: "https://example.com/loop" }, status: 302 }),
		);
		await expect(
			fetchGuardedMedia("https://example.com/loop", {
				transport: loop.transport,
				resolve: publicResolver,
			}),
		).rejects.toMatchObject({ code: "redirect_limit" });
	});

	test("rejects a declared or streamed body over the size cap", async () => {
		const declared = transport(
			() =>
				new Response(png, {
					headers: { "content-type": "image/png", "content-length": "999999" },
				}),
		);
		await expect(
			fetchGuardedMedia("https://example.com/a.png", {
				transport: declared.transport,
				policy: { maxBytes: 1024 },
				resolve: publicResolver,
			}),
		).rejects.toMatchObject({ code: "response_too_large" });

		const streamed = transport(
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(600));
							controller.enqueue(new Uint8Array(600));
							controller.close();
						},
					}),
					{ headers: { "content-type": "image/png" } },
				),
		);
		await expect(
			fetchGuardedMedia("https://example.com/a.png", {
				transport: streamed.transport,
				policy: { maxBytes: 1024 },
				resolve: publicResolver,
			}),
		).rejects.toMatchObject({ code: "response_too_large" });
	});

	test("maps transport failures and timeouts to bounded errors", async () => {
		await expect(
			fetchGuardedMedia("https://example.com/a.png", {
				transport: failing,
				resolve: publicResolver,
			}),
		).rejects.toMatchObject({ code: "timeout" });
	});

	test("connects only to the validated address even when DNS rebinds afterwards", async () => {
		// First answer is public, so validation passes; a later lookup returns loopback. The
		// transport must still be pinned to the first answer, never a second resolution.
		let resolutions = 0;
		const rebinding: MediaDnsResolver = async () => {
			resolutions += 1;
			return resolutions === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
		};
		const remote = transport(() => new Response(png, { headers: { "content-type": "image/png" } }));
		const result = await fetchGuardedMedia("https://rebind.example/a.png", {
			resolve: rebinding,
			transport: remote.transport,
		});
		expect(result.mimeType).toBe("image/png");
		expect(resolutions).toBe(1);
		expect(remote.pins).toEqual(["93.184.216.34"]);
	});

	test("a redirect to a rebinding host is re-validated and re-pinned per hop", async () => {
		const answers = new Map<string, readonly string[]>([
			["first.example", ["93.184.216.34"]],
			["second.example", ["93.184.216.35"]],
		]);
		const remote = transport((url) =>
			url.hostname === "first.example"
				? new Response(null, { headers: { location: "https://second.example/a.png" }, status: 302 })
				: new Response(png, { headers: { "content-type": "image/png" } }),
		);
		await fetchGuardedMedia("https://first.example/a.png", {
			resolve: async (hostname) => answers.get(hostname) ?? ["10.0.0.1"],
			transport: remote.transport,
		});
		expect(remote.pins).toEqual(["93.184.216.34", "93.184.216.35"]);
	});

	test("rejects a mixed DNS answer that includes a private address", async () => {
		const remote = transport(() => new Response(png, { headers: { "content-type": "image/png" } }));
		await expect(
			fetchGuardedMedia("https://mixed.example/a.png", {
				resolve: async () => ["93.184.216.34", "127.0.0.1"],
				transport: remote.transport,
			}),
		).rejects.toMatchObject({ code: "blocked_address" });
		expect(remote.calls).toHaveLength(0);
	});

	test("fails over to another validated address without re-resolving", async () => {
		let resolutions = 0;
		const attempts: string[] = [];
		const remote: MediaFetchTransport = async (input) => {
			attempts.push(input.address.address);
			if (input.address.address === "93.184.216.34") throw new Error("connect refused");
			return new Response(png, { headers: { "content-type": "image/png" } });
		};
		await fetchGuardedMedia("https://multi.example/a.png", {
			resolve: async () => {
				resolutions += 1;
				return ["93.184.216.34", "93.184.216.35"];
			},
			transport: remote,
		});
		expect(resolutions).toBe(1);
		expect(attempts).toEqual(["93.184.216.34", "93.184.216.35"]);
	});
});
