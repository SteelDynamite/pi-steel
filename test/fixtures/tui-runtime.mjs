import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

// Observe actual host components; never replace their rendering or input handling.
const record = (event) => appendFileSync(process.env.STEEL_TUI_REPORT, `${JSON.stringify(event)}\n`);
const active = () => {
  try { return JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "steel.json"), "utf8")).active; }
  catch { return "full"; }
};

export default function (pi) {
  pi.on("session_start", (_event, ctx) => {
    record({ event: "start", active: active(), mode: ctx.mode });
    const setStatus = ctx.ui.setStatus.bind(ctx.ui);
    ctx.ui.setStatus = (key, value) => {
      record({ event: "status", key, value });
      return setStatus(key, value);
    };
    for (const method of ["setFooter", "setEditorComponent", "setWidget"]) {
      const original = ctx.ui[method].bind(ctx.ui);
      ctx.ui[method] = (...args) => {
        const index = method === "setWidget" ? 1 : 0;
        const factory = args[index];
        const owner = method === "setWidget" ? args[0] : method;
        if (typeof factory === "function") {
          args[index] = (...factoryArgs) => {
            const component = factory(...factoryArgs);
            const render = component.render.bind(component);
            let recorded = false;
            component.render = (width) => {
              const lines = render(width);
              if (!recorded && lines.some(line => line.trim())) {
                recorded = true;
                record({ event: "render", active: active(), owner, width, lines });
              }
              return lines;
            };
            return component;
          };
        } else if (Array.isArray(factory)) {
          record({ event: "widget", active: active(), owner, lines: factory });
        }
        return original(...args);
      };
    }
  });
  pi.registerCommand("tui-probe", {
    description: "Record the isolated TUI runtime",
    handler: async (_args, ctx) => {
      record({ event: "probe", active: active(), mode: ctx.mode,
        commands: pi.getCommands().map(command => command.name), tools: pi.getAllTools().map(tool => tool.name) });
      ctx.ui.notify(`TUI probe ${active()}`, "info");
    },
  });
  pi.registerProvider("steel-tui-local", {
    api: "steel-tui-local", baseUrl: "http://invalid.invalid", apiKey: "local-fixture-not-a-credential",
    models: [{ id: "fixture", name: "TUI local fixture", reasoning: false, input: ["text"],
      contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const hasTodo = context.messages.some(message => message.role === "toolResult" && message.toolName === "todo");
      record({ event: "request", active: active(), hasTodo,
        warning: context.messages.some(message => JSON.stringify(message).includes("Saved loadout changes are not applied")) });
      const stream = createAssistantMessageEventStream();
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [], stopReason: "stop",
        usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      // Let the real working widget/timer render before completing the stream.
      setTimeout(() => {
        stream.push({ type: "start", partial: message });
        if (!hasTodo) {
          const toolCall = { type: "toolCall", id: "tui-todo", name: "todo",
            arguments: { action: "add", items: ["TUI coexistence sentinel"], title: "TUI smoke", replace: true } };
          message.content = [toolCall];
          message.stopReason = "toolUse";
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(toolCall.arguments), partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
        } else {
          message.content = [{ type: "text", text: "TUI_LOCAL_COMPLETE" }];
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: message.content[0].text, partial: message });
        }
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      }, 350);
      return stream;
    },
  });
  pi.on("agent_settled", () => record({ event: "settled", active: active() }));
}
