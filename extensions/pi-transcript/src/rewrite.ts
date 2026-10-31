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
	const hasAssistant = review.prefixMessages.some((message) => message.role === "assistant") || review.blocks.some((block) =>
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
	for (const message of review.prefixMessages) sessionManager.appendMessage(structuredClone(message));

	const blocks: StoredBlock[] = [];
	for (const block of review.blocks) {
		const action = actionFor(block);
		let status = block.status;
		let currentEntryIds: string[] = [];
		let summary = block.summary;

		if (action === "keep") {
			if (!block.messages) throw new Error(`Original content is unavailable for block ${block.id}`);
			currentEntryIds = block.messages.map((message) => sessionManager.appendMessage(structuredClone(message)));
			status = "keep";
			summary = undefined;
		} else if (action === "compact") {
			summary = block.status === "compacted" && block.choice === "compact" ? block.summary : summaries.get(block.id);
			if (!summary) throw new Error(`No summary is available for block ${block.id}`);
			currentEntryIds = [sessionManager.appendCustomMessageEntry(
				SUMMARY_TYPE,
				`The user compacted an earlier conversation block into this context:\n\n<summary>\n${summary}\n</summary>`,
				true,
				{ blockId: block.id },
			)];
			status = "compacted";
		} else if (action === "drop") {
			status = "dropped";
		} else {
			status = "pi-compacted";
		}

		blocks.push({ id: block.id, status, source: block.source, summary, currentEntryIds });
	}

	const state: RewriteState = { version: 1, blocks };
	sessionManager.appendCustomEntry(STATE_TYPE, state);
	return state;
}
