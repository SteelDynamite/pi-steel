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
	private mode: "pinned" | "edit" = "pinned";
	private input = new Input();
	private hasFocus = false;
	saved: string;

	constructor(tui: TUI, theme: Theme, saved: string, pin: (text: string) => void) {
		this.tui = tui; this.theme = theme; this.saved = saved; this.pin = pin;
	}
	get focused() { return this.hasFocus; }
	set focused(value: boolean) {
		this.hasFocus = this.input.focused = value;
		// Pi clears the old component's focused flag *before* installing the new
		// target, even for a same-component refocus. Reconcile after the handoff.
		queueMicrotask(() => {
			const ownsFocus = this.tui.getFocusedComponent?.() === this;
			if ((!ownsFocus && this.mode !== "pinned") || (ownsFocus && this.mode === "pinned" && this.previous)) this.close();
		});
	}
	private takeFocus() {
		const current = this.tui.getFocusedComponent?.();
		if (current === this) return true;
		// Never steal focus from a question, picker, or another editing surface.
		if (!current || !("getExpandedText" in current || ("getText" in current && "setAutocompleteProvider" in current))) return false;
		this.previous = current;
		this.tui.setFocus(this);
		return this.tui.getFocusedComponent?.() === this;
	}
	edit() {
		if (this.mode !== "pinned" || !this.takeFocus()) return;
		this.mode = "edit"; this.pasting = false; this.input = new Input(); this.input.focused = this.focused;
		this.input.setValue(this.saved); this.input.handleInput("\x05"); // End of prefill.
		this.input.onEscape = () => this.close();
		this.input.onSubmit = value => { this.pin(oneLine(value).trim()); this.close(); };
		this.tui.requestRender();
	}
	close() {
		this.mode = "pinned";
		// Never take focus back from another component. If an overlay later
		// restores focus to this now-passive widget, hand it on to the prompt.
		if (this.tui.getFocusedComponent?.() === this) {
			const previous = this.previous;
			this.previous = null;
			this.tui.setFocus(previous);
		}
		this.tui.requestRender();
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
				this.input.handleInput(data);
			} else if (matchesKey(data, "ctrl+c")) {
				this.input.setValue("");
			} else this.input.handleInput(data);
		}
		this.tui.requestRender();
	}
	private pasting = false;
	render(width: number) {
		const line = (s: string) => truncateToWidth(s, width);
		if (this.mode === "pinned") return [line(this.theme.fg("accent", "Note: ") + (this.saved || "—") + this.theme.fg("dim", "  Alt+N to edit"))];
		return [line(this.theme.fg("accent", "Edit note · Enter pins · Ctrl+C clears · Esc cancels")), ...this.input.render(width).map(line)];
	}
}
