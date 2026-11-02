import assert from "node:assert/strict";
import { promises as fs, writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function (pi) {
	let replacement;
	pi.on("tool_result", async event => {
		if (replacement && event.toolName === replacement.tool && !event.isError) {
			const next = replacement;
			replacement = undefined;
			await fs.writeFile(next.path, "external");
		}
	});
	pi.registerTool({
		name: "rbw_probe", label: "RBW probe", description: "Run isolated file safety regressions",
		parameters: Type.Object({}),
		async execute(_id, _args, _signal, _update, ctx) {
			const file = path.join(ctx.cwd, "file.txt");
			const call = (name, args) => ctx.executeTool(name, { path: file, ...args });
			const ok = async (name, args) => {
				const result = await call(name, args);
				assert.notEqual(result.isError, true, JSON.stringify(result));
				return result.result;
			};
			const blocked = async (name, args, reason) => {
				const result = await call(name, args);
				assert.equal(result.isError, true, JSON.stringify(result));
				assert.match(JSON.stringify(result.result.content), reason);
			};
			await fs.writeFile(file, "one");
			await blocked("write", { content: "bad" }, /has not been read/);
			replacement = { tool: "read", path: file };
			assert.equal((await ok("read", {})).content[0].text, "one");
			await blocked("write", { content: "bad" }, /changed on disk/);
			await blocked("edit", { edits: [{ oldText: "external", newText: "bad" }] }, /changed on disk/);
			await ok("read", {});
			await ok("edit", { edits: [{ oldText: "external", newText: "own" }] });
			await ok("edit", { edits: [{ oldText: "own", newText: "next" }] });
			for (const tool of ["write", "edit"]) {
				replacement = { tool, path: file };
				await ok(tool, tool === "write" ? { content: "produced" } : { edits: [{ oldText: "next", newText: "produced" }] });
				await blocked("write", { content: "bad" }, /changed on disk/);
				await ok("read", {});
				await ok("write", { content: "next" });
			}
			const actual = path.join(ctx.cwd, "cafe\u0301.txt");
			await fs.writeFile(actual, "unicode");
			const read = await ctx.executeTool("read", { path: "caf\u00e9.txt", limit: 1 });
			assert.equal(read.result.content[0].text, "unicode");
			assert.notEqual((await ctx.executeTool("write", { path: actual, content: "safe" })).isError, true);
			await fs.symlink(ctx.cwd, path.join(ctx.cwd, "alias"), "dir");
			await fs.rm(file);
			const deleted = await ctx.executeTool("write", { path: path.join(ctx.cwd, "alias", "file.txt"), content: "bad" });
			assert.equal(deleted.isError, true);
			assert.match(JSON.stringify(deleted.result.content), /deleted since the last read/);
			await fs.writeFile(path.join(ctx.cwd, "passed"), "actual host pipeline passed");
			return { content: [{ type: "text", text: "Probe passed" }], details: undefined };
		},
	});
	let requests = 0;
	pi.registerProvider("rbw-local", {
		api: "rbw-local", baseUrl: "http://invalid.invalid", apiKey: "local-fixture-not-a-credential",
		models: [{ id: "fixture", name: "Local fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model, context) {
			assert(++requests <= 2, "unexpected model request");
			if (requests === 2) writeFileSync("host-results.json", JSON.stringify(context.messages.filter(message => message.role === "toolResult")));
			const first = requests === 1;
			const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
				content: first ? [{ type: "toolCall", id: "probe", name: "rbw_probe", arguments: {} }] : [{ type: "text", text: "Done" }],
				stopReason: first ? "toolUse" : "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end();
			return stream;
		},
	});
}
