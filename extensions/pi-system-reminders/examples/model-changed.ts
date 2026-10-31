/**
 * Notify the agent when the model changes mid-session.
 */
type ExtensionAPI = { on(event: string, handler: (event: any, ctx: any) => unknown): void };
type ModelSelectReminderEvent = {
	type: "model_select";
	model: { provider: string; id: string };
	previousModel?: { provider: string; id: string } | null;
};

export default function (_pi: ExtensionAPI) {
	return {
		on: "model_select",
		when: ({ event }: { event: ModelSelectReminderEvent }) => event.previousModel != null,
		triggerTurn: false,
		message: ({ event }: { event: ModelSelectReminderEvent }) => {
			if (!event.previousModel) return "Model changed. Capabilities may differ — adjust your approach if needed.";
			const prev = `${event.previousModel.provider}/${event.previousModel.id}`;
			const next = `${event.model.provider}/${event.model.id}`;
			return `Model changed from ${prev} to ${next}. Capabilities may differ — adjust your approach if needed.`;
		},
	};
}
