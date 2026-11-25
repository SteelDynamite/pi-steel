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
	let blocked = false;
	let unsubscribe: (() => void) | undefined;
	const reset = () => { unsubscribe?.(); unsubscribe = undefined; panel?.close(); panel = undefined; blocked = false; };
	const restore = (ctx: ExtensionContext) => {
		reset();
		if (!eligible(ctx)) return;
		const saved = restoreNote(ctx.sessionManager.getBranch());
		ctx.ui.setWidget(KEY, (tui, theme) => {
			const outline = () => {
				if (ctx.ui.getEditorText().trimStart().startsWith("!")) return "bashMode";
				const level = pi.getThinkingLevel() || "off";
				return `thinking${level[0].toUpperCase()}${level.slice(1)}`;
			};
			const next = new NotePanel(tui, theme, saved, outline, text => {
				if (panel !== next || text === next.saved) return;
				pi.appendEntry(KEY, { version: 1, text }); next.saved = text;
			});
			return panel = next;
		});
		// Pi displays above-editor widgets in insertion order. Reinsert the same
		// component so a newly shown todo list moves above even an active draft.
		unsubscribe = pi.events.on("pi-todo:widget-mounted", () => {
			const current = panel;
			if (current) ctx.ui.setWidget(KEY, () => current);
		});
	};
	const edit = (ctx: ExtensionContext) => { if (eligible(ctx) && !blocked) panel?.edit(); };
	pi.on("session_start", (_e, ctx) => restore(ctx));
	pi.on("session_tree", (_e, ctx) => restore(ctx));
	pi.on("session_shutdown", reset);
	pi.on("ui_prompt_start", () => { blocked = true; panel?.close(); });
	pi.on("ui_prompt_end", () => { blocked = false; });
	pi.on("model_select", () => panel?.close());
	const description = "Edit your pinned return note (terminal only)";
	if (process.env.PI_ORCHESTRATED_CHILD !== "1") pi.registerShortcut("alt+n", { description, handler: edit });
	pi.registerCommand("note", { description, handler: async (_args, ctx) => edit(ctx) });
}
