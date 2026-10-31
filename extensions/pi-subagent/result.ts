import type { Message } from "@earendil-works/pi-ai";
import type { DisplayItem, SingleResult } from "./types.ts";

export function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatUsageStats(
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens?: number; turns?: number },
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function getFinalOutput(messages: Message[]): string {
	for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
		const message = messages[messageIndex];
		if (message.role !== "assistant") continue;
		for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
			const part = message.content[partIndex];
			if (part.type === "text" && part.text.trim()) return part.text;
		}
	}
	return "";
}

export function isFailedResult(result: Pick<SingleResult, "exitCode" | "stopReason">): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || result.stopReason === "context_limit";
}

export function getResultOutput(result: SingleResult): string {
	const warning = result.warning ? `Warning: ${result.warning}\n\n` : "";
	if (isFailedResult(result)) return warning + (result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)");
	const nextIntent = result.nextSessionIntent ? `\n\nNext call to this subagent should use session: "${result.nextSessionIntent}"` : "";
	return warning + (getFinalOutput(result.messages) || "(no output)") + nextIntent;
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text") items.push({ type: "text", text: part.text });
			else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
		}
	}
	return items;
}

export function getNestedSubagentIds(messages: Message[]): string[] {
	return getDisplayItems(messages)
		.filter((item): item is Extract<DisplayItem, { type: "toolCall" }> => item.type === "toolCall" && item.name === "subagent")
		.flatMap((item) => typeof item.args.id === "string" ? [item.args.id] : []);
}

export function makeErrorResult(
	agent: string,
	task: string,
	message: string,
	sessionIntent?: SingleResult["sessionIntent"],
	extra: Partial<Pick<SingleResult, "agentOrigin" | "agentOverride" | "agentThinking" | "errorMessage" | "wrongSessionIntent">> = {},
): SingleResult {
	return {
		agent,
		agentOrigin: extra.agentOrigin ?? "unknown",
		agentOverride: extra.agentOverride,
		agentThinking: extra.agentThinking,
		sessionIntent,
		wrongSessionIntent: extra.wrongSessionIntent,
		task,
		exitCode: 1,
		messages: [],
		stderr: message,
		errorMessage: extra.errorMessage,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
}
