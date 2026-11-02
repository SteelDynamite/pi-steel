import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { __test__ } from "../src/index.ts";

const host = new URL("../../../node_modules/@earendil-works/pi-tui/dist/index.js", import.meta.url);
test("real focused Pi editor keeps cursor metadata at its padded column", { skip: !existsSync(host) }, async () => {
 const { Editor, CURSOR_MARKER, visibleWidth } = await import(host.href);
 for (const width of [4, 20, 80]) {
  const editor = new Editor({ requestRender() {}, terminal: { rows: 30, columns: width } }, { borderColor: (text: string) => text, selectList: {} }, { paddingX: 1 });
  editor.focused = true;
  const lines = editor.render(width);
  const rendered = __test__.renderGhostSuggestionLines(lines, width, "运行 测试");
  const original = lines.find((line: string) => line.includes(CURSOR_MARKER));
  const output = rendered.find((line: string) => line.includes(CURSOR_MARKER));
  assert.ok(original);
  assert.ok(output);
  assert.equal(visibleWidth(output.slice(0, output.indexOf(CURSOR_MARKER))), visibleWidth(original.slice(0, original.indexOf(CURSOR_MARKER))));
  assert.ok(rendered.every((line: string) => visibleWidth(line) <= width));
 }
});
