import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatSpeed, streamDelta, TokenSpeedTracker } from "./src/token-speed.ts";

export { formatSpeed, streamDelta, TokenSpeedTracker } from "./src/token-speed.ts";

export default function (pi: ExtensionAPI) {
	const tracker = new TokenSpeedTracker();
	const setStatus = (ctx: Pick<ExtensionContext, "ui" | "hasUI" | "mode">, speed: number | undefined) => {
		if (!ctx.hasUI) return;
		const text = formatSpeed(speed);
		// RPC supports status text but does not initialize the terminal theme.
		ctx.ui.setStatus("tokenSpeed", text !== undefined && ctx.mode === "tui" ? ctx.ui.theme.fg("dim", text) : text);
	};

	pi.on("agent_start", (_event, ctx) => {
		tracker.startRun();
		setStatus(ctx, undefined);
	});

	pi.on("message_update", (event, ctx) => {
		if (event.assistantMessageEvent.type === "start") tracker.beginCall();
		const delta = streamDelta(event.assistantMessageEvent);
		if (delta === undefined) return;
		setStatus(ctx, tracker.addDelta(delta, Date.now()));
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		setStatus(ctx, tracker.endCall(event.message.usage?.output));
	});
}
