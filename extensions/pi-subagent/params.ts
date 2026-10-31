import type { SessionIntent } from "./types.ts";

export function addContextDocsToTask(task: string, contextDocs?: string[]): string {
	const docs = Array.from(new Set((contextDocs ?? []).map((doc) => doc.trim()).filter(Boolean)));
	if (docs.length === 0) return task;
	return [
		"Before starting, read these handoff/context docs and follow any relevant product guidance:",
		...docs.map((doc) => `- ${doc}`),
		"",
		"Task:",
		task,
	].join("\n");
}

export function getMissingSessionError(params: { id?: string; session?: SessionIntent; task?: string }): string | undefined {
	if (params.id && params.task && !params.session) return 'Missing required session intent; set session to "new" or "resume".';
	return undefined;
}
