import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";

const target = "steel-one-off/audit";
const calls = [
  { id: "reviewer", session: "new", task: "case:role", overrides: { model: target, thinking: "high", tools: ["read", "grep"] } },
  { id: "inline-audit", session: "new", task: "case:inline", custom: { instructions: "INLINE_AUDIT_INSTRUCTIONS\n@literal-not-an-include.md", model: target, thinking: "low", tools: ["read"] } },
  { id: "no-tools", session: "new", task: "case:empty", custom: { instructions: "NO_TOOLS_INSTRUCTIONS", model: target, tools: [] } },
  { id: "reviewer", session: "new", task: "case:missing", overrides: { model: "steel-one-off/nonexistent" } },
  { id: "reviewer", session: "new", task: "case:collision", custom: { instructions: "Must not replace reviewer" } },
  { id: "reviewer", session: "new", task: "case:parent-only", overrides: { model: "steel-one-off/aud" } },
];

export default function (pi) {
  let requests = 0;
  pi.registerProvider("steel-one-off", {
    api: "steel-one-off", apiKey: "local-fixture", baseUrl: "http://invalid.invalid",
    models: (process.env.PI_ORCHESTRATED_CHILD === "1" ? ["parent", "audit"] : ["parent", "audit", "aud"]).map(id => ({ id, name: id, reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    streamSimple(model, context, options) {
      const child = process.env.PI_ORCHESTRATED_CHILD === "1";
      requests++;
      assert(requests <= (child ? 1 : calls.length + 1), "unexpected model continuation");
      let content;
      if (child) {
        const report = {
          model: `${model.provider}/${model.id}`, thinking: options.reasoning,
          tools: getCurrentTools(context.messages).map(tool => tool.name).sort(),
          system: getCurrentSystemPrompt(context.messages), argv: process.argv,
          cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
          child: process.env.PI_ORCHESTRATED_CHILD,
        };
        content = [{ type: "text", text: JSON.stringify(report) }];
      } else {
        assert(getCurrentTools(context.messages).some(tool => tool.name === "subagent"));
        const results = context.messages.filter(message => message.role === "toolResult");
        if (requests > calls.length) {
          writeFileSync(process.env.STEEL_ONE_OFF_REPORT, JSON.stringify(results));
          content = [{ type: "text", text: "one-off validation complete" }];
        } else {
          content = [{ type: "toolCall", id: `one-off-${requests}`, name: "subagent", arguments: calls[requests - 1] }];
        }
      }
      const message = { role: "assistant", provider: model.provider, model: model.id, api: model.api,
        timestamp: Date.now(), content, stopReason: content[0].type === "toolCall" ? "toolUse" : "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
      return stream;
    },
  });
}
