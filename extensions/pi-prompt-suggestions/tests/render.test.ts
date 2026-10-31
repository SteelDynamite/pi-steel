import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { __test__ } from "../src/index.ts";

const { renderGhostSuggestionLines } = __test__;
const cursor = "\x1b[7m \x1b[0m";

describe("ghost suggestion rendering", () => {
	it("renders dim ghost text on the editor content line", () => {
		const lines = ["─".repeat(20), `${cursor}${" ".repeat(19)}`, "─".repeat(20)];
		const rendered = renderGhostSuggestionLines(lines, 20, "run the tests");

		assert.notEqual(rendered, lines);
		assert.equal(rendered[0], lines[0]);
		assert.equal(rendered[2], lines[2]);
		assert.match(rendered[1], /^\x1b\[7m \x1b\[0m\x1b\[2;90mrun the tests\x1b\[0m/);
		assert.equal(visibleWidth(rendered[1]), 20);
	});

	it("falls back to cursor search for short render output", () => {
		const rendered = renderGhostSuggestionLines([`${cursor}    `], 20, "commit this");

		assert.match(rendered[0], /commit this/);
		assert.equal(visibleWidth(rendered[0]), 20);
	});

	it("leaves output unchanged when no content line is found", () => {
		const lines = ["plain"];
		assert.equal(renderGhostSuggestionLines(lines, 20, "run the tests"), lines);
	});
});
