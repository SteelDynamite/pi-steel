import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "mindful.json");
const WIDGET_ID = "pi-mindful";
const WIDTH = 60;
const BAR_WIDTH = 10;
const TICK_MS = 120;

type ExerciseId = "coherent" | "sigh" | "box" | "478";
type StyleId = "aurora" | "pulse" | "ripples" | "dots" | "wave" | "random";
type Placement = "above" | "below";

type Config = {
	enabled: boolean;
	exercise: ExerciseId;
	style: StyleId;
	delaySeconds: number;
	placement: Placement;
};

type Phase = {
	label: string;
	duration: number;
	to: number;
};

type BreathState = {
	exerciseName: string;
	phase: string;
	remaining: number;
	progress: number;
	cycle: number;
};

const DEFAULT_CONFIG: Config = {
	enabled: true,
	exercise: "coherent",
	style: "aurora",
	delaySeconds: 5,
	placement: "below",
};

const EXERCISES: Record<ExerciseId, { name: string; phases: Phase[] }> = {
	coherent: {
		name: "Coherent breathing",
		phases: [
			{ label: "Breathe in", duration: 5.5, to: 1 },
			{ label: "Breathe out", duration: 5.5, to: 0 },
		],
	},
	sigh: {
		name: "Physiological sigh",
		phases: [
			{ label: "Breathe in", duration: 4, to: 0.82 },
			{ label: "Sip in", duration: 1, to: 1 },
			{ label: "Long exhale", duration: 10, to: 0 },
		],
	},
	box: {
		name: "Box breathing",
		phases: [
			{ label: "Breathe in", duration: 4, to: 1 },
			{ label: "Hold", duration: 4, to: 1 },
			{ label: "Breathe out", duration: 4, to: 0 },
			{ label: "Hold", duration: 4, to: 0 },
		],
	},
	478: {
		name: "4-7-8 breathing",
		phases: [
			{ label: "Breathe in", duration: 4, to: 1 },
			{ label: "Hold", duration: 7, to: 1 },
			{ label: "Breathe out", duration: 8, to: 0 },
		],
	},
};

const STYLE_IDS: Exclude<StyleId, "random">[] = ["aurora", "pulse", "ripples", "dots", "wave"];
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function color(text: string, rgb: readonly number[]): string {
	return `\x1b[38;2;${rgb[0] ?? 255};${rgb[1] ?? 255};${rgb[2] ?? 255}m${text}${RESET}`;
}

function center(text: string, width = WIDTH): string {
	if (text.length >= width) return text;
	return `${" ".repeat(Math.floor((width - text.length) / 2))}${text}`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function ease(value: number): number {
	return 1 - (1 - value) * (1 - value);
}

async function loadConfig(): Promise<Config> {
	try {
		const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Partial<Config>;
		return normalizeConfig(raw);
	} catch {
		return DEFAULT_CONFIG;
	}
}

function normalizeConfig(raw: Partial<Config>): Config {
	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
		exercise: typeof raw.exercise === "string" && Object.hasOwn(EXERCISES, raw.exercise) ? raw.exercise : DEFAULT_CONFIG.exercise,
		style: raw.style && ([...STYLE_IDS, "random"] as string[]).includes(raw.style) ? raw.style : DEFAULT_CONFIG.style,
		delaySeconds: Number.isFinite(raw.delaySeconds) ? clamp(Number(raw.delaySeconds), 0, 120) : DEFAULT_CONFIG.delaySeconds,
		placement: raw.placement === "above" || raw.placement === "below" ? raw.placement : DEFAULT_CONFIG.placement,
	};
}

async function saveConfig(config: Config): Promise<void> {
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function breathState(config: Config, startedAt: number): BreathState {
	const exercise = EXERCISES[config.exercise];
	const elapsed = (Date.now() - startedAt) / 1000;
	const total = exercise.phases.reduce((sum, phase) => sum + phase.duration, 0);
	const cyclePosition = elapsed % total;
	let cursor = 0;
	let from = exercise.phases.at(-1)?.to ?? 0;

	for (const phase of exercise.phases) {
		if (cyclePosition <= cursor + phase.duration) {
			const local = clamp((cyclePosition - cursor) / phase.duration, 0, 1);
			const moving = phase.to !== from;
			return {
				exerciseName: exercise.name,
				phase: phase.label,
				remaining: Math.ceil(phase.duration * (1 - local)),
				progress: moving ? from + (phase.to - from) * ease(local) : phase.to,
				cycle: Math.floor(elapsed / total) + 1,
			};
		}
		cursor += phase.duration;
		from = phase.to;
	}

	return { exerciseName: exercise.name, phase: "Breathe", remaining: 0, progress: 0, cycle: 1 };
}

function renderWidget(config: Config, style: Exclude<StyleId, "random">, startedAt: number): string[] {
	const state = breathState(config, startedAt);
	const now = Date.now() / 1000;
	const label = color(`${state.phase} ${state.remaining}s · ${state.exerciseName}`, [210, 190, 255]);
	return [`${renderBar(style, state.progress, now, "left")} ${label} ${renderBar(style, state.progress, now, "right")}`];
}

function renderBar(style: Exclude<StyleId, "random">, progress: number, now: number, direction: "left" | "right"): string {
	const fill = clamp(Math.round(progress * BAR_WIDTH), 1, BAR_WIDTH);
	return Array.from({ length: BAR_WIDTH }, (_, index) => {
		const outwardIndex = direction === "right" ? index : BAR_WIDTH - 1 - index;
		const active = direction === "right" ? index < fill : index >= BAR_WIDTH - fill;
		const wave = (Math.sin(outwardIndex / 4 - now * 2.5) + 1) / 2;
		const rgb = active ? barColor(style, outwardIndex, now, progress) : [70, 75, 95];
		const char = active ? barChar(style, outwardIndex, now, progress, wave) : "░";
		return active ? color(char, rgb) : `${DIM}${color(char, rgb)}${RESET}`;
	}).join("");
}

function barColor(style: Exclude<StyleId, "random">, index: number, now: number, progress: number): number[] {
	const phase = index / BAR_WIDTH - now * 0.12 + progress * 0.2;
	if (style === "pulse") return [130 + Math.round(90 * Math.sin(phase * 6)), 190, 255];
	if (style === "ripples") return index % 6 < 3 ? [115, 220, 255] : [210, 170, 255];
	if (style === "dots") return index % 7 === Math.round(now * 8) % 7 ? [255, 210, 235] : [150, 205, 255];
	if (style === "wave") return [120, 210 + Math.round(35 * Math.sin(phase * 8)), 255];
	return [130 + Math.round(80 * Math.sin(phase * 5)), 185 + Math.round(45 * Math.sin(phase * 7)), 235 + Math.round(20 * Math.cos(phase * 4))];
}

function barChar(style: Exclude<StyleId, "random">, index: number, now: number, progress: number, wave: number): string {
	if (style === "pulse") return ["░", "▒", "▓", "█"][clamp(Math.round(progress * 3), 0, 3)]!;
	if (style === "ripples") return index % 8 === Math.round(now * 10) % 8 ? "◌" : "━";
	if (style === "dots") return index % 5 === Math.round(now * 12) % 5 ? "✦" : "•";
	if (style === "wave") return "▁▂▃▄▅▆▇█"[clamp(Math.round(wave * 7), 0, 7)]!;
	return ["░", "▒", "▓", "█", "▓", "▒"][clamp(Math.round((Math.sin(index / 5 - now * 2) + 1) * 2.5), 0, 5)]!;
}

function describe(config: Config): string {
	return `mindful ${config.enabled ? "on" : "off"} · ${config.exercise} · ${config.style} · ${config.delaySeconds}s · ${config.placement}`;
}

function setWidget(ctx: ExtensionContext, config: Config, lines: string[]): void {
	if (config.placement === "below") {
		ctx.ui.setWidget(WIDGET_ID, lines, { placement: "belowEditor" });
		return;
	}
	ctx.ui.setWidget(WIDGET_ID, lines);
}

export default function (pi: ExtensionAPI) {
	const childSession = process.env.PI_ORCHESTRATED_CHILD === "1";

	let config = DEFAULT_CONFIG;
	let timer: ReturnType<typeof setInterval> | undefined;
	let delayTimer: ReturnType<typeof setTimeout> | undefined;
	let startedAt = 0;
	let style: Exclude<StyleId, "random"> = "aurora";

	const stop = (ctx?: ExtensionContext) => {
		if (childSession) return;
		if (delayTimer) clearTimeout(delayTimer);
		if (timer) clearInterval(timer);
		delayTimer = undefined;
		timer = undefined;
		ctx?.ui.setWidget(WIDGET_ID, undefined);
	};

	pi.on("agent_start", async (_event, ctx) => {
		if (childSession) return;
		config = await loadConfig();
		stop(ctx);
		if (!config.enabled) return;
		style = config.style === "random" ? STYLE_IDS[Math.floor(Math.random() * STYLE_IDS.length)]! : config.style;
		delayTimer = setTimeout(() => {
			startedAt = Date.now();
			setWidget(ctx, config, renderWidget(config, style, startedAt));
			timer = setInterval(() => {
				setWidget(ctx, config, renderWidget(config, style, startedAt));
			}, TICK_MS);
		}, config.delaySeconds * 1000);
	});

	pi.on("agent_end", async (_event, ctx) => stop(ctx));
	pi.on("session_shutdown", async (_event, ctx) => stop(ctx));

	pi.registerCommand("mindful", {
		description: "Configure mindful breathing: status, on/off, exercise, style, delay, placement.",
		handler: async (args, ctx) => {
			if (childSession) {
				ctx.ui.notify("Mindful is disabled in orchestrated child sessions.", "info");
				return;
			}
			config = await loadConfig();
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const fail = (message: string) => ctx.ui.notify(message, "error");
			const save = async () => {
				await saveConfig(config);
				ctx.ui.notify(describe(config), "info");
			};

			if (parts[0] === "on") {
				config.enabled = true;
				await save();
				return;
			}
			if (parts[0] === "off") {
				config.enabled = false;
				stop(ctx);
				await save();
				return;
			}
			if (parts[0] === "status") {
				ctx.ui.notify(describe(config), "info");
				return;
			}
			if (parts[0] === "exercise") {
				if (!parts[1] || !Object.hasOwn(EXERCISES, parts[1])) return fail("Usage: /mindful exercise coherent|sigh|box|478");
				config.exercise = parts[1] as ExerciseId;
				await save();
				return;
			}
			if (parts[0] === "style") {
				if (!parts[1] || !([...STYLE_IDS, "random"] as string[]).includes(parts[1])) return fail("Usage: /mindful style aurora|pulse|ripples|dots|wave|random");
				config.style = parts[1] as StyleId;
				await save();
				return;
			}
			if (parts[0] === "delay") {
				const next = Number(parts[1]);
				if (!Number.isFinite(next)) return fail("Usage: /mindful delay <seconds>");
				config.delaySeconds = clamp(next, 0, 120);
				await save();
				return;
			}
			if (parts[0] === "placement") {
				if (parts[1] !== "above" && parts[1] !== "below") return fail("Usage: /mindful placement above|below");
				config.placement = parts[1];
				await save();
				return;
			}
			if (parts.length > 0) return fail("Usage: /mindful [status|on|off|exercise|style|delay|placement]");

			ctx.ui.notify(describe(config), "info");
			if (!ctx.hasUI) return;
			const choice = await ctx.ui.select("Mindful", ["toggle", "exercise", "style", "delay", "placement", "status"]);
			if (choice === "toggle") config.enabled = !config.enabled;
			if (choice === "exercise") {
				const selected = await ctx.ui.select("Exercise", Object.keys(EXERCISES));
				if (selected && Object.hasOwn(EXERCISES, selected)) config.exercise = selected as ExerciseId;
			}
			if (choice === "style") {
				const selected = await ctx.ui.select("Style", [...STYLE_IDS, "random"]);
				if (selected && ([...STYLE_IDS, "random"] as string[]).includes(selected)) config.style = selected as StyleId;
			}
			if (choice === "delay") {
				const selected = await ctx.ui.input("Delay seconds", String(config.delaySeconds));
				if (selected !== undefined && Number.isFinite(Number(selected))) config.delaySeconds = clamp(Number(selected), 0, 120);
			}
			if (choice === "placement") {
				const selected = await ctx.ui.select("Placement", ["above", "below"]);
				if (selected === "above" || selected === "below") config.placement = selected;
			}
			if (!choice || choice === "status") return;
			if (!config.enabled) stop(ctx);
			await save();
		},
	});
}
