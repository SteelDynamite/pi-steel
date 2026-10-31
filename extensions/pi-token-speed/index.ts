import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { formatSpeed, streamDelta, TokenSpeedTracker } from "./src/token-speed.ts";

export { formatSpeed, streamDelta, TokenSpeedTracker } from "./src/token-speed.ts";

export default function (pi: ExtensionAPI) {
	const tracker = new TokenSpeedTracker();
	const setStatus = (ctx: { ui: Pick<ExtensionUIContext, "setStatus" | "theme"> }, speed: number | undefined) => {
		const text = formatSpeed(speed);
		ctx.ui.setStatus("tokenSpeed", text === undefined ? undefined : ctx.ui.theme.fg("dim", text));
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
