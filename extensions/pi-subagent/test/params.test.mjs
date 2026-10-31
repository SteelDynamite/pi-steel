import assert from "node:assert/strict";
import { test } from "node:test";
import { addContextDocsToTask, getMissingSessionError } from "../params.ts";

test("getMissingSessionError requires explicit session intent", () => {
	assert.match(getMissingSessionError({ id: "a", task: "do" }), /Missing required session intent/);
	assert.equal(getMissingSessionError({ id: "a", session: "new", task: "do" }), undefined);
});

test("context docs are deduplicated and prefixed to child tasks", () => {
	assert.equal(
		addContextDocsToTask("Do work", [" /a.md ", "/b.md", "/a.md", ""]),
		"Before starting, read these handoff/context docs and follow any relevant product guidance:\n- /a.md\n- /b.md\n\nTask:\nDo work",
	);
	assert.equal(addContextDocsToTask("Do work"), "Do work");
});
