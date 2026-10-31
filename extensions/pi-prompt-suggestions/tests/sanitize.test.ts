import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __test__ } from "../src/index.ts";

const { sanitizeSuggestion } = __test__;

describe("sanitizeSuggestion", () => {
	it("accepts short imperative suggestions", () => {
		assert.equal(sanitizeSuggestion("run the tests"), "run the tests");
		assert.equal(sanitizeSuggestion("count to 20"), "count to 20");
		assert.equal(sanitizeSuggestion("yes"), "yes");
	});

	it("normalizes quotes and a trailing period", () => {
		assert.equal(sanitizeSuggestion('  "run the tests."  '), "run the tests");
		assert.equal(sanitizeSuggestion("'commit this.'"), "commit this");
	});

	it("rejects empty or multiline suggestions", () => {
		assert.equal(sanitizeSuggestion(""), undefined);
		assert.equal(sanitizeSuggestion("   "), undefined);
		assert.equal(sanitizeSuggestion("run tests\ncommit this"), undefined);
	});

	it("rejects questions, long text, multiple sentences, and word-count violations", () => {
		assert.equal(sanitizeSuggestion("run the tests?"), undefined);
		assert.equal(sanitizeSuggestion("run the tests. then commit"), undefined);
		assert.equal(sanitizeSuggestion("x".repeat(81)), undefined);
		assert.equal(sanitizeSuggestion("one two three four five six seven eight nine ten eleven twelve thirteen"), undefined);
		assert.equal(sanitizeSuggestion("banana"), undefined);
		assert.equal(sanitizeSuggestion("continue"), "continue");
		assert.equal(sanitizeSuggestion("/help"), "/help");
	});

	it("rejects meta-output, labels, formatting, and errors", () => {
		assert.equal(sanitizeSuggestion("done"), undefined);
		assert.equal(sanitizeSuggestion("no suggestion"), undefined);
		assert.equal(sanitizeSuggestion("nothing to suggest"), undefined);
		assert.equal(sanitizeSuggestion("silence"), undefined);
		assert.equal(sanitizeSuggestion("stay silent"), undefined);
		assert.equal(sanitizeSuggestion("[no suggestion]"), undefined);
		assert.equal(sanitizeSuggestion("Suggestion: run the tests"), undefined);
		assert.equal(sanitizeSuggestion("**run the tests**"), undefined);
		assert.equal(sanitizeSuggestion("api error: timeout"), undefined);
		assert.equal(sanitizeSuggestion("request timed out"), undefined);
	});

	it("rejects assistant voice and evaluative replies", () => {
		assert.equal(sanitizeSuggestion("let me run the tests"), undefined);
		assert.equal(sanitizeSuggestion("I'll run the tests"), undefined);
		assert.equal(sanitizeSuggestion("I can run the tests"), undefined);
		assert.equal(sanitizeSuggestion("Here's what to do"), undefined);
		assert.equal(sanitizeSuggestion("thanks"), undefined);
		assert.equal(sanitizeSuggestion("looks good"), undefined);
	});
});
