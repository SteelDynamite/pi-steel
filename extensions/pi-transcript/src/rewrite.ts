import { type SessionManager } from "@earendil-works/pi-coding-agent";
import {
	STATE_TYPE,
	SUMMARY_TYPE,
	type AssistantBlockMessage,
	type BlockAction,
	type ReviewContext,
	type RewriteState,
	type StoredBlock,
} from "./context.ts";

function actionFor(block: StoredBlock & { choice?: BlockAction }): BlockAction | undefined {
	if (block.status === "pi-compacted") return;
	if (block.choice) return block.choice;
	if (block.status === "keep") return "keep";
	if (block.status === "compacted") return "compact";
	return "drop";
}

export function populateRewrittenSession(
	sessionManager: SessionManager,
	review: ReviewContext,
	summaries: ReadonlyMap<string, string>,
	model: Pick<AssistantBlockMessage, "api" | "provider" | "model">,
	sessionName?: string,
): RewriteState {
	const hasAssistant = review.sequence.some((item) => item.message?.role === "assistant") || review.blocks.some((block) =>
		actionFor(block) === "keep" && block.messages?.some((message) => message.role === "assistant"),
	);
	if (!hasAssistant) {
		// SessionManager delays file creation until an assistant entry exists. Keep the flush sentinel off the active branch.
		sessionManager.appendMessage({
			role: "assistant",
			content: [],
			...model,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		sessionManager.resetLeaf();
	}
	if (sessionName) sessionManager.appendSessionInfo(sessionName);
	const blocks: StoredBlock[] = review.blocks.map((block) => ({
		id: block.id, status: block.status, source: block.source, summary: block.summary, currentEntryIds: [],
	}));
	const records = new Map(blocks.map((block) => [block.id, block]));
	const originals = new Map(review.blocks.map((block) => [block.id, block]));
	const emitted = new Set<string>();
	for (const item of review.sequence) {
		const original = item.blockId ? originals.get(item.blockId) : undefined;
		const block = item.blockId ? records.get(item.blockId) : undefined;
		if (!block || !original) {
			if (item.message) sessionManager.appendMessage(structuredClone(item.message));
			continue;
		}
		const action = actionFor(original);
		if (action === "keep" && original.status === "keep" || action === undefined) {
			// Copy each canonical message in place, including a partial read-only tail.
			if (item.message) block.currentEntryIds.push(sessionManager.appendMessage(structuredClone(item.message)));
			continue;
		}
		if (emitted.has(block.id)) continue;
		emitted.add(block.id);
		if (action === "keep") {
			if (!original.messages) throw new Error(`Original content is unavailable for block ${block.id}`);
			block.currentEntryIds = original.messages.map((message) => sessionManager.appendMessage(structuredClone(message)));
			block.status = "keep";
			block.summary = undefined;
		} else if (action === "compact") {
			block.summary = original.status === "compacted" ? original.summary : summaries.get(block.id);
			if (!block.summary) throw new Error(`No summary is available for block ${block.id}`);
			block.currentEntryIds = [sessionManager.appendCustomMessageEntry(
				SUMMARY_TYPE,
				`The user compacted an earlier conversation block into this context:\n\n<summary>\n${block.summary}\n</summary>`,
				true, { blockId: block.id },
			)];
			block.status = "compacted";
		} else if (action === "drop") {
			block.status = "dropped";
		}
	}

	const state: RewriteState = { version: 1, blocks };
	sessionManager.appendCustomEntry(STATE_TYPE, state);
	return state;
}
