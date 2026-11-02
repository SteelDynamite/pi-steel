import assert from "node:assert/strict";
import test from "node:test";
import { serializeTranscript } from "../src/core.ts";

test("evidence retains call arguments, result association and execution outcomes", () => {
	const evidence = (exitCode: number, cancelled: boolean, isError: boolean, args: string) => serializeTranscript([
		{ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [
			{ type: "toolCall", id: "test-1", name: "bash", arguments: { command: args } },
		] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "test-1", toolName: "bash", isError,
			content: [{ type: "text", text: "same output" }] } },
		{ type: "message", message: { role: "bashExecution", command: args, output: "same output", exitCode, cancelled } },
	] as any[]);
	const success = evidence(0, false, false, "npm test");
	assert.match(success, /"id":"test-1".*"command":"npm test"/);
	assert.match(success, /"toolCallId":"test-1".*"isError":false/);
	assert.match(success, /"exitCode":0,"cancelled":false/);
	assert.match(success, /stopReason: toolUse/);
	assert.notEqual(success, evidence(1, false, false, "npm test"));
	assert.notEqual(success, evidence(0, true, false, "npm test"));
	assert.notEqual(success, evidence(0, false, true, "npm test"));
	assert.notEqual(success, evidence(0, false, false, "echo test"));
});

test("later evaluations exclude aborted and error assistant claims but retain completed evidence", () => {
	const text = serializeTranscript([
		...(["aborted", "error", "stop"] as const).map(stopReason => ({ type: "message", message: {
			role: "assistant", stopReason, content: [{ type: "text", text: `${stopReason}-claim` }],
		} })),
		{ type: "message", message: { role: "user", content: "next turn" } },
	] as any[]);
	assert.doesNotMatch(text, /aborted-claim|error-claim/);
	assert.match(text, /stop-claim/);
	assert.match(text, /next turn/);
});
