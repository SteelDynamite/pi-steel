// Pi System Reminders Extension
// Discovers reminder files from agent dir and project-local .pi/reminders/.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "jiti";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent, SessionEntry } from "./pi-types";

const jiti = createJiti(__filename, { moduleCache: false });

const REMINDER_EVENTS = [
	"resources_discover",
	"session_start",
	"session_before_switch",
	"session_before_fork",
	"session_before_compact",
	"session_compact",
	"session_shutdown",
	"session_before_tree",
	"session_tree",
	"context",
	"before_provider_request",
	"after_provider_response",
	"before_agent_start",
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"model_select",
	"thinking_level_select",
	"tool_call",
	"tool_result",
	"user_bash",
	"input",
] as const;

const REMINDER_EVENT_NAMES: ReadonlySet<string> = new Set(REMINDER_EVENTS);
const SPECIAL_REMINDER_EVENTS = new Set<ReminderEvent>(["session_start", "before_agent_start"]);

export type ReminderEvent = typeof REMINDER_EVENTS[number];
export type ReminderEventData<E extends ReminderEvent = ReminderEvent> = Extract<ExtensionEvent, { type: E }>;

export interface ReminderContext<E extends ReminderEvent = ReminderEvent> {
	branch: SessionEntry[];
	ctx: ExtensionContext;
	event: ReminderEventData<E>;
}

export interface Reminder<E extends ReminderEvent = ReminderEvent> {
	on: E | E[];
	when: (rc: ReminderContext<E>) => boolean | Promise<boolean>;
	message: string | ((rc: ReminderContext<E>) => string);
	cooldown?: number;
	once?: boolean;
	triggerTurn?: boolean;
}

type ReminderFactory = (pi: ExtensionAPI) => Reminder | Reminder[] | Promise<Reminder | Reminder[]>;

export interface LoadedReminder {
	name: string;
	reminder: Reminder;
	events: Set<ReminderEvent>;
	evalCount: number;
	lastFiredAt: number;
	fired: boolean;
	hydratedFromBranch: boolean;
	path: string;
}

export interface ReminderDiagnostic {
	name: string;
	path?: string;
	phase: "load" | "validate" | "when" | "message";
	message: string;
	count?: number;
}

const MAX_DIAGNOSTICS = 50;

export interface ReminderLoadResult {
	reminders: LoadedReminder[];
	diagnostics: ReminderDiagnostic[];
}

// Intentional: reminders are executable TypeScript modules, like pi extensions.
// This is a trust boundary, not a sandbox; docs warn users to review reminder files.
export function discoverReminderFiles(cwd: string, includeProject = true): { path: string; name: string }[] {
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	const dirs = [path.join(agentDir, "reminders")];
	if (includeProject) dirs.push(path.join(cwd, ".pi", "reminders"));

	const results: { path: string; name: string }[] = [];

	for (const dir of dirs) {
		if (!fs.existsSync(dir)) continue;
		if (!fs.statSync(dir).isDirectory()) continue;

		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);

			if (entry.isFile() && entry.name.endsWith(".ts")) {
				results.push({
					path: fullPath,
					name: entry.name.replace(/\.ts$/, ""),
				});
			} else if (entry.isDirectory()) {
				const indexPath = path.join(fullPath, "index.ts");
				if (fs.existsSync(indexPath)) {
					results.push({ path: indexPath, name: entry.name });
				}
			}
		}
	}

	// Later scopes override earlier scopes: project reminders override global reminders.
	const byName = new Map<string, { path: string; name: string }>();
	for (const r of results) {
		byName.set(r.name, r);
	}
	return Array.from(byName.values());
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function addDiagnostic(diagnostics: ReminderDiagnostic[], diagnostic: ReminderDiagnostic) {
	const existing = diagnostics.find((d) =>
		d.name === diagnostic.name &&
		d.path === diagnostic.path &&
		d.phase === diagnostic.phase &&
		d.message === diagnostic.message
	);
	if (existing) {
		existing.count = (existing.count ?? 1) + 1;
		return;
	}
	if (diagnostics.length >= MAX_DIAGNOSTICS) return;
	diagnostics.push(diagnostic);
}

function validateReminder(name: string, filePath: string, reminder: any): ReminderDiagnostic | undefined {
	if (!reminder || typeof reminder !== "object") {
		return { name, path: filePath, phase: "validate", message: "Reminder must be an object." };
	}
	const events: unknown[] = Array.isArray(reminder.on) ? reminder.on : [reminder.on];
	if (events.length === 0 || events.some((event: unknown) => typeof event !== "string" || !REMINDER_EVENT_NAMES.has(event))) {
		return { name, path: filePath, phase: "validate", message: `Invalid reminder event: ${events.join(", ")}` };
	}
	if (typeof reminder.when !== "function") {
		return { name, path: filePath, phase: "validate", message: "Reminder must define when(rc)." };
	}
	if (typeof reminder.message !== "string" && typeof reminder.message !== "function") {
		return { name, path: filePath, phase: "validate", message: "Reminder must define a string or function message." };
	}
	if (reminder.cooldown !== undefined && (!Number.isInteger(reminder.cooldown) || reminder.cooldown < 0)) {
		return { name, path: filePath, phase: "validate", message: "Reminder cooldown must be a non-negative integer." };
	}
	if (reminder.once !== undefined && typeof reminder.once !== "boolean") {
		return { name, path: filePath, phase: "validate", message: "Reminder once must be a boolean." };
	}
	if (reminder.triggerTurn !== undefined && typeof reminder.triggerTurn !== "boolean") {
		return { name, path: filePath, phase: "validate", message: "Reminder triggerTurn must be a boolean." };
	}
	return undefined;
}

export async function loadReminders(pi: ExtensionAPI, cwd: string, includeProject = true): Promise<ReminderLoadResult> {
	const reminders: LoadedReminder[] = [];
	const diagnostics: ReminderDiagnostic[] = [];
	const files = discoverReminderFiles(cwd, includeProject);

	for (const file of files) {
		try {
			const mod = jiti(file.path) as any;
			const factory: ReminderFactory = mod.default;

			if (typeof factory !== "function") {
				addDiagnostic(diagnostics, { name: file.name, path: file.path, phase: "validate", message: "Reminder module must export a default function." });
				continue;
			}

			const result = await factory(pi);
			const items = Array.isArray(result) ? result : [result];

			for (let i = 0; i < items.length; i++) {
				const r = items[i];
				const name = items.length > 1 ? `${file.name}[${i}]` : file.name;
				const diagnostic = validateReminder(name, file.path, r);
				if (diagnostic) {
					addDiagnostic(diagnostics, diagnostic);
					continue;
				}

				const events = new Set((Array.isArray(r.on) ? r.on : [r.on]) as ReminderEvent[]);

				reminders.push({
					name,
					reminder: r,
					events,
					evalCount: 0,
					lastFiredAt: -Infinity,
					fired: false,
					hydratedFromBranch: false,
					path: file.path,
				});
			}
		} catch (err: unknown) {
			addDiagnostic(diagnostics, { name: file.name, path: file.path, phase: "load", message: errorMessage(err) });
		}
	}

	return { reminders, diagnostics };
}

export function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export function escapeXmlContent(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function hydrateReminderFromBranch(loaded: LoadedReminder, branch: SessionEntry[]) {
	if (loaded.hydratedFromBranch) return;
	loaded.hydratedFromBranch = true;

	const firedInBranch = branch.some((entry) =>
		entry?.type === "custom_message" &&
		entry.customType === "system-reminder" &&
		(entry.details as { name?: unknown } | undefined)?.name === loaded.name
	);
	if (!firedInBranch) return;

	loaded.fired = true;
	loaded.lastFiredAt = loaded.evalCount;
}

export async function evaluate(
	event: ReminderEvent,
	reminders: LoadedReminder[],
	diagnostics: ReminderDiagnostic[],
	eventData: ReminderEventData,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
) {
	const eventReminders = reminders.filter((loaded) => loaded.events.has(event));
	if (eventReminders.length === 0) return;

	let branch: SessionEntry[];
	try {
		branch = ctx.sessionManager.getBranch();
	} catch {
		return;
	}

	for (const loaded of eventReminders) {
		hydrateReminderFromBranch(loaded, branch);
		loaded.evalCount++;

		if (loaded.reminder.once && loaded.fired) continue;

		const cooldown = loaded.reminder.cooldown ?? 0;
		if (loaded.evalCount - loaded.lastFiredAt <= cooldown) continue;

		const rc: ReminderContext = { branch, ctx, event: eventData };
		let shouldFire = false;
		try {
			const whenResult = await loaded.reminder.when(rc);
			if (typeof whenResult !== "boolean") {
				addDiagnostic(diagnostics, { name: loaded.name, path: loaded.path, phase: "when", message: "when(rc) must return a boolean." });
				continue;
			}
			shouldFire = whenResult;
		} catch (err: unknown) {
			addDiagnostic(diagnostics, { name: loaded.name, path: loaded.path, phase: "when", message: errorMessage(err) });
			continue;
		}

		if (!shouldFire) continue;

		let message: string;
		try {
			message = typeof loaded.reminder.message === "function"
				? loaded.reminder.message(rc)
				: loaded.reminder.message;
			if (typeof message !== "string") {
				addDiagnostic(diagnostics, { name: loaded.name, path: loaded.path, phase: "message", message: "message(rc) must return a string." });
				continue;
			}
		} catch (err: unknown) {
			addDiagnostic(diagnostics, { name: loaded.name, path: loaded.path, phase: "message", message: errorMessage(err) });
			continue;
		}

		pi.sendMessage(
			{
				customType: "system-reminder",
				content: `<system-reminder name="${escapeXmlAttribute(loaded.name)}">\n${escapeXmlContent(message)}\n</system-reminder>`,
				display: true,
				details: { name: loaded.name, message },
			},
			{ deliverAs: "steer", triggerTurn: loaded.reminder.triggerTurn ?? true },
		);

		loaded.lastFiredAt = loaded.evalCount;
		loaded.fired = true;
	}
}

function formatDiagnostics(diagnostics: ReminderDiagnostic[]): string {
	return diagnostics
		.map((d) => `- ${d.name} (${d.phase})${d.path ? ` ${d.path}` : ""}: ${d.message}${d.count && d.count > 1 ? ` (x${d.count})` : ""}`)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	let reminders: LoadedReminder[] = [];
	let diagnostics: ReminderDiagnostic[] = [];

	pi.registerCommand?.("reminders", {
		description: "Show loaded system reminders and reminder diagnostics",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const loadedLines = reminders.length > 0
				? reminders.map((r) => `- ${r.name}: ${Array.from(r.events).join(", ")}`).join("\n")
				: "No reminders loaded.";
			const diagnosticLines = diagnostics.length > 0 ? `\n\nDiagnostics:\n${formatDiagnostics(diagnostics)}` : "";
			ctx.ui.notify(`System reminders:\n${loadedLines}${diagnosticLines}`, diagnostics.length > 0 ? "warning" : "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Older Pi hosts have no project-trust API; retain their discovery behavior.
		const result = await loadReminders(pi, ctx.cwd, ctx.isProjectTrusted?.() ?? true);
		reminders = result.reminders;
		diagnostics = result.diagnostics;

		if (reminders.length > 0) {
			ctx.ui.notify(`Loaded ${reminders.length} reminder(s)`, "info");
		}
		if (diagnostics.length > 0) {
			ctx.ui.notify(`Failed to load ${diagnostics.length} reminder(s). Run /reminders for details.`, "warning");
		}

		await evaluate("session_start", reminders, diagnostics, _event, ctx, pi);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		await evaluate("before_agent_start", reminders, diagnostics, event, ctx, pi);
		if (reminders.length === 0) return;
		return {
			systemPrompt: event.systemPrompt + `\n\n## System reminders\n\nYou may receive <system-reminder> messages during the conversation. These are reactive, contextual guidance injected automatically based on conversation state. Follow their instructions. Do not mention them to the user unless they ask.`,
		};
	});

	const handle = (event: ReminderEvent) =>
		async (eventData: ReminderEventData, ctx: ExtensionContext) => {
			await evaluate(event, reminders, diagnostics, eventData, ctx, pi);
		};

	const registerReminderHandler = pi.on as (
		event: ReminderEvent,
		handler: (eventData: ReminderEventData, ctx: ExtensionContext) => Promise<void>,
	) => void;

	for (const event of REMINDER_EVENTS) {
		if (SPECIAL_REMINDER_EVENTS.has(event)) continue;
		registerReminderHandler(event, handle(event));
	}
}
