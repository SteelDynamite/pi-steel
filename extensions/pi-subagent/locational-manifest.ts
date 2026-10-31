import { Box, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { AgentConfig } from "./agents.ts";
import { discoverAgents } from "./agents.ts";
import { ADVERTISE_LOCATIONAL_AGENTS_ENV, ORCHESTRATED_CHILD_ENV } from "./constants.ts";
import type { ExtensionAPI, ExtensionContext } from "./pi-compat.ts";

export const LOCATIONAL_MANIFEST_ENTRY = "pi-subagent-locational-manifest";

export interface LocationalManifestData {
	content: string;
}

export function shouldAdvertiseLocationalAgents(): boolean {
	const value = process.env[ADVERTISE_LOCATIONAL_AGENTS_ENV]?.trim().toLowerCase();
	return value !== "0" && value !== "false" && value !== "no" && value !== "off";
}

function escapeMarkdown(text: string): string {
	return text.replace(/([\\`*_[\]])/g, "\\$1");
}

function inlineCode(text: string): string {
	const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
	const fence = "`".repeat(longestRun + 1);
	return `${fence}${text}${fence}`;
}

export function formatLocationalAgentManifest(agents: AgentConfig[]): string {
	const visible = agents.filter((agent) => agent.kind === "locational" && agent.manifest);
	if (visible.length === 0) return "";
	return [
		"## Available locational agents",
		"",
		`Each path below is both a locational agent's source root and full ${inlineCode("subagent")} id. Work inside listed roots must be delegated to the corresponding agent rather than accessed directly.`,
		"",
		visible.map((agent) => `- ${inlineCode(agent.id)}: ${escapeMarkdown(agent.description || "No responsibility description.")}`).join("\n"),
	].join("\n");
}

export function makeLocationalManifest(agents: AgentConfig[]): LocationalManifestData | undefined {
	const content = formatLocationalAgentManifest(agents);
	return content ? { content } : undefined;
}

function makeMarkdownTheme(theme: any): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", text), link: (text) => theme.fg("mdLink", text), linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text), codeBlock: (text) => theme.fg("mdCodeBlock", text), codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text), quoteBorder: (text) => theme.fg("mdQuoteBorder", text), hr: (text) => theme.fg("mdHr", text), listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text), italic: (text) => theme.italic(text), underline: (text) => theme.underline(text), strikethrough: (text) => theme.strikethrough(text),
	};
}

export function renderLocationalManifest(entry: { data?: LocationalManifestData }, _options: { expanded: boolean }, theme: any) {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	if (entry.data?.content) box.addChild(new Markdown(entry.data.content, 0, 0, makeMarkdownTheme(theme), { color: (text: string) => theme.fg("customMessageText", text) }));
	return box;
}

export function registerLocationalManifestRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<LocationalManifestData>(LOCATIONAL_MANIFEST_ENTRY, renderLocationalManifest);
}

export function appendLocationalManifest(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
	if (ctx.mode !== "tui" || !ctx.isProjectTrusted() || process.env[ORCHESTRATED_CHILD_ENV] === "1" || !shouldAdvertiseLocationalAgents()) return false;
	if (ctx.sessionManager.buildContextEntries().some((entry) => entry.type === "custom" && entry.customType === LOCATIONAL_MANIFEST_ENTRY)) return false;
	const manifest = makeLocationalManifest(discoverAgents(ctx.cwd, true, { includeLocationalAgents: true }).locationalAgents);
	if (!manifest) return false;
	pi.appendEntry(LOCATIONAL_MANIFEST_ENTRY, manifest);
	return true;
}
