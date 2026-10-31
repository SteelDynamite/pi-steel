import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "./pi-compat.ts";
import { COLLAPSED_ITEM_COUNT, MAX_NESTED_RENDER_DEPTH, MAX_NESTED_RENDER_LINES } from "./constants.ts";
import { formatUsageStats, getDisplayItems, getFinalOutput, getNestedSubagentIds, isFailedResult } from "./result.ts";
import type { NestedSubagentCall, SingleResult, SubagentDetails } from "./types.ts";
import { formatTokenSpeed } from "./token-speed.ts";

function preview(text: string, max = 120): string { const line = text.replace(/\s+/g, " ").trim(); return line.length > max ? `${line.slice(0, max)}...` : line; }

function formatRequestedSpeed(speed: SingleResult["requestedSpeed"]): string {
	return speed === "ultrafast" ? " · Ultrafast requested" : "";
}

export function formatNestedSubagentsForDisplay(
	calls: NestedSubagentCall[] | undefined,
	themeFg: (color: any, text: string) => string = (_color, text) => text,
	depth = 0,
): string {
	if (!calls?.length) return "";
	const lines: string[] = [];
	const visit = (items: NestedSubagentCall[], currentDepth: number) => {
		if (currentDepth >= MAX_NESTED_RENDER_DEPTH) { lines.push(`${"  ".repeat(currentDepth)}${themeFg("muted", "↳ ... nested subagents depth cap")}`); return; }
		for (const call of items) {
			if (lines.length >= MAX_NESTED_RENDER_LINES) return;
			const icon = call.status === "running" ? themeFg("warning", "⏳") : call.status === "failed" ? themeFg("error", "✗") : themeFg("success", "✓");
			lines.push(`${"  ".repeat(currentDepth)}${themeFg("muted", "↳")} ${icon} ${themeFg("toolTitle", call.toolName)} ${themeFg("muted", `[${call.status}]`)}`);
			if (call.error) lines.push(`${"  ".repeat(currentDepth + 1)}${themeFg("error", `Error: ${preview(call.error)}`)}`);
			for (const result of call.details?.results ?? []) {
				lines.push(`${"  ".repeat(currentDepth + 1)}${themeFg("accent", result.agent)}${themeFg("muted", formatRequestedSpeed(result.requestedSpeed) + formatTokenSpeed(result.tokenSpeed))} ${themeFg("dim", preview(getFinalOutput(result.messages) || result.errorMessage || result.stderr || "(running...)"))}`);
				visit(result.nestedSubagents ?? [], currentDepth + 1);
			}
		}
	};
	visit(calls, depth);
	if (lines.length >= MAX_NESTED_RENDER_LINES) lines.push(themeFg("muted", "... nested subagents render cap"));
	return lines.join("\n");
}

function formatCall(args: { id?: string; session?: string; task?: string }, theme: any, override = false): string {
	const task = args.task ? preview(args.task, 60) : "...";
	return `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.id || "...")}${override ? theme.fg("muted", " (override)") : ""}${args.session ? theme.fg("muted", ` [session:${args.session}]`) : ""}\n  ${theme.fg("dim", task)}`;
}

function formatStatus(agent: SingleResult, running: boolean, theme: any): string {
	const status = running ? "⏳ running" : isFailedResult(agent) ? `✗ ${agent.stopReason || "failed"}` : "✓ completed";
	return `${theme.fg(running ? "warning" : isFailedResult(agent) ? "error" : "success", status)}${theme.fg("muted", ` · ${agent.model || "default"} · ${agent.agentThinking || "default"}${formatRequestedSpeed(agent.requestedSpeed)}${formatTokenSpeed(agent.tokenSpeed)}`)}`;
}

export function renderSubagentCall(args: { id?: string; session?: string; task?: string }, theme: any, context: any) {
	const component = context?.lastComponent ?? new Text("", 0, 0);
	context?.state && (context.state.subagentCall = { args, component, theme });
	component.setText(formatCall(args, theme, context?.state?.subagentOverride === true));
	return component;
}

export function renderSubagentResult(result: any, { expanded, isPartial = false }: { expanded: boolean; isPartial?: boolean }, theme: any, context: any) {
	const details = result.details as SubagentDetails | undefined;
	const agent = details?.results[0];
	if (!agent) return new Text(result.content?.[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
	if (context?.state?.subagentCall) {
		context.state.subagentOverride = agent.agentOverride === true;
		const call = context.state.subagentCall;
		call.component.setText(formatCall(call.args, call.theme, context.state.subagentOverride));
	}
	const running = isPartial || agent.exitCode === -1;
	const failed = !running && isFailedResult(agent);
	const status = formatStatus(agent, running, theme);
	const nested = formatNestedSubagentsForDisplay(agent.nestedSubagents, theme.fg.bind(theme));
	const display = getDisplayItems(agent.messages);
	const output = getFinalOutput(agent.messages);
	const compactOutput = display.slice(-COLLAPSED_ITEM_COUNT).filter((item) => item.type === "text").map((item) => preview(item.text)).join("\n");
	if (!expanded) {
		let text = status;
		const nestedIds = getNestedSubagentIds(agent.messages);
		if (nestedIds.length && !nested) text += theme.fg("dim", ` +${nestedIds.length} nested`);
		if (nested) text += `\n${nested}`;
		if (agent.warning) text += `\n${theme.fg("warning", `Warning: ${agent.warning}`)}`;
		if (agent.wrongSessionIntent) text += `\n${theme.fg("error", `Wrong session intent; retry: ${agent.wrongSessionIntent.recommendedRetry}`)}`;
		else if (failed && agent.errorMessage) text += `\n${theme.fg("error", `Error: ${agent.errorMessage}`)}`;
		else if (compactOutput) text += `\n${theme.fg("toolOutput", compactOutput)}`;
		else if (!running) text += `\n${theme.fg("muted", "(no output)")}`;
		const usage = formatUsageStats(agent.usage);
		if (usage) text += `\n${theme.fg("dim", usage)}`;
		return new Text(text, 0, 0);
	}
	const container = new Container();
	container.addChild(new Text(status, 0, 0));
	if (nested) container.addChild(new Text(nested, 0, 0));
	if (agent.warning) container.addChild(new Text(theme.fg("warning", `Warning: ${agent.warning}`), 0, 0));
	if (agent.wrongSessionIntent) container.addChild(new Text(theme.fg("error", `Wrong session intent; retry: ${agent.wrongSessionIntent.recommendedRetry}`), 0, 0));
	else if (agent.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${agent.errorMessage}`), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
	container.addChild(new Text(theme.fg("dim", agent.task), 0, 0));
	if (output || !running) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
		container.addChild(output ? new Markdown(output.trim(), 0, 0, getMarkdownTheme()) : new Text(theme.fg("muted", "(no output)"), 0, 0));
	}
	const usage = formatUsageStats(agent.usage);
	if (usage) { container.addChild(new Spacer(1)); container.addChild(new Text(theme.fg("dim", usage), 0, 0)); }
	return container;
}
