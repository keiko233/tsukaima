import { describe, expect, test } from "bun:test";
import {
	parseConsolidationOutput,
	parseConsolidationOutputDetailed,
} from "../src/services/memory-consolidation.ts";

describe("memory consolidation output parsing & normalization", () => {
	test("handles nullish fields across warm-state and memory candidates", () => {
		const json = JSON.stringify({
			memories: [
				{
					confidence: null,
					content: null,
					expiresAt: null,
					importance: null,
					kind: "fact",
					subject: null,
					summary: "User prefers tea",
				},
			],
			state: {
				answers: [
					{
						answer: "A framework.",
						answeredAt: null,
						key: "a-1",
						question: "What is Tsukaima?",
					},
				],
				atmosphere: null,
				commitments: [
					{
						expiresAt: null,
						key: "c-1",
						owner: null,
						status: null,
						text: "Review PR",
					},
				],
				glossary: null,
				people: [
					{
						aliases: null,
						key: "user-1",
						lastSeenAt: null,
						name: "Alice",
						notes: null,
					},
				],
				summary: null,
				topics: null,
			},
		});

		const result = parseConsolidationOutputDetailed(json);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("Expected parse to succeed");

		expect(result.data.state.summary).toBe("");
		expect(result.data.state.atmosphere).toBe("");
		expect(result.data.state.topics).toEqual([]);
		expect(result.data.state.people[0]?.aliases).toEqual([]);
		expect(result.data.state.people[0]?.notes).toEqual([]);
		expect(result.data.state.people[0]?.lastSeenAt).toBeUndefined();
		expect(result.data.state.commitments[0]?.owner).toBeUndefined();
		expect(result.data.state.commitments[0]?.status).toBe("open");
		expect(result.data.state.commitments[0]?.expiresAt).toBeUndefined();
		expect(result.data.state.answers[0]?.answeredAt).toBeUndefined();
		expect(result.data.memories[0]?.content).toBeUndefined();
		expect(result.data.memories[0]?.subject).toBeUndefined();
		expect(result.data.memories[0]?.confidence).toBe(0.6);
		expect(result.data.memories[0]?.importance).toBe(0.5);
		expect(result.data.memories[0]?.expiresAt).toBeUndefined();

		expect(parseConsolidationOutput(json)).toEqual(result.data);
	});

	test("normalizes dirty strings, filters empty items, and clips overlong arrays", () => {
		const longTopic = "t".repeat(120);
		const topics = [
			"   ",
			"",
			" TypeScript ",
			"   ",
			" Bun ",
			longTopic,
			" Extra 1 ",
			" Extra 2 ",
			" Extra 3 ",
			" Extra 4 ",
		];

		const people = Array.from({ length: 120 }, (_, index) => ({
			aliases: ["", "  Nick  ", "   ", "a".repeat(150), ...Array(10).fill("extra-alias")],
			key: ` user-${index} `,
			name: ` User ${index} `,
			notes: ["", " Note 1 ", "   ", "n".repeat(300), ...Array(10).fill("extra-note")],
		}));

		const glossary = Array.from({ length: 40 }, (_, index) => ({
			meaning: ` Meaning ${index} `,
			term: ` Term ${index} `,
		}));

		const commitments = Array.from({ length: 30 }, (_, index) => ({
			key: ` commit-${index} `,
			text: ` Task ${index} `,
		}));

		const answers = Array.from({ length: 40 }, (_, index) => ({
			answer: ` Ans ${index} `,
			key: ` ans-${index} `,
			question: ` Q ${index} `,
		}));

		const memories = Array.from({ length: 30 }, (_, index) => ({
			kind: "fact",
			summary: ` Summary ${index} `,
		}));

		const json = JSON.stringify({
			memories,
			state: {
				answers,
				atmosphere: "a".repeat(600),
				commitments,
				glossary,
				people,
				summary: "s".repeat(10_000),
				topics,
			},
		});

		const result = parseConsolidationOutputDetailed(json);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("Expected parse to succeed");

		// summary & atmosphere clipped
		expect(result.data.state.summary.length).toBe(8_000);
		expect(result.data.state.atmosphere.length).toBe(400);

		// topics: trimmed, empty strings filtered, clipped to 80 chars, capped to 6 items
		expect(result.data.state.topics).toHaveLength(6);
		expect(result.data.state.topics[0]).toBe("TypeScript");
		expect(result.data.state.topics[1]).toBe("Bun");
		expect(result.data.state.topics[2]?.length).toBe(80);

		// people: capped to 100, aliases and notes capped to 8 and clipped
		expect(result.data.state.people).toHaveLength(100);
		const firstPerson = result.data.state.people[0];
		expect(firstPerson?.key).toBe("user-0");
		expect(firstPerson?.name).toBe("User 0");
		expect(firstPerson?.aliases).toHaveLength(8);
		expect(firstPerson?.aliases[0]).toBe("Nick");
		expect(firstPerson?.aliases[1]?.length).toBe(120);
		expect(firstPerson?.notes).toHaveLength(8);
		expect(firstPerson?.notes[0]).toBe("Note 1");
		expect(firstPerson?.notes[1]?.length).toBe(240);

		// glossary, commitments, answers, memories clipped to bounds
		expect(result.data.state.glossary).toHaveLength(30);
		expect(result.data.state.commitments).toHaveLength(20);
		expect(result.data.state.answers).toHaveLength(30);
		expect(result.data.memories).toHaveLength(20);
	});

	test("normalizes kind synonyms and drops malformed memories while preserving valid state", () => {
		const json = JSON.stringify({
			memories: [
				{ kind: "observation", summary: "User drinks green tea" },
				{ kind: "setting", summary: "Default room is quiet" },
				{ kind: "note", summary: "Meeting every Tuesday" },
				{ kind: "reminder", summary: "Check server logs" },
				{ kind: "task", summary: "Deploy next release" },
				{ kind: "unknown-kind-value", summary: "Arbitrary knowledge note" },
				// Malformed items to be dropped:
				{ kind: "fact", summary: "" },
				{ kind: "fact", summary: "   " },
				{ kind: "fact" },
				null,
				"invalid-primitive",
			],
			state: {
				answers: [],
				atmosphere: "Calm room",
				commitments: [],
				glossary: [],
				people: [{ key: "u1", name: "Alice" }],
				summary: "Ongoing discussion",
				topics: ["General"],
			},
		});

		const result = parseConsolidationOutputDetailed(json);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("Expected parse to succeed");

		// All 6 valid items kept, 5 malformed items dropped
		expect(result.data.memories).toHaveLength(6);
		expect(result.data.memories[0]).toMatchObject({
			kind: "fact",
			summary: "User drinks green tea",
		});
		expect(result.data.memories[1]).toMatchObject({
			kind: "fact",
			summary: "Default room is quiet",
		});
		expect(result.data.memories[2]).toMatchObject({
			kind: "fact",
			summary: "Meeting every Tuesday",
		});
		expect(result.data.memories[3]).toMatchObject({
			kind: "todo",
			summary: "Check server logs",
		});
		expect(result.data.memories[4]).toMatchObject({
			kind: "todo",
			summary: "Deploy next release",
		});
		expect(result.data.memories[5]).toMatchObject({
			kind: "fact",
			summary: "Arbitrary knowledge note",
		});

		// State preserved intact
		expect(result.data.state.summary).toBe("Ongoing discussion");
		expect(result.data.state.atmosphere).toBe("Calm room");
		expect(result.data.state.topics).toEqual(["General"]);
	});

	test("returns detailed error when output is not valid JSON or missing state", () => {
		const noJson = parseConsolidationOutputDetailed("I am not JSON");
		expect(noJson.ok).toBe(false);
		if (!noJson.ok) {
			expect(noJson.error).toContain("no JSON object found");
		}
		expect(parseConsolidationOutput("I am not JSON")).toBeUndefined();

		const brokenJson = parseConsolidationOutputDetailed("{ this is invalid json }");
		expect(brokenJson.ok).toBe(false);
		if (!brokenJson.ok) {
			expect(brokenJson.error).toContain("malformed JSON");
		}

		const missingState = parseConsolidationOutputDetailed(
			JSON.stringify({ memories: [{ kind: "fact", summary: "valid memory" }] }),
		);
		expect(missingState.ok).toBe(false);
		if (!missingState.ok) {
			expect(missingState.error).toContain("missing state object");
		}
	});
});
