import { Input, matchesKey, truncateToWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export const oneLine = (text: string) => text.replace(/[\r\n\t\u2028\u2029]+/gu, " ").replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, "");

/** A focusable widget, not a replacement editor or a blocking agent dialog. */
export class NotePanel implements Component {
	// Both Pi 1.4 terminal implementations expose this; other TUIs fail closed.
	private tui: TUI & { getFocusedComponent?: () => Component | null };
	private theme: Theme;
	private pin: (text: string) => void;
	private previous: Component | null = null;
	private mode: "pinned" | "choose" | "edit" = "pinned";
	private input = new Input();
	private selected = 2;
	private suggestion: string | undefined;
	private pending = false;
	private stopRequest?: () => void;
	private hasFocus = false;
	saved: string;

	constructor(tui: TUI, theme: Theme, saved: string, pin: (text: string) => void) {
		this.tui = tui; this.theme = theme; this.saved = saved; this.pin = pin;
	}
	get focused() { return this.hasFocus; }
	set focused(value: boolean) { this.hasFocus = this.input.focused = value; }
	private takeFocus() {
		const current = this.tui.getFocusedComponent?.();
		if (current === this) return true;
		// Never steal focus from a question, picker, or another editing surface.
		if (!current || !("getExpandedText" in current || ("getText" in current && "setAutocompleteProvider" in current))) return false;
		this.previous = current;
		this.tui.setFocus(this);
		return true;
	}
	choose(stop: () => void) {
		if (this.mode !== "pinned" || !this.takeFocus()) return false;
		this.mode = "choose"; this.selected = this.saved ? 0 : 2;
		this.pending = true; this.suggestion = undefined; this.stopRequest = stop;
		this.tui.requestRender(); return true;
	}
	updateSuggestion(text?: string) {
		if (this.mode !== "choose") return;
		this.suggestion = text; this.pending = false; this.tui.requestRender();
	}
	edit(text = this.saved) {
		if (!this.takeFocus()) return;
		this.stopRequest?.(); this.stopRequest = undefined;
		this.mode = "edit"; this.pasting = false; this.input = new Input(); this.input.focused = this.focused;
		this.input.setValue(text); this.input.handleInput("\x05"); // End of prefill.
		this.input.onEscape = () => this.close();
		this.input.onSubmit = value => { this.pin(oneLine(value).trim()); this.close(); };
		this.tui.requestRender();
	}
	close() {
		this.stopRequest?.(); this.stopRequest = undefined;
		this.mode = "pinned";
		if (this.tui.getFocusedComponent?.() === this) this.tui.setFocus(this.previous);
		this.previous = null; this.tui.requestRender();
	}
	dispose() { this.close(); }
	invalidate() { this.input.invalidate(); }
	handleMouse(event: TuiMouseEvent) {
		if (this.mode !== "pinned" || event.button !== "left") return;
		if (event.type === "press") return { handled: true }; // Route the matching release/click here.
		if (event.type === "click") { this.edit(); return { handled: true }; }
	}
	handleInput(data: string) {
		if (this.mode === "edit") {
			// Pi buffers bracketed paste; normalize its payload before Input strips returns.
			// Never interpret an embedded newline as the Enter key.
			if (data.includes("\x1b[200~")) this.pasting = true;
			if (this.pasting) {
				this.pasting = !data.includes("\x1b[201~");
				data = data.split(/(\x1b\[20[01]~)/).map(part => /^\x1b\[20[01]~$/.test(part) ? part : oneLine(part)).join("");
			}
			this.input.handleInput(data);
		} else if (this.mode === "choose") {
			if (matchesKey(data, "escape")) this.close();
			else if (matchesKey(data, "enter")) {
				const text = [this.saved || undefined, this.suggestion, ""][this.selected];
				if (text !== undefined) this.edit(text);
			} else {
				const delta = matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : 0;
				if (delta) do { this.selected = (this.selected + delta + 3) % 3; }
				while ((this.selected === 0 && !this.saved) || (this.selected === 1 && !this.suggestion));
			}
		}
		this.tui.requestRender();
	}
	private pasting = false;
	render(width: number) {
		const line = (s: string) => truncateToWidth(s, width);
		if (this.mode === "pinned") return this.saved ? [line(this.theme.fg("accent", "Note: ") + this.saved)] : [];
		if (this.mode === "edit") return [line(this.theme.fg("accent", "Edit note · Enter pins · Esc cancels")), ...this.input.render(width).map(line)];
		return [line(this.theme.fg("accent", "Return note · ↑↓ choose · Enter edits · Esc keeps")),
			...[`Last note: ${this.saved || "(none yet)"}`, `Suggestion: ${this.suggestion ?? (this.pending ? "generating…" : "unavailable")}`, "Write a new note…"].map((text, i) => line(`${this.selected === i ? "›" : " "} ${text}`))];
	}
}
