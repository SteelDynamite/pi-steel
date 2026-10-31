import assert from "node:assert/strict";
import test from "node:test";
import { createRecapExtension } from "../index.ts";
import {
	automaticRecapEligible,
	buildRecapHistory,
	buildRecapPrompt,
	CUSTOM_TYPE,
	MAX_PROMPT_BYTES,
	parseGeneratedRecap,
	recapProgress,
} from "../src/recap.ts";

function conversation(turns: number, pending?: string) {
	const entries: any[] = [];
	let parentId: string | null = null;
	let id = 0;
	for (let turn = 0; turn < turns; turn++) {
		const userId = `entry-${id++}`;
		entries.push({
			type: "message",
			id: userId,
			parentId,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: `request ${turn}`, timestamp: Date.now() },
		});
		parentId = userId;
		const assistantId = `entry-${id++}`;
		entries.push({
			type: "message",
			id: assistantId,
			parentId,
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: `result ${turn}` }],
				provider: "test",
				model: "model",
				api: "test",
				usage: {},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		});
		parentId = assistantId;
	}
	if (pending) {
		entries.push({
			type: "message",
			id: `entry-${id}`,
			parentId,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: pending, timestamp: Date.now() },
		});
	}
	return entries;
}

function harness(entries: any[], extension = createRecapExtension()) {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	let command: ((args: string, ctx: any) => Promise<void>) | undefined;
	let renderer: ((entry: any, options: any, theme: any) => any) | undefined;
	const appended: Array<{ customType: string; data: any }> = [];
	const statuses: Array<string | undefined> = [];
	const notifications: string[] = [];
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => any) {
			handlers.set(name, handler);
		},
		registerCommand(name: string, definition: any) {
			assert.equal(name, "recap");
			command = definition.handler;
		},
		registerEntryRenderer(customType: string, value: any) {
			assert.equal(customType, CUSTOM_TYPE);
			renderer = value;
		},
		appendEntry(customType: string, data: any) {
			appended.push({ customType, data });
		},
	} as any;
	extension(pi);
	const ctx = {
		mode: "tui",
		hasUI: true,
		model: { provider: "test", id: "recap-model" },
		modelRegistry: {
			hasConfiguredAuth: () => true,
			complete: async () => ({
				content: [{ type: "text", text: "Implemented recap persistence. Run validation." }],
				usage: { cost: { total: 0.0012 } },
				stopReason: "stop",
			}),
		},
		sessionManager: {
			getBranch: () => entries,
			getLeafId: () => entries.at(-1)?.id ?? null,
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		waitForIdle: async () => {},
		ui: {
			getEditorText: () => "",
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			notify: (message: string) => notifications.push(message),
		},
	};
	return { handlers, command: () => command!, renderer: () => renderer!, appended, statuses, notifications, ctx };
}

test("history keeps eight answered exchanges plus a pending request", () => {
	const history = buildRecapHistory(conversation(10, "latest correction"));
	assert.doesNotMatch(history, /request 0|request 1/);
	assert.match(history, /request 2/);
	assert.match(history, /result 9/);
	assert.match(history, /Pending user request: latest correction/);
});

test("history excludes tool output and stays within the prompt byte ceiling", () => {
	const entries = conversation(3);
	entries.splice(2, 0, {
		type: "message",
		id: "tool",
		parentId: entries[1].id,
		timestamp: new Date().toISOString(),
		message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "SECRET_TOOL_OUTPUT" }] },
	});
	entries[entries.length - 1].message.content[0].text = "界".repeat(20_000);
	const prompt = buildRecapPrompt(entries);
	assert.doesNotMatch(prompt, /SECRET_TOOL_OUTPUT/);
	assert.ok(Buffer.byteLength(prompt) <= MAX_PROMPT_BYTES);
	assert.match(prompt, /excerpted/);
});

test("recap parsing accepts plain text and rejects empty or oversized output", () => {
	assert.deepEqual(parseGeneratedRecap("Done.\u001b[31m"), { summary: "Done.[31m" });
	assert.equal(parseGeneratedRecap(" \n\t "), undefined);
	assert.equal(parseGeneratedRecap("x".repeat(701)), undefined);
});

test("automatic eligibility survives resume through custom recap entries", () => {
	const entries = conversation(3);
	assert.equal(automaticRecapEligible(entries), true);
	entries.push({
		type: "custom",
		customType: CUSTOM_TYPE,
		id: "recap",
		parentId: entries.at(-1).id,
		timestamp: new Date().toISOString(),
		data: { version: 1, completedTurns: 3 },
	});
	assert.equal(automaticRecapEligible(entries), false);
	entries.push(...conversation(2).map((entry, index) => ({ ...entry, id: `later-${index}` })));
	assert.equal(recapProgress(entries).completedTurns, 5);
	assert.equal(automaticRecapEligible(entries), true);
});

test("manual recap appends a display-only custom entry and renders persisted data", async () => {
	const h = harness(conversation(3));
	await h.command()("", h.ctx);
	assert.equal(h.appended.length, 1);
	assert.equal(h.appended[0].customType, CUSTOM_TYPE);
	assert.equal(h.appended[0].data.summary, "Implemented recap persistence. Run validation.");
	assert.deepEqual(h.statuses, ["Generating recap…", undefined]);

	const component = h.renderer()(
		{ data: h.appended[0].data },
		{ expanded: true },
		{
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
		},
	);
	const rendered = component.render(100).join("\n");
	assert.match(rendered, /↳ Recap: Implemented recap persistence\. Run validation\./);
	assert.doesNotMatch(rendered, /Next:/);
	assert.match(rendered, /manual · test\/recap-model · \$0\.0012/);
});

test("settled sessions generate automatically after the configured delay", async () => {
	const h = harness(conversation(3), createRecapExtension({ idleDelayMs: 5, requestTimeoutMs: 1_000 }));
	h.handlers.get("agent_settled")!({}, h.ctx);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(h.appended.length, 1);
	assert.equal(h.appended[0].data.trigger, "automatic");
	h.handlers.get("session_shutdown")!({}, h.ctx);
});
