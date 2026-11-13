import { describe, expect, test } from "bun:test";
import {
	assertNoDnsRebinding,
	hostMatches,
	isHostAllowed,
	isNonPublicIp,
	normalizeHost,
	resolvePublicAddresses,
	SafeFetchError,
	validateHttpUrl,
} from "./url-policy.ts";

describe("SSRF URL policy", () => {
	test("accepts public http(s) URLs and strips credentials", () => {
		const target = validateHttpUrl("https://user:secret@example.com/path?q=1");
		expect(target.hostname).toBe("example.com");
		expect(target.url.username).toBe("");
		expect(target.url.password).toBe("");
		expect(target.url.toString()).toBe("https://example.com/path?q=1");
		expect(() => validateHttpUrl("http://8.8.8.8/")).not.toThrow();
	});

	test("rejects non-http schemes", () => {
		for (const url of [
			"file:///etc/passwd",
			"ftp://example.com/a",
			"data:text/html,hello",
			"javascript:alert(1)",
			"gopher://example.com",
		]) {
			expect(() => validateHttpUrl(url)).toThrow(SafeFetchError);
			try {
				validateHttpUrl(url);
			} catch (error) {
				expect((error as SafeFetchError).code).toBe("blocked_scheme");
			}
		}
	});

	test("rejects local names and private IPv4/IPv6 literals", () => {
		for (const url of [
			"http://localhost/",
			"http://printer.local/",
			"http://service.internal/",
			"http://127.0.0.1/",
			"http://10.0.0.5/",
			"http://172.16.2.4/",
			"http://192.168.1.1/",
			"http://169.254.169.254/latest/meta-data",
			"http://100.64.0.1/",
			"http://224.0.0.1/",
			"http://0.0.0.0/",
			"http://[::1]/",
			"http://[fe80::1]/",
			"http://[fc00::1]/",
			"http://[ff02::1]/",
			"http://[::ffff:127.0.0.1]/",
		]) {
			expect(() => validateHttpUrl(url)).toThrow(SafeFetchError);
		}
	});

	test("classifies public and non-public addresses", () => {
		for (const address of [
			"127.0.0.1",
			"10.1.2.3",
			"169.254.1.1",
			"100.100.100.100",
			"224.0.0.1",
			"240.0.0.1",
			"::1",
			"fe80::1",
			"fc00::1",
			"ff02::1",
			"::ffff:10.0.0.1",
			"0.0.0.0",
		]) {
			expect(isNonPublicIp(address)).toBe(true);
		}
		for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
			expect(isNonPublicIp(address)).toBe(false);
		}
	});

	test("matches exact, suffix, and glob domain policy", () => {
		expect(hostMatches("example.com", "example.com")).toBe(true);
		expect(hostMatches("example.com", "docs.example.com")).toBe(true);
		expect(hostMatches("*.example.com", "docs.example.com")).toBe(true);
		expect(hostMatches("*.example.com", "example.com")).toBe(false);
		expect(hostMatches("example.com", "badexample.com")).toBe(false);
		expect(normalizeHost("[::1]")).toBe("::1");
		expect(
			isHostAllowed("docs.example.com", {
				allowDomains: ["example.com"],
				blockDomains: ["private.example.com"],
			}),
		).toBe(true);
		expect(isHostAllowed("private.example.com", { blockDomains: ["private.example.com"] })).toBe(
			false,
		);
		expect(
			isHostAllowed("docs.private.example.com", { blockDomains: ["private.example.com"] }),
		).toBe(false);
		expect(isHostAllowed("other.example.com", { allowDomains: ["example.com"] })).toBe(true);
		expect(isHostAllowed("notexample.com", { allowDomains: ["example.com"] })).toBe(false);
	});

	test("resolves injected DNS and rejects non-public or empty answers", async () => {
		expect(await resolvePublicAddresses("example.com", async () => ["93.184.216.34"])).toEqual([
			"93.184.216.34",
		]);
		await expect(
			resolvePublicAddresses("example.com", async () => ["10.0.0.1"]),
		).rejects.toMatchObject({ code: "blocked_ip" });
		await expect(resolvePublicAddresses("example.com", async () => [])).rejects.toMatchObject({
			code: "dns_failure",
		});
		await expect(
			resolvePublicAddresses("example.com", async () => {
				throw new Error("dns down");
			}),
		).rejects.toMatchObject({ code: "dns_failure" });
	});

	test("detects DNS rebinding mismatches", () => {
		expect(() => assertNoDnsRebinding(["93.184.216.34"], ["93.184.216.34"])).not.toThrow();
		expect(() => assertNoDnsRebinding(["93.184.216.34"], ["127.0.0.1"])).toThrow(SafeFetchError);
	});
});
