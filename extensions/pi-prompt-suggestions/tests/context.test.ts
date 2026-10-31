import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { __test__ } from "../src/index.ts";

const { buildSuggestionContext, convertToLlm, extractAssistantText, extractMessageText, formatMessageForSuggestion, truncatePlain } =
	__test__;

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("suggestion context helpers", () => {
	it("extracts user text and assistant text/tool calls", () => {
		const user: Message = { role: "user", content: "count to 10", timestamp: 1 };
		const assistant = assistantMessage([
			{ type: "text", text: "1 2 3" },
			{ type: "toolCall", id: "tool-1", name: "write", arguments: { path: "package.json" } },
		]);

		assert.equal(extractMessageText(user), "count to 10");
		assert.equal(extractMessageText(assistant), "1 2 3\n[tool call: write]");
		assert.equal(formatMessageForSuggestion(assistant), "assistant: 1 2 3\n[tool call: write]");
	});

	it("converts Pi custom messages to LLM messages", () => {
		const converted = convertToLlm([
			{
				role: "bashExecution",
				command: "npm test",
				output: "ok",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			},
			{ role: "custom", customType: "note", content: "remember this", display: true, timestamp: 2 },
			{ role: "compactionSummary", summary: "old context", tokensBefore: 100, timestamp: 3 },
		]);

		assert.equal(converted.length, 3);
		assert.equal(extractMessageText(converted[0]), "Ran `npm test`\n```\nok\n```");
		assert.equal(extractMessageText(converted[1]), "remember this");
		assert.match(extractMessageText(converted[2]), /old context/);
	});

	it("extracts only visible assistant text from model responses", () => {
		const response = assistantMessage([
			{ type: "thinking", thinking: "hidden reasoning" },
			{ type: "text", text: "run the tests" },
			{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "npm test" } },
		]);

		assert.equal(extractAssistantText(response), "run the tests");
	});

	it("builds context from the last eight messages", () => {
		const messages: Message[] = Array.from({ length: 10 }, (_value, index) => ({
			role: "user",
			content: `message ${index}`,
			timestamp: index,
		}));

		const context = buildSuggestionContext(messages);

		assert.match(context, /message 2/);
		assert.match(context, /message 9/);
		assert.doesNotMatch(context, /message 0/);
		assert.doesNotMatch(context, /message 1/);
	});

	it("truncates long message text", () => {
		const long = "a".repeat(2_100);
		const formatted = formatMessageForSuggestion({ role: "user", content: long, timestamp: 1 });

		assert.equal(formatted.length, "user: ".length + 2_000);
		assert.ok(formatted.endsWith("…"));
		assert.equal(truncatePlain("short", 20), "short");
	});
});
