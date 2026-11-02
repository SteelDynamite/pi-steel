import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { convertToLlm, initTheme, SessionManager, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { blockIsModified, buildReviewContext, SUMMARY_TYPE, type ReviewBlock } from "../src/context.ts";
import { populateRewrittenSession } from "../src/rewrite.ts";
import { parseSummaries } from "../src/summarize.ts";
import { blockStatusLabel, TranscriptViewer } from "../src/viewer.ts";

const model = { api: "openai-responses" as const, provider: "test", model: "test" };

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
}

function assistant(text: string) {
	return {
		role: "assistant" as const,
		content: [
			{ type: "thinking" as const, thinking: "hidden" },
			{ type: "text" as const, text },
		],
		api: "test" as const,
		provider: "test",
		model: "test",
		usage,
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function toolCall() {
	return {
		...assistant(""),
		content: [{ type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "file.ts" } }],
		stopReason: "toolUse" as const,
	};
}

function toolResult() {
	return {
		role: "toolResult" as const,
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text" as const, text: "hidden tool output" }],
		details: {},
		isError: false,
		timestamp: Date.now(),
	};
}

function session(directory: string): SessionManager {
	return SessionManager.create(directory, directory);
}

test("groups each prompt with assistant responses and hides thinking", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-transcript-"));
	try {
		const manager = session(directory);
		manager.appendMessage(user("First prompt"));
		manager.appendMessage(toolCall());
		manager.appendMessage(toolResult());
		manager.appendMessage(assistant("First response"));
		manager.appendMessage(user("Second prompt"));
		manager.appendMessage(assistant("Second response"));

		const review = buildReviewContext(manager);
		assert.deepEqual(review.blocks.map(({ prompt, response, status }) => ({ prompt, response, status })), [
			{ prompt: "First prompt", response: "First response", status: "keep" },
			{ prompt: "Second prompt", response: "Second response", status: "keep" },
		]);
		assert.deepEqual(review.blocks[0]?.messages?.map((message) => message.role), ["user", "assistant", "toolResult", "assistant"]);
		assert.equal(review.prefixMessages.length, 0);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("marks turns outside Pi's effective context read-only", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-transcript-"));
	try {
		const manager = session(directory);
		manager.appendMessage(user("Old prompt"));
		manager.appendMessage(assistant("Old response"));
		const keptId = manager.appendMessage(user("Recent prompt"));
		manager.appendMessage(assistant("Recent response"));
		manager.appendCompaction("Earlier work summary", keptId, 1000);

		const review = buildReviewContext(manager);
		assert.equal(review.blocks[0]?.status, "pi-compacted");
		assert.equal(review.blocks[0]?.readOnlyReason, "pi-compacted");
		assert.equal(review.blocks[1]?.status, "keep");
		assert.equal(review.prefixMessages[0]?.role, "user");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("persists visible compacted context in block order and can restore originals", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-transcript-"));
	try {
		const original = session(directory);
		original.appendMessage(user("Keep this goal"));
		original.appendMessage(assistant("Completed details"));
		original.appendMessage(user("Compact these findings"));
		original.appendMessage(assistant("Detailed findings"));
		original.appendMessage(user("Discard this tangent"));
		original.appendMessage(assistant("Tangent details"));
		const firstReview = buildReviewContext(original);
		firstReview.blocks[1]!.choice = "compact";
		firstReview.blocks[2]!.choice = "drop";

		const rewritten = session(directory);
		populateRewrittenSession(rewritten, firstReview, new Map([[firstReview.blocks[1]!.id, "Findings summary"]]), model);
		assert.equal(existsSync(rewritten.getSessionFile()!), true);
		const branch = rewritten.getBranch();
		const summaryEntry = branch.find((entry) => entry.type === "custom_message" && entry.customType === SUMMARY_TYPE);
		assert.ok(summaryEntry?.type === "custom_message");
		assert.equal(summaryEntry.display, true);
		assert.deepEqual(summaryEntry.details, { blockId: firstReview.blocks[1]!.id });
		assert.deepEqual(
			branch.filter((entry) => entry.type === "message" || entry.type === "custom_message").map((entry) =>
				entry.type === "message" ? entry.message.role : entry.customType
			),
			["user", "assistant", SUMMARY_TYPE],
		);
		const modelContext = convertToLlm(rewritten.buildSessionContext().messages);
		assert.deepEqual(modelContext.map((message) => message.role), ["user", "assistant", "user"]);
		assert.match(JSON.stringify(modelContext[2]?.content), /Findings summary/);

		const secondReview = buildReviewContext(SessionManager.open(rewritten.getSessionFile()!, directory));
		assert.deepEqual(secondReview.blocks.map((block) => block.status), ["keep", "compacted", "dropped"]);
		assert.equal(secondReview.blocks[1]?.summary, "Findings summary");
		assert.deepEqual(secondReview.blocks.map((block) => block.prompt), [
			"Keep this goal",
			"Compact these findings",
			"Discard this tangent",
		]);

		secondReview.blocks[1]!.choice = "keep";
		secondReview.blocks[2]!.choice = "keep";
		const restored = session(directory);
		populateRewrittenSession(restored, secondReview, new Map(), model);
		const restoredReview = buildReviewContext(restored);
		assert.deepEqual(restoredReview.blocks.map((block) => block.status), ["keep", "keep", "keep"]);
		assert.deepEqual(restoredReview.blocks.map((block) => block.prompt), [
			"Keep this goal",
			"Compact these findings",
			"Discard this tangent",
		]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("retains branch and compaction summaries across repeated locked-host rewrites", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-transcript-"));
	try {
		const manager = session(directory);
		manager.branchWithSummary(null, "Branch summary");
		manager.appendMessage(user("Compacted prompt"));
		manager.appendMessage(assistant("Compacted response"));
		const tail = manager.appendMessage(user("Retained prompt"));
		manager.appendMessage(assistant("Retained response"));
		manager.appendCompaction("Compaction summary", tail, 1000);
		let previous = manager;
		const expected = convertToLlm(manager.buildSessionContext().messages);
		for (let i = 0; i < 3; i++) {
			const next = session(directory);
			populateRewrittenSession(next, buildReviewContext(previous), new Map(), model);
			assert.deepEqual(convertToLlm(next.buildSessionContext().messages), expected);
			previous = next;
		}
		const branchOnly = session(directory);
		branchOnly.branchWithSummary(null, "Retained branch summary");
		branchOnly.appendMessage(user("Prompt"));
		branchOnly.appendMessage(assistant("Response"));
		const rewritten = session(directory);
		populateRewrittenSession(rewritten, buildReviewContext(branchOnly), new Map(), model);
		const repeated = session(directory);
		populateRewrittenSession(repeated, buildReviewContext(rewritten), new Map(), model);
		assert.deepEqual(convertToLlm(repeated.buildSessionContext().messages), convertToLlm(branchOnly.buildSessionContext().messages));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("detects changes and labels restoration", () => {
	const block = {
		status: "compacted",
		choice: "compact",
		readOnlyReason: undefined,
	} as ReviewBlock;
	assert.equal(blockIsModified(block), false);
	assert.equal(blockStatusLabel(block), "COMPACTED");
	block.choice = "keep";
	assert.equal(blockIsModified(block), true);
	assert.equal(blockStatusLabel(block), "RESTORE → KEEP");
});

test("renders indented block borders within the available width", () => {
	initTheme("dark", false);
	const block = {
		id: "block",
		status: "keep",
		source: { sessionFile: "/tmp/source", entryIds: ["entry"] },
		currentEntryIds: ["entry"],
		prompt: "A prompt that wraps across a narrow transcript viewer.",
		response: "A response that also wraps.",
		choice: "keep",
	} as ReviewBlock;
	let renders = 0;
	const tui = { terminal: { rows: 20 }, requestRender: () => { renders++; } } as unknown as TUI;
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
	const viewer = new TranscriptViewer([block], tui, theme, () => {});
	const lines = viewer.render(24);
	assert.ok(lines.some((line) => line.includes("[KEEP]")));
	assert.ok(lines.some((line) => line.startsWith("  ──")));
	assert.ok(lines.every((line) => visibleWidth(line) <= 24));
	viewer.handleInput("c");
	assert.equal(block.choice, "compact");
	assert.equal(renders, 1);
});

test("keeps arrow block navigation and scrolls page keys one line", () => {
	initTheme("dark", false);
	const blocks = ["first", "second"].map((id) => ({
		id,
		status: "keep",
		source: { sessionFile: "/tmp/source", entryIds: [id] },
		currentEntryIds: [id],
		prompt: `${id} prompt\nline 2\nline 3\nline 4`,
		response: `${id} response`,
		choice: "keep",
	})) as ReviewBlock[];
	let renders = 0;
	const tui = { terminal: { rows: 8 }, requestRender: () => { renders++; } } as unknown as TUI;
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
	const viewer = new TranscriptViewer(blocks, tui, theme, () => {});
	const before = viewer.render(40).slice(1, -1);

	viewer.handleInput("\x1b[6~");
	const after = viewer.render(40).slice(1, -1);
	assert.deepEqual(after.slice(0, -1), before.slice(1));

	viewer.handleInput("\x1b[B");
	assert.match(viewer.render(40)[0]!, /block 2\/2/);
	assert.equal(renders, 2);
});

test("parses exactly one summary per requested block", () => {
	const summaries = parseSummaries(
		"```json\n{\"summaries\":[{\"id\":\"a\",\"summary\":\"One\"},{\"id\":\"b\",\"summary\":\"Two\"}]}\n```",
		["a", "b"],
	);
	assert.deepEqual([...summaries], [["a", "One"], ["b", "Two"]]);
	assert.throws(() => parseSummaries('{"summaries":[{"id":"a","summary":"One"}]}', ["a", "b"]));
});
