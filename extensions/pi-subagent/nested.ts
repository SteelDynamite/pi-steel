import { MAX_NESTED_SUBAGENTS_PER_RESULT, NESTED_SUBAGENT_DETAIL_CAP } from "./constants.ts";
import type { NestedSubagentCall, SingleResult, SubagentDetails, UsageStats } from "./types.ts";

function isSubagentDetails(value: unknown): value is SubagentDetails {
	const details = value as Partial<SubagentDetails> | undefined;
	return Boolean(details && Array.isArray(details.results));
}

function truncateUtf8(text: string | undefined, maxBytes: number): string | undefined {
	if (text === undefined || Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const marker = "\n[truncated]";
	let truncated = "";
	let bytes = Buffer.byteLength(marker);
	for (const character of text) {
		bytes += Buffer.byteLength(character);
		if (bytes > maxBytes) break;
		truncated += character;
	}
	return truncated + marker;
}

function capResult(result: SingleResult): SingleResult {
	return { ...result, task: truncateUtf8(result.task, 1024) ?? "", messages: [], stdout: truncateUtf8(result.stdout, 2048), stderr: truncateUtf8(result.stderr, 2048) ?? "", warning: truncateUtf8(result.warning, 512), errorMessage: truncateUtf8(result.errorMessage, 512), nestedSubagents: result.nestedSubagents?.slice(0, 2).map((nested) => ({ toolCallId: nested.toolCallId, toolName: nested.toolName, status: nested.status, error: truncateUtf8(nested.error, 512), truncated: true })) };
}

function capDetails(details: SubagentDetails): { details: SubagentDetails; truncated: boolean } {
	if (Buffer.byteLength(JSON.stringify(details), "utf8") <= NESTED_SUBAGENT_DETAIL_CAP) return { details, truncated: false };
	const capped = { includeLocationalAgents: details.includeLocationalAgents, locationalAgents: [], results: details.results.slice(0, 1).map(capResult) };
	// Unknown fields and JSON escaping can defeat field-by-field limits.
	if (Buffer.byteLength(JSON.stringify(capped)) > NESTED_SUBAGENT_DETAIL_CAP / 2) capped.results = [];
	return { details: capped, truncated: true };
}

function resultText(result: any): string | undefined { return result?.content?.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n").trim() || undefined; }

export function applyNestedSubagentEvent(result: SingleResult, event: any): boolean {
	if (!event || event.toolName !== "subagent" || typeof event.toolCallId !== "string" || !["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(event.type)) return false;
	result.nestedSubagents ??= [];
	let nested = result.nestedSubagents.find((call) => call.toolCallId === event.toolCallId);
	if (!nested) {
		if (result.nestedSubagents.length >= MAX_NESTED_SUBAGENTS_PER_RESULT) return false;
		nested = { toolCallId: event.toolCallId, toolName: "subagent", status: "running" };
		result.nestedSubagents.push(nested);
	}
	if (event.type === "tool_execution_start") { nested.status = "running"; nested.error = undefined; }
	const source = event.type === "tool_execution_update" ? event.partialResult?.details : event.result?.details;
	if (isSubagentDetails(source)) { const capped = capDetails(source); nested.details = capped.details; nested.truncated ||= capped.truncated; }
	if (event.type === "tool_execution_end") {
		nested.status = event.isError ? "failed" : "completed";
		const error = event.isError ? resultText(event.result) ?? "Nested subagent call failed" : undefined;
		nested.error = truncateUtf8(error, 2048);
		nested.truncated ||= nested.error !== error;
	}
	if (Buffer.byteLength(JSON.stringify(nested)) > NESTED_SUBAGENT_DETAIL_CAP) {
		nested.details = undefined;
		nested.toolCallId = truncateUtf8(nested.toolCallId, 1024) ?? "";
		nested.truncated = true;
	}
	return true;
}
