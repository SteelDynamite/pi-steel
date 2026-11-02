import * as host from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	SessionManager,
	sessionEntryToContextMessages,
	type SessionEntry,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

export const STATE_TYPE = "pi-transcript-rewrite";
export const SUMMARY_TYPE = "pi-transcript-compacted";

export type BlockAction = "keep" | "compact" | "drop";
export type BlockStatus = "keep" | "compacted" | "dropped" | "pi-compacted";
export type BlockMessage = Extract<SessionMessageEntry["message"], { role: "user" | "assistant" | "toolResult" }>;
export type AssistantBlockMessage = Extract<BlockMessage, { role: "assistant" }>;

export interface SourceReference {
	sessionFile: string;
	entryIds: string[];
}

export interface StoredBlock {
	id: string;
	status: BlockStatus;
	source: SourceReference;
	summary?: string;
	currentEntryIds: string[];
}

export interface RewriteState {
	version: 1;
	blocks: StoredBlock[];
}

export interface ReviewBlock extends StoredBlock {
	prompt: string;
	response: string;
	messages?: BlockMessage[];
	choice?: BlockAction;
	readOnlyReason?: "pi-compacted" | "source-missing";
}

export type ContextMessage = ReturnType<typeof convertToLlm>[number];

export interface ReviewContext {
	blocks: ReviewBlock[];
	prefixMessages: ContextMessage[];
	/** Canonical chronology; empty block slots preserve explicit restoration positions. */
	sequence: Array<{ blockId?: string; message?: ContextMessage }>;
}

function project(entries: SessionEntry[]) {
	// Pi 1.4 exposes provenance, so edits and overlapping compactions stay host-owned.
	const projection = (host as unknown as { buildSessionProjection?: (entries: SessionEntry[]) => {
		entries: Array<{ sourceEntry: SessionEntry; messages: ReturnType<typeof sessionEntryToContextMessages> }>;
	} }).buildSessionProjection;
	if (projection) return projection(entries).entries;
	if (entries.some((entry) => entry.type === "context_edit" as string)) {
		throw new Error("Context edits require Pi 1.4 or newer for safe transcript rewriting");
	}
	return host.buildContextEntries(entries).map((sourceEntry, index) => ({
		sourceEntry,
		messages: sourceEntry.type === "compaction" && index > 0 ? [] : sessionEntryToContextMessages(sourceEntry),
	}));
}

function contentText(content: unknown, includeImages: boolean): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block): string[] => {
			if (!block || typeof block !== "object" || !("type" in block)) return [];
			if (block.type === "text" && "text" in block && typeof block.text === "string") return [block.text];
			if (includeImages && block.type === "image") return ["[Image]"];
			return [];
		})
		.join("\n")
		.trim();
}

function describe(messages: readonly BlockMessage[]): { prompt: string; response: string } | undefined {
	const user = messages.find((message) => message.role === "user");
	if (!user) return;
	const prompt = contentText(user.content, true);
	const responses = messages.flatMap((message): string[] => {
		if (message.role !== "assistant") return [];
		const text = contentText(message.content, false);
		return [text, message.errorMessage ? `Error: ${message.errorMessage}` : ""].filter(Boolean);
	});
	return { prompt: prompt || "[Empty prompt]", response: responses.join("\n\n") || "[No assistant response]" };
}

function collectBlocks(entries: readonly SessionEntry[], sessionFile: string): StoredBlock[] {
	const blocks: StoredBlock[] = [];
	let entryIds: string[] = [];

	const flush = () => {
		if (entryIds.length === 0) return;
		blocks.push({
			id: `${sessionFile}#${entryIds[0]}`,
			status: "keep",
			source: { sessionFile, entryIds: [...entryIds] },
			currentEntryIds: [...entryIds],
		});
		entryIds = [];
	};

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "user") {
			flush();
			entryIds.push(entry.id);
			continue;
		}
		if (entryIds.length > 0 && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
			entryIds.push(entry.id);
		}
	}
	flush();
	return blocks;
}

function parseState(data: unknown): RewriteState | undefined {
	if (!data || typeof data !== "object") return;
	const candidate = data as Partial<RewriteState>;
	if (candidate.version !== 1 || !Array.isArray(candidate.blocks)) return;
	for (const block of candidate.blocks) {
		if (!block || typeof block !== "object") return;
		if (typeof block.id !== "string" || !["keep", "compacted", "dropped", "pi-compacted"].includes(block.status)) return;
		if (!block.source || typeof block.source.sessionFile !== "string" || !Array.isArray(block.source.entryIds)) return;
		if (!block.source.entryIds.every((id) => typeof id === "string")) return;
		if (!Array.isArray(block.currentEntryIds) || !block.currentEntryIds.every((id) => typeof id === "string")) return;
		if (block.summary !== undefined && typeof block.summary !== "string") return;
	}
	return candidate as RewriteState;
}

function loadBlockMessages(source: SourceReference, managers: Map<string, SessionManager>): BlockMessage[] | undefined {
	let manager = managers.get(source.sessionFile);
	if (!manager) {
		try {
			manager = SessionManager.open(source.sessionFile);
			managers.set(source.sessionFile, manager);
		} catch {
			return;
		}
	}

	const effective = new Map(project(manager.getBranch()).map((entry) => [entry.sourceEntry.id, entry.messages]));
	const messages: BlockMessage[] = [];
	for (const id of source.entryIds) {
		const projected = effective.get(id);
		if (!projected?.length) return;
		for (const message of projected) {
			if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return;
			messages.push(structuredClone(message));
		}
	}
	return messages;
}

function initialAction(status: BlockStatus): BlockAction | undefined {
	if (status === "keep") return "keep";
	if (status === "compacted") return "compact";
	if (status === "dropped") return "drop";
}

export function buildReviewContext(sessionManager: Pick<SessionManager, "getBranch" | "buildContextEntries" | "getSessionFile">): ReviewContext {
	const branch = sessionManager.getBranch();
	const sessionFile = sessionManager.getSessionFile() ?? "";
	let stateIndex = -1;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type === "custom" && entry.customType === STATE_TYPE) {
			stateIndex = index;
			break;
		}
	}
	const stateEntry = stateIndex >= 0 ? branch[stateIndex] : undefined;
	const state = stateEntry?.type === "custom" ? parseState(stateEntry.data) : undefined;
	const projection = project(branch);
	const effectiveIds = new Set(projection.filter((entry) => entry.messages.length).map((entry) => entry.sourceEntry.id));
	const effectiveMessages = new Map(projection.map((entry) => [entry.sourceEntry.id, entry.messages]));
	const compactionAfterState = stateIndex >= 0 && branch.slice(stateIndex + 1).some((entry) => entry.type === "compaction");
	const records = state
		? [...state.blocks, ...collectBlocks(branch.slice(stateIndex + 1), sessionFile)]
		: collectBlocks(branch, sessionFile);
	const managers = new Map<string, SessionManager>();
	if (sessionFile) managers.set(sessionFile, sessionManager as SessionManager);

	const blocks: ReviewBlock[] = records.map((record) => {
		let status = record.status;
		if (status !== "pi-compacted") {
			const represented = record.currentEntryIds.length > 0 && record.currentEntryIds.every((id) => effectiveIds.has(id));
			if ((status !== "dropped" && !represented) || (status === "dropped" && compactionAfterState)) status = "pi-compacted";
		}
		// A kept block's newest effective branch owns restoration provenance, including later edits.
		const source = status === "keep" && sessionFile
			? { sessionFile, entryIds: record.currentEntryIds }
			: record.source;
		// Ordinary keep/view/summarize uses only effective messages, never raw originals.
		const messages = status === "keep"
			? record.currentEntryIds.flatMap((id) => effectiveMessages.get(id) ?? []).filter((message): message is BlockMessage =>
				message.role === "user" || message.role === "assistant" || message.role === "toolResult").map((message) => structuredClone(message))
			: status === "pi-compacted" ? undefined : loadBlockMessages(source, managers);
		const description = messages ? describe(messages) : undefined;
		const summaryText = status === "compacted"
			? record.currentEntryIds.flatMap((id) => effectiveMessages.get(id) ?? []).map((message) => contentText("content" in message ? message.content : undefined, false)).join("\n")
			: undefined;
		return {
			...record,
			summary: summaryText === undefined ? undefined : summaryText.match(/^The user compacted an earlier conversation block into this context:\n\n<summary>\n([\s\S]*)\n<\/summary>$/)?.[1] ?? summaryText,
			source,
			status,
			prompt: description?.prompt ?? "[Original session unavailable]",
			response: description?.response ?? "",
			messages,
			choice: initialAction(status),
			readOnlyReason: status === "pi-compacted" ? "pi-compacted" : messages ? undefined : "source-missing",
		};
	});

	const owners = new Map(blocks.flatMap((block) => block.currentEntryIds.map((id) => [id, block.id] as const)));
	const sequence: ReviewContext["sequence"] = projection.flatMap(({ sourceEntry, messages }) => {
		if (sourceEntry.type === "custom_message" && sourceEntry.customType === "system-reminder") return [];
		return convertToLlm(messages).map((message) => ({ blockId: owners.get(sourceEntry.id), message: structuredClone(message) }));
	});
	// Dropped and wholly compacted blocks have no canonical entry. Retain their UI/restoration slot.
	for (let index = blocks.length - 1; index >= 0; index--) {
		const block = blocks[index]!;
		if (sequence.some((item) => item.blockId === block.id)) continue;
		const nextIds = new Set(blocks.slice(index + 1).map((next) => next.id));
		const next = sequence.findIndex((item) => item.blockId && nextIds.has(item.blockId));
		sequence.splice(next < 0 ? sequence.length : next, 0, { blockId: block.id });
	}
	const prefixMessages = sequence.flatMap((item) => !item.blockId && item.message ? [item.message] : []);
	return { blocks, prefixMessages, sequence };
}

export function blockIsModified(block: ReviewBlock): boolean {
	return block.choice !== undefined && block.choice !== initialAction(block.status);
}

export function formatPlainTranscript(blocks: readonly ReviewBlock[]): string {
	return blocks
		.map((block, index) => {
			const status = block.readOnlyReason === "pi-compacted" ? "PI-COMPACTED · READ ONLY"
				: block.readOnlyReason === "source-missing" ? "SOURCE MISSING"
				: block.status === "compacted" ? "COMPACTED"
				: block.status === "dropped" ? "DROPPED"
				: "KEEP";
			const body = block.status === "compacted" && block.summary
				? `SUMMARY\n${block.summary}\n\nORIGINAL PROMPT\n${block.prompt}\n\nORIGINAL RESPONSE\n${block.response}`
				: `USER\n${block.prompt}\n\nASSISTANT\n${block.response}`;
			return `BLOCK ${index + 1} · ${status}\n${body}`;
		})
		.join("\n\n----------------------------------------\n\n");
}
