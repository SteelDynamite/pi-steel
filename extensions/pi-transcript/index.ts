import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { blockIsModified, buildReviewContext, formatPlainTranscript, type BlockAction, type ReviewBlock } from "./src/context.ts";
import { populateRewrittenSession } from "./src/rewrite.ts";
import { summarizeBlocks } from "./src/summarize.ts";
import { TranscriptViewer } from "./src/viewer.ts";

const CONFIRM_OPTIONS = ["Apply rewrite", "Discard changes", "Return to viewer"];

async function reviewInRpc(blocks: ReviewBlock[], ctx: ExtensionCommandContext): Promise<void> {
	await ctx.ui.editor("Transcript", formatPlainTranscript(blocks));
	for (const [index, block] of blocks.entries()) {
		if (block.readOnlyReason) continue;
		const prompt = block.prompt.replace(/\s+/g, " ").slice(0, 80);
		const selected = await ctx.ui.select(`Block ${index + 1}: ${prompt}`, ["Keep", "Compact", "Drop", "Finish review"]);
		if (!selected || selected === "Finish review") return;
		block.choice = selected.toLowerCase() as BlockAction;
	}
}

async function reviewAndConfirm(blocks: ReviewBlock[], ctx: ExtensionCommandContext): Promise<boolean> {
	for (;;) {
		if (ctx.mode === "tui") {
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new TranscriptViewer(blocks, tui, theme, done));
		} else {
			await reviewInRpc(blocks, ctx);
		}
		if (!blocks.some(blockIsModified)) return false;

		const confirmation = await ctx.ui.select("Rewrite model context?", CONFIRM_OPTIONS);
		if (confirmation === "Apply rewrite") return true;
		if (confirmation === "Discard changes") return false;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("transcript", {
		description: "Review and rewrite prompt-response context blocks",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			if (!ctx.hasUI) return;
			const parentSession = ctx.sessionManager.getSessionFile();
			const review = buildReviewContext(ctx.sessionManager);
			if (review.blocks.length === 0) {
				ctx.ui.notify("No prompt-response blocks in this session", "warning");
				return;
			}
			if (!await reviewAndConfirm(review.blocks, ctx)) return;
			if (!parentSession) {
				ctx.ui.notify("Context rewriting requires a persisted session", "warning");
				return;
			}

			const needsSummary = review.blocks.filter((block) =>
				block.choice === "compact" && block.status !== "compacted" && !block.readOnlyReason,
			);
			let summaries = new Map<string, string>();
			try {
				if (needsSummary.length > 0) {
					ctx.ui.setStatus("pi-transcript", "Summarizing context...");
					summaries = await summarizeBlocks(needsSummary, ctx);
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : "Context summarization failed", "error");
				return;
			} finally {
				ctx.ui.setStatus("pi-transcript", undefined);
			}

			const sessionName = ctx.sessionManager.getSessionName();
			const existingAssistant = review.blocks.flatMap((block) => block.messages ?? []).find((message) => message.role === "assistant");
			const persistenceModel = existingAssistant
				? { api: existingAssistant.api, provider: existingAssistant.provider, model: existingAssistant.model }
				: ctx.model
					? { api: ctx.model.api, provider: ctx.model.provider, model: ctx.model.id }
					: { api: "openai-responses" as const, provider: "unknown", model: "unknown" };
			const result = await ctx.newSession({
				parentSession,
				setup: async (sessionManager) => {
					populateRewrittenSession(sessionManager, review, summaries, persistenceModel, sessionName);
				},
				withSession: async (ctx) => {
					ctx.ui.notify("Context rewritten", "info");
				},
			});
			if (result.cancelled) ctx.ui.notify("Context rewrite cancelled", "warning");
		},
	});
}
