import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";

export default function (pi) {
  const report = { requests: [], ui: [], results: {} };
  pi.registerCommand("manual-fixture", { description: "Manual package sentinel", handler: async () => {} });
  pi.on("session_start", (_event, ctx) => {
    if (process.env.PI_ORCHESTRATED_CHILD !== "1") return;
    // Loaded before the bundled goal handler: an active restored goal must not
    // inject context, evaluate, or continue an orchestrated child.
    pi.appendEntry("goal-state", {
      version: 1, status: "active", condition: "Never finish this fixture goal",
      startedAt: 1, updatedAt: 1, evaluatedTurns: 0, maxEvaluations: 25,
    });
    for (const method of ["setWidget", "setWorkingIndicator"]) {
      const original = ctx.ui[method].bind(ctx.ui);
      ctx.ui[method] = (...args) => { report.ui.push({ method, args }); return original(...args); };
    }
  });
  pi.registerTool({
    name: "child_probe", label: "Child probe", description: "Inspect this isolated child and exercise file safety",
    parameters: Type.Object({ command: Type.Literal("inspect") }),
    async execute(_id, _args, _signal, _update, ctx) {
      const file = join(ctx.cwd, "protected.txt");
      report.child = process.env.PI_ORCHESTRATED_CHILD;
      report.agentDir = process.env.PI_CODING_AGENT_DIR;
      report.memorySettings = JSON.parse(readFileSync(join(report.agentDir, "settings.json"), "utf8"))["observational-memory"];
      report.argv = process.argv;
      report.commands = pi.getCommands();
      report.tools = pi.getAllTools();
      report.callable = ctx.tools.map(tool => tool.name);
      report.results.subagent = await ctx.executeTool("subagent", { id: "worker", session: "new", task: "must not execute" });
      report.results.blocked = await ctx.executeTool("write", { path: file, content: "unsafe" });
      report.afterBlocked = readFileSync(file, "utf8");
      report.results.read = await ctx.executeTool("read", { path: file });
      report.results.written = await ctx.executeTool("write", { path: file, content: "safe" });
      return { content: [{ type: "text", text: "Probe complete" }], details: undefined };
    },
  });
  pi.registerProvider("steel-local", {
    api: "steel-local", baseUrl: "http://invalid.invalid", apiKey: "local-fixture-not-a-credential",
    models: [{ id: "fixture", name: "Local fixture", reasoning: false, input: ["text"],
      contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const child = process.env.PI_ORCHESTRATED_CHILD === "1";
      report.requests.push({ system: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages).map(tool => tool.name) });
      assert(report.requests.length <= 2, "unexpected supervisor/model continuation");
      const first = report.requests.length === 1;
      if (!child && !first) {
        report.result = context.messages.find(message => message.role === "toolResult" && message.toolCallId === "delegate");
        writeFileSync(process.env.STEEL_DELEGATION_REPORT, JSON.stringify(report));
      }
      const content = first ? [child
        ? { type: "toolCall", id: "probe", name: "child_probe", arguments: { command: "inspect" } }
        : { type: "toolCall", id: "delegate", name: "subagent", arguments: { id: "worker", session: "new", task: "Inspect child runtime" } }]
        : [{ type: "text", text: child ? "Child inspection complete" : "Delegation complete" }];
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [], stopReason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      message.content = content;
      if (first) {
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(content[0].arguments), partial: message });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: content[0], partial: message });
      } else {
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: content[0].text, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: content[0].text, partial: message });
      }
      message.stopReason = first ? "toolUse" : "stop";
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
      return stream;
    },
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (process.env.PI_ORCHESTRATED_CHILD !== "1") return;
    report.entries = ctx.sessionManager.getEntries();
    writeFileSync(process.env.STEEL_CHILD_REPORT, JSON.stringify(report));
  });
}
