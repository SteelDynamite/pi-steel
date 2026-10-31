import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __test__ } from "../src/index.ts";

const { loadSuggestionSystemPrompt } = __test__;

describe("prompt loading", () => {
	it("loads the packaged suggestion system prompt", () => {
		const prompt = loadSuggestionSystemPrompt(process.cwd());

		assert.match(prompt, /\[SUGGESTION MODE:/);
		assert.match(prompt, /I was just about to type that/);
		assert.match(prompt, /Reply with only the suggestion text/);
	});
});
