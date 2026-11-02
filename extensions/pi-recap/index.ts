import { randomUUID } from "node:crypto";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
	automaticRecapEligible,
	buildRecapPrompt,
	CUSTOM_TYPE,
	IDLE_DELAY_MS,
	parseGeneratedRecap,
	recapProgress,
	RETRY_DELAY_MS,
	type StoredRecap,
} from "./src/recap.ts";

export * from "./src/recap.ts";

// The standalone development lock predates Pi 1.4's provider-neutral facade.
// Keep this adapter limited to the runtime method; do not fall back to complete().
type RecapRegistry = ExtensionContext["modelRegistry"] & {
	streamSimple(
		model: NonNullable<ExtensionContext["model"]>,
		context: Parameters<ExtensionContext["modelRegistry"]["complete"]>[1],
		options: { signal: AbortSignal; maxTokens: number; cacheRetention: "none"; sessionId: string },
	): { result(): ReturnType<ExtensionContext["modelRegistry"]["complete"]> };
};

interface RuntimeOptions {
	idleDelayMs?: number;
	retryDelayMs?: number;
	requestTimeoutMs?: number;
}

function responseText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text"
			&& typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text)
		.join("\n");
}

function displayText(text: string): string {
	return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
}

export function createRecapExtension(options: RuntimeOptions = {}) {
	const idleDelayMs = options.idleDelayMs ?? IDLE_DELAY_MS;
	const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
	const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;

	return function recapExtension(pi: ExtensionAPI) {
		let timer: NodeJS.Timeout | undefined;
		let generation: {
			controller: AbortController;
			ctx: ExtensionContext;
			leafId: string | null;
			trigger: "automatic" | "manual";
		} | undefined;

		const clearTimer = () => {
			if (timer) clearTimeout(timer);
			timer = undefined;
		};

		const cancelGeneration = () => {
			const active = generation;
			generation = undefined;
			if (!active) return;
			active.controller.abort();
			active.ctx.ui.setStatus(CUSTOM_TYPE, undefined);
		};

		const cancelAll = () => {
			clearTimer();
			cancelGeneration();
		};

		const automaticEnabled = (ctx: ExtensionContext) =>
			ctx.mode === "tui" && process.env.PI_ORCHESTRATED_CHILD !== "1";

		const generate = async (
			ctx: ExtensionContext,
			trigger: "automatic" | "manual",
			expectedLeaf = ctx.sessionManager.getLeafId(),
			attempt = 0,
		): Promise<void> => {
			if (generation) {
				if (trigger === "manual" && ctx.hasUI) ctx.ui.notify("A recap is already being generated.", "warning");
				return;
			}
			if (expectedLeaf !== ctx.sessionManager.getLeafId()) return;
			const entries = ctx.sessionManager.getBranch() as SessionEntry[];
			const messages = buildSessionContext(entries).messages;
			if (trigger === "automatic" && (
				!automaticEnabled(ctx)
				|| !ctx.isIdle()
				|| ctx.hasPendingMessages()
				|| ctx.ui.getEditorText().trim().length > 0
				|| !automaticRecapEligible(entries)
			)) return;
			const prompt = buildRecapPrompt(entries, messages);
			if (!prompt) {
				if (trigger === "manual" && ctx.hasUI) ctx.ui.notify("No conversation history to recap.", "warning");
				return;
			}
			const model = ctx.model;
			if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
				if (trigger === "manual" && ctx.hasUI) ctx.ui.notify("The active model is unavailable for recap generation.", "warning");
				return;
			}

			const active = {
				controller: new AbortController(),
				ctx,
				leafId: expectedLeaf,
				trigger,
			};
			generation = active;
			ctx.ui.setStatus(CUSTOM_TYPE, "Generating recap…");
			let retry = false;
			const deadline = new AbortController();
			const timeout = setTimeout(() => deadline.abort(new Error("Recap generation timed out.")), requestTimeoutMs);
			const signal = AbortSignal.any([active.controller.signal, deadline.signal, ...(ctx.signal ? [ctx.signal] : [])]);
			let onAbort: (() => void) | undefined;
			try {
				signal.throwIfAborted();
				// Race the deadline too: a provider or credential resolver may ignore abort.
				const aborted = new Promise<never>((_resolve, reject) => {
					onAbort = () => reject(signal.reason);
					signal.addEventListener("abort", onAbort, { once: true });
				});
				const result = (ctx.modelRegistry as RecapRegistry).streamSimple(
					model,
					{
						messages: [{
							role: "user",
							content: [{ type: "text", text: prompt }],
							timestamp: Date.now(),
						}],
					},
					{
						signal,
						maxTokens: 1_024,
						cacheRetention: "none",
						sessionId: randomUUID(),
					},
				).result();
				const response = await Promise.race([result, aborted]);
				signal.throwIfAborted();
				if (generation !== active) return;
				if (response.stopReason !== "stop") throw new Error(response.errorMessage ?? `Recap response ended with ${response.stopReason}.`);
				if (expectedLeaf !== ctx.sessionManager.getLeafId() || !ctx.isIdle() || ctx.hasPendingMessages()) return;
				const parsed = parseGeneratedRecap(responseText(response.content));
				if (!parsed) throw new Error(response.errorMessage ?? "The model returned an invalid recap.");

				const data: StoredRecap = {
					version: 1,
					...parsed,
					generatedAt: new Date().toISOString(),
					leafId: expectedLeaf,
					completedTurns: recapProgress(entries).completedTurns,
					trigger,
					model: `${model.provider}/${model.id}`,
					usage: response.usage,
				};
				pi.appendEntry(CUSTOM_TYPE, data);
				if (ctx.mode === "rpc") ctx.ui.notify(`Recap: ${data.summary}`, "info");
			} catch (error) {
				if (active.controller.signal.aborted || ctx.signal?.aborted || generation !== active) return;
				retry = trigger === "automatic" && attempt === 0
					&& expectedLeaf === ctx.sessionManager.getLeafId() && ctx.isIdle();
				if (!retry && ctx.hasUI) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Could not generate recap: ${message}`, "warning");
				}
			} finally {
				clearTimeout(timeout);
				if (onAbort) signal.removeEventListener("abort", onAbort);
				if (generation === active) {
					generation = undefined;
					ctx.ui.setStatus(CUSTOM_TYPE, undefined);
				}
			}

			if (retry && generation === undefined) {
				timer = setTimeout(() => {
					timer = undefined;
					void generate(ctx, "automatic", expectedLeaf, 1);
				}, retryDelayMs);
				timer.unref();
			}
		};

		const scheduleAutomatic = (ctx: ExtensionContext, delayMs = idleDelayMs) => {
			clearTimer();
			if (!automaticEnabled(ctx)) return;
			const entries = ctx.sessionManager.getBranch() as SessionEntry[];
			if (!automaticRecapEligible(entries)) return;
			const leafId = ctx.sessionManager.getLeafId();
			timer = setTimeout(() => {
				timer = undefined;
				void generate(ctx, "automatic", leafId);
			}, Math.max(0, delayMs));
			timer.unref();
		};

		pi.registerEntryRenderer<StoredRecap>(CUSTOM_TYPE, (entry, { expanded }, theme) => {
			const data = entry.data;
			if (!data || data.version !== 1 || typeof data.summary !== "string") return undefined;
			let text = theme.fg("dim", "↳ Recap: ") + displayText(data.summary);
			if (expanded) {
				const rawCost = (data.usage as { cost?: { total?: unknown } } | undefined)?.cost?.total;
				const cost = typeof rawCost === "number" && Number.isFinite(rawCost) ? ` · $${rawCost.toFixed(4)}` : "";
				const trigger = data.trigger === "automatic" || data.trigger === "manual" ? data.trigger : "unknown";
				const model = typeof data.model === "string" ? displayText(data.model) : "unknown model";
				text += `\n${theme.fg("dim", `${trigger} · ${model}${cost}`)}`;
			}
			const box = new Box(1, 0, (line) => theme.bg("customMessageBg", line));
			box.addChild(new Text(text, 0, 0));
			return box;
		});

		pi.registerCommand("recap", {
			description: "Summarize the current session without adding the recap to model context",
			handler: async (_args, ctx: ExtensionCommandContext) => {
				await ctx.waitForIdle();
				cancelAll();
				await generate(ctx, "manual");
			},
		});

		pi.on("session_start", (_event, ctx) => {
			cancelAll();
			const entries = ctx.sessionManager.getBranch() as SessionEntry[];
			const { lastAssistantAt } = recapProgress(entries);
			const elapsed = lastAssistantAt === undefined ? 0 : Math.max(0, Date.now() - lastAssistantAt);
			scheduleAutomatic(ctx, Math.max(0, idleDelayMs - elapsed));
		});

		pi.on("agent_start", () => cancelAll());
		pi.on("input", () => {
			cancelAll();
			return { action: "continue" };
		});
		pi.on("model_select", (_event, ctx) => {
			cancelAll();
			scheduleAutomatic(ctx);
		});
		pi.on("agent_settled", (_event, ctx) => scheduleAutomatic(ctx));
		pi.on("session_shutdown", () => cancelAll());
	};
}

export default createRecapExtension();
