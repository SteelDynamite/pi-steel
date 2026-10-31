import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __test__ } from "../src/index.ts";

const { isSuggestionModeSupported, mergeConfigInputs, parseConfigInput, parseModelSpec, sanitizeSuggestion } = __test__;

describe("configuration helpers", () => {
	it("merges config with project values overriding global values", () => {
		assert.deepEqual(
			mergeConfigInputs(
				{ enabled: false, acceptTab: false, display: "belowEditor", maxChars: 40, maxTokens: 100, model: "openai/a" },
				{ enabled: true, acceptTab: true, display: "ghost", model: "anthropic/b" },
			),
			{ enabled: true, acceptTab: true, display: "ghost", maxChars: 40, maxTokens: 100, model: "anthropic/b" },
		);
	});

	it("uses defaults when config files are empty", () => {
		assert.deepEqual(mergeConfigInputs({}, {}), {
			enabled: true,
			acceptTab: false,
			display: "ghost",
			maxChars: 80,
			maxTokens: 256,
			model: "openai/gpt-5.6-terra",
		});
	});

	it("parses valid config fields", () => {
		assert.deepEqual(
			parseConfigInput({
				enabled: false,
				acceptTab: true,
				display: "belowEditor",
				model: " openai/gpt ",
				maxChars: 120,
				maxTokens: 512,
			}),
			{ enabled: false, acceptTab: true, display: "belowEditor", model: "openai/gpt", maxChars: 120, maxTokens: 512 },
		);
	});

	it("ignores invalid config fields", () => {
		const warnings: string[] = [];
		assert.deepEqual(
			parseConfigInput(
				{ enabled: "yes", acceptTab: "yes", display: "inline", model: "", maxChars: 0, maxTokens: 1.5 },
				"test.json",
				(message) => warnings.push(message),
			),
			{},
		);
		assert.equal(warnings.length, 6);
	});

	it("parses provider/model specs", () => {
		assert.deepEqual(parseModelSpec("openai/gpt-5-mini"), { provider: "openai", model: "gpt-5-mini" });
		assert.deepEqual(parseModelSpec("openrouter/anthropic/claude-sonnet-4.5"), {
			provider: "openrouter",
			model: "anthropic/claude-sonnet-4.5",
		});
		assert.equal(parseModelSpec("gpt-5-mini"), undefined);
		assert.equal(parseModelSpec("/gpt-5-mini"), undefined);
		assert.equal(parseModelSpec("openai/"), undefined);
	});

	it("uses configured maxChars in sanitizer", () => {
		const suggestion = "run " + "x".repeat(77);
		assert.equal(sanitizeSuggestion(suggestion, 120), suggestion);
		assert.equal(sanitizeSuggestion(suggestion, 80), undefined);
	});

	it("supports suggestions only where TUI editor UI is available", () => {
		assert.equal(isSuggestionModeSupported("tui"), true);
		assert.equal(isSuggestionModeSupported("rpc"), false);
		assert.equal(isSuggestionModeSupported("json"), false);
		assert.equal(isSuggestionModeSupported("print"), false);
		assert.equal(isSuggestionModeSupported(undefined, "rpc", true), false);
		assert.equal(isSuggestionModeSupported(undefined, "interactive", true), true);
		assert.equal(isSuggestionModeSupported(undefined, "interactive", false), false);
	});
});
