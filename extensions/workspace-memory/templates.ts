/**
 * Templates and keyword mapping for workspace-memory extension
 */

import type { MemoryTemplate } from "./types";

// ---------------------------------------------------------------------------
// Keyword → Template mapping
// ---------------------------------------------------------------------------

export const TRIGGER_KEYWORDS: Record<string, MemoryTemplate> = {
	bug: "post-mortem",
	fix: "post-mortem",
	fixed: "post-mortem",
	solved: "post-mortem",
	"root cause": "post-mortem",
	"root-cause": "post-mortem",
	crash: "post-mortem",
	failure: "post-mortem",
	error: "post-mortem",
	exception: "post-mortem",
	incident: "post-mortem",
	outage: "post-mortem",
	regression: "post-mortem",
	버그: "post-mortem",
	장애: "post-mortem",
	오류: "post-mortem",
	해결: "post-mortem",
	수정: "post-mortem",
	원인: "post-mortem",
	결정: "decision-record",
	중요: "decision-record",
	decision: "decision-record",
	"architectural decision": "decision-record",
	adr: "decision-record",
	선택: "decision-record",
	방안: "decision-record",
};

// All trigger keywords as a flat array for detection
export const ALL_TRIGGER_KEYWORDS = Object.keys(TRIGGER_KEYWORDS);

// ---------------------------------------------------------------------------
// Template descriptions for user-facing output
// ---------------------------------------------------------------------------

export const TEMPLATE_LABELS: Record<MemoryTemplate, string> = {
	"post-mortem": "Post-mortem",
	"decision-record": "Decision Record",
	"compact-note": "Compact Note",
};

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/**
 * Detect trigger keywords in text (case-insensitive, matches whole words)
 */
export function detectKeywords(text: string): string[] {
	const lowerText = text.toLowerCase();
	const found: string[] = [];

	for (const keyword of ALL_TRIGGER_KEYWORDS) {
		// Use word boundary matching for single words
		if (keyword.includes(" ") || keyword.includes("-")) {
			// Multi-word keyword: check direct inclusion
			if (lowerText.includes(keyword.toLowerCase())) {
				found.push(keyword);
			}
		} else {
			const lowerKeyword = keyword.toLowerCase();
			const hasKorean = /[\uac00-\ud7af]/.test(lowerKeyword);

			if (hasKorean) {
				// JS \b does not work reliably for Korean token boundaries.
				// Match only when surrounded by non-word-like chars.
				const regex = new RegExp(
					`(^|[^\\p{L}\\p{N}_-])${escapeRegex(lowerKeyword)}($|[^\\p{L}\\p{N}_-])`,
					"iu"
				);
				if (regex.test(lowerText)) {
					found.push(keyword);
				}
			} else {
				// Keep English single-word matching strict to avoid partial matches.
				const regex = new RegExp(`\\b${escapeRegex(lowerKeyword)}\\b`, "i");
				if (regex.test(lowerText)) {
					found.push(keyword);
				}
			}
		}
	}

	return [...new Set(found)]; // deduplicate
}

/**
 * Determine the most appropriate template from detected keywords
 */
export function selectTemplateFromKeywords(keywords: string[]): MemoryTemplate {
	if (keywords.length === 0) return "compact-note";

	// Count occurrences per template
	const templateCounts: Record<string, number> = {};
	for (const kw of keywords) {
		const template = TRIGGER_KEYWORDS[kw];
		if (template) {
			templateCounts[template] = (templateCounts[template] || 0) + 1;
		}
	}

	// Return template with highest count, fallback to compact-note
	let bestTemplate: MemoryTemplate = "compact-note";
	let bestCount = 0;
	for (const [template, count] of Object.entries(templateCounts)) {
		if (count > bestCount) {
			bestCount = count;
			bestTemplate = template as MemoryTemplate;
		}
	}

	return bestTemplate;
}

import { escapeRegex } from "./utils";
