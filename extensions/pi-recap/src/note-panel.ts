import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import * as terminal from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export const oneLine = (text: string) => text.replace(/[\r\n\t\u2028\u2029]+/gu, " ").replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, "");

// Use Pi 1.4's concrete theme colors when available. Older standalone Pi hosts
// only expose semantic foreground/background slots and cannot swap them.
function noteStyle(theme: Theme, token: string): (text: string) => string {
	if ("colors" in theme && theme.colors && typeof theme.colors === "object" &&
		"style" in theme && typeof theme.style === "function" && "colorToRgb" in terminal && typeof terminal.colorToRgb === "function") {
		const color = (theme.colors as Record<string, unknown>)[token];
		if (color) {
			const { r, g, b } = terminal.colorToRgb(color);
			const linear = (v: number) => v <= 10 ? v / 3294.6 : ((v / 255 + 0.055) / 1.055) ** 2.4;
			const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
			// Choose whichever of black and white has higher contrast on the outline color.
			const options = { bg: color, fg: { kind: "indexed", index: luminance > 0.179 ? 16 : 231 } };
			const style = theme.style.bind(theme);
			return text => style(text, options);
		}
	}
	return text => theme.bg("customMessageBg", theme.fg("customMessageText", text));
}

/** A focusable widget, not a replacement editor or a blocking agent dialog. */
export class NotePanel implements Component {
	// Both Pi 1.4 terminal implementations expose this; other TUIs fail closed.
	private tui: TUI & { getFocusedComponent?: () => Component | null };
	private theme: Theme;
	private outline: () => string;
	private pin: (text: string) => void;
	private previous: Component | null = null;
	private mode: "pinned" | "edit" = "pinned";
	private input = new Input();
	private hasFocus = false;
	saved: string;

	constructor(tui: TUI, theme: Theme, saved: string, outline: () => string, pin: (text: string) => void) {
		this.tui = tui; this.theme = theme; this.saved = saved; this.outline = outline; this.pin = pin;
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
		const paint = noteStyle(this.theme, this.outline());
		const rows = this.mode === "edit"
			? ["Edit note · Enter pins · Ctrl+C clears · Esc cancels", ...this.input.render(width)]
			: this.saved ? wrapTextWithAnsi(`Note: ${this.saved}`, width) : ["Note: —  Alt+N to edit"];
		return rows.map(row => {
			const text = truncateToWidth(row, width);
			return paint(text + " ".repeat(Math.max(0, width - visibleWidth(text))));
		});
	}
}
