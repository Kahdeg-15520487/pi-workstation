import { describe, expect, it } from "vitest";
import {
	formatMemoriesForContext,
	MAX_RECALL_CONTEXT_CHARS,
	MAX_RECALL_MEMORY_CHARS,
	MEMORIES_OMITTED_MARKER,
	MEMORY_TRUNCATED_MARKER,
} from "../recall.js";
import type { Memory } from "../types.js";

function makeMemory(id: string, summary: string, tags: string[] = []): Memory {
	return {
		id,
		template: "compact-note",
		metadata: {
			createdAt: "2026-05-03T00:00:00.000Z",
			tags,
			triggerKeywords: [],
		},
		content: {
			summary,
			keyPoints: [],
		},
	};
}

describe("formatMemoriesForContext", () => {
	it("returns empty context when no memories are provided", () => {
		expect(formatMemoriesForContext([])).toBe("");
	});

	it("keeps normal memory context unmodified below the prompt budget", () => {
		const text = formatMemoriesForContext([
			makeMemory("mem-1-abcd", "short useful memory", ["memory"]),
		]);

		expect(text).toContain("## Workspace Memories");
		expect(text).toContain("short useful memory");
		expect(text).toContain("**Tags:** memory");
		expect(text).not.toContain(MEMORY_TRUNCATED_MARKER);
		expect(text.length).toBeLessThanOrEqual(MAX_RECALL_CONTEXT_CHARS);
	});

	it("truncates a single oversized memory before injection", () => {
		const text = formatMemoriesForContext([
			makeMemory("mem-1-abcd", "x".repeat(MAX_RECALL_MEMORY_CHARS * 2)),
		]);

		expect(text).toContain(MEMORY_TRUNCATED_MARKER);
		expect(text.length).toBeLessThanOrEqual(MAX_RECALL_CONTEXT_CHARS);
	});

	it("omits additional memories when the total context budget is exhausted", () => {
		const memories = Array.from({ length: 10 }, (_, index) =>
			makeMemory(`mem-${index}-abcd`, `memory-${index} ${"x".repeat(MAX_RECALL_MEMORY_CHARS)}`)
		);

		const text = formatMemoriesForContext(memories);

		expect(text).toContain(MEMORIES_OMITTED_MARKER);
		expect(text.length).toBeLessThanOrEqual(MAX_RECALL_CONTEXT_CHARS);
	});
});
