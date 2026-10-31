import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, Text, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { BlockAction, ReviewBlock } from "./context.ts";

export function blockStatusLabel(block: ReviewBlock): string {
	if (block.readOnlyReason === "pi-compacted") return "PI-COMPACTED · READ ONLY";
	if (block.readOnlyReason === "source-missing") return "SOURCE MISSING";
	if (block.choice === "keep") return block.status === "keep" ? "KEEP" : "RESTORE → KEEP";
	if (block.choice === "compact") return block.status === "compacted" ? "COMPACTED" : "COMPACT";
	if (block.choice === "drop") return block.status === "dropped" ? "DROPPED" : "DROP";
	return "READ ONLY";
}

export class TranscriptViewer implements Component {
	private selected = 0;
	private offset = 0;
	private bodyHeight = 1;
	private ensureSelectedVisible = true;
	private readonly showOriginal = new Set<string>();
	private readonly blocks: ReviewBlock[];
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly close: () => void;

	constructor(blocks: ReviewBlock[], tui: TUI, theme: Theme, close: () => void) {
		this.blocks = blocks;
		this.tui = tui;
		this.theme = theme;
		this.close = close;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.close();
			return;
		}

		if (matchesKey(data, Key.up)) {
			this.selected = Math.max(0, this.selected - 1);
			this.ensureSelectedVisible = true;
		} else if (matchesKey(data, Key.down)) {
			this.selected = Math.min(this.blocks.length - 1, this.selected + 1);
			this.ensureSelectedVisible = true;
		} else if (matchesKey(data, Key.pageUp)) {
			this.offset--;
		} else if (matchesKey(data, Key.pageDown)) {
			this.offset++;
		} else if (matchesKey(data, Key.home)) {
			this.selected = 0;
			this.ensureSelectedVisible = true;
		} else if (matchesKey(data, Key.end)) {
			this.selected = this.blocks.length - 1;
			this.ensureSelectedVisible = true;
		} else if (matchesKey(data, Key.enter)) {
			const block = this.blocks[this.selected];
			if (block?.status !== "compacted" || !block.summary) return;
			if (this.showOriginal.has(block.id)) this.showOriginal.delete(block.id);
			else this.showOriginal.add(block.id);
			this.ensureSelectedVisible = true;
		} else if (data === "k" || data === "c" || data === "d") {
			const block = this.blocks[this.selected];
			if (!block || block.readOnlyReason) return;
			const actions: Record<string, BlockAction> = { k: "keep", c: "compact", d: "drop" };
			block.choice = actions[data];
		} else return;

		this.tui.requestRender();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const height = Math.max(3, Math.floor(this.tui.terminal.rows * 0.75));
		this.bodyHeight = height - 2;
		const lines: string[] = [];
		const ranges: Array<{ start: number; end: number }> = [];
		for (const [index, block] of this.blocks.entries()) {
			const start = lines.length;
			lines.push(...this.renderBlock(block, index, safeWidth));
			ranges.push({ start, end: lines.length });
			if (index < this.blocks.length - 1) lines.push("");
		}

		const maxOffset = Math.max(0, lines.length - this.bodyHeight);
		this.offset = Math.max(0, Math.min(this.offset, maxOffset));
		if (this.ensureSelectedVisible) {
			const range = ranges[this.selected];
			if (range) {
				if (range.start < this.offset) this.offset = range.start;
				else if (range.end > this.offset + this.bodyHeight) this.offset = Math.min(range.start, maxOffset);
			}
			this.ensureSelectedVisible = false;
		}

		const visible = lines.slice(this.offset, this.offset + this.bodyHeight);
		while (visible.length < this.bodyHeight) visible.push("");
		const position = `${this.selected + 1}/${this.blocks.length}`;
		const header = this.theme.fg("accent", this.theme.bold("Transcript")) + this.theme.fg("dim", ` · block ${position}`);
		const footer = this.theme.fg("dim", "↑/↓ block · k keep · c compact · d drop · Enter original/summary · PgUp/PgDn line scroll · Esc close");
		return [truncateToWidth(header, safeWidth, ""), ...visible, truncateToWidth(footer, safeWidth, "")];
	}

	invalidate(): void {}

	private renderBlock(block: ReviewBlock, index: number, width: number): string[] {
		const selected = index === this.selected;
		const outerIndent = " ".repeat(Math.min(2, Math.max(0, width - 1)));
		const ruleWidth = Math.max(1, width - outerIndent.length);
		const label = `${selected ? "▶ " : ""}${index + 1} · [${blockStatusLabel(block)}]`;
		const ruleText = truncateToWidth(`── ${label} ${"─".repeat(ruleWidth)}`, ruleWidth, "");
		const color = selected ? "accent" : "dim";
		const lines = [`${outerIndent}${this.theme.fg(color, ruleText)}`];
		const contentIndent = " ".repeat(Math.min(4, Math.max(0, width - 1)));
		const contentWidth = Math.max(1, width - contentIndent.length);
		const add = (labelText: string, text: string) => {
			lines.push(`${contentIndent}${truncateToWidth(this.theme.fg("accent", this.theme.bold(labelText)), contentWidth, "")}`);
			const markdown = new Markdown(text, 0, 0, getMarkdownTheme());
			lines.push(...markdown.render(contentWidth).map((line) => `${contentIndent}${line}`));
		};

		if (block.status === "compacted" && block.summary && !this.showOriginal.has(block.id)) {
			add("SUMMARY", block.summary);
			lines.push(`${contentIndent}${truncateToWidth(this.theme.fg("dim", "Enter to show original"), contentWidth, "")}`);
		} else {
			add("USER", block.prompt);
			add("ASSISTANT", block.response);
			if (block.status === "compacted" && block.summary) {
				lines.push(`${contentIndent}${truncateToWidth(this.theme.fg("dim", "Enter to show summary"), contentWidth, "")}`);
			}
		}
		lines.push(`${outerIndent}${this.theme.fg(color, "─".repeat(ruleWidth))}`);
		return lines;
	}
}
