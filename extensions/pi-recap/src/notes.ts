import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { NotePanel, oneLine } from "./note-panel.ts";

const KEY = "pi-recap-return-note";
const eligible = (ctx: ExtensionContext) => ctx.mode === "tui" && process.env.PI_ORCHESTRATED_CHILD !== "1";

export function restoreNote(entries: readonly SessionEntry[]) {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== KEY) continue;
		const data = entry.data as { version?: unknown; text?: unknown } | undefined;
		if (data?.version === 1 && typeof data.text === "string") return oneLine(data.text);
	}
	return "";
}

export function registerNotes(pi: ExtensionAPI) {
	let panel: NotePanel | undefined;
	let armed = false;
	let blocked = false;
	const mount = (ctx: ExtensionContext) => {
		if (panel) return panel;
		const saved = restoreNote(ctx.sessionManager.getBranch());
		ctx.ui.setWidget(KEY, (tui, theme) => {
			const next = new NotePanel(tui, theme, saved, text => {
				if (panel !== next || text === next.saved) return;
				pi.appendEntry(KEY, { version: 1, text }); next.saved = text;
			});
			return panel = next;
		});
		return panel;
	};
	const reset = () => { panel?.dispose(); panel = undefined; armed = blocked = false; };
	const restore = (ctx: ExtensionContext) => {
		reset();
		if (!eligible(ctx)) return;
		if (restoreNote(ctx.sessionManager.getBranch())) mount(ctx); else ctx.ui.setWidget(KEY, undefined);
	};
	pi.on("session_start", (_e, ctx) => restore(ctx));
	pi.on("session_tree", (_e, ctx) => restore(ctx));
	pi.on("session_shutdown", reset);
	// Tool turns, retries, and queued continuations are not the end of the user's run.
	pi.on("agent_settled", () => panel?.dismissIfUntouched());
	pi.on("ui_prompt_start", () => { blocked = true; panel?.close(); });
	pi.on("ui_prompt_end", () => { blocked = false; });
	pi.on("model_select", () => panel?.close());
	pi.registerCommand("note", { description: "Edit your pinned return note (terminal only)", handler: async (_args, ctx) => {
		if (eligible(ctx) && !blocked) mount(ctx)?.edit();
	} });
	pi.on("input", (event, ctx) => { armed = eligible(ctx) && event.source === "interactive"; });
	pi.on("message_start", (event, ctx) => {
		if (!armed || event.message.role !== "user") return;
		armed = false;
		if (blocked || !eligible(ctx) || ctx.ui.getEditorText().trim()) return;
		mount(ctx)?.choose();
	});
}
