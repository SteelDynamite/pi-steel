import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __test__ } from "../src/index.ts";
import { CustomEditor } from "../src/pi-local.ts";

const tui: any = { requestRender() {}, terminal: { rows: 30, columns: 80 } };
const theme: any = { borderColor: (text: string) => text, selectList: {} };
const ctx: any = { hasUI: true, mode: "tui", cwd: "/nonexistent", ui: { setWidget() {} } };

test("paste, Unicode, control edits and navigation invalidate suggestions before clearing and Enter", (t) => {
 const home = mkdtempSync(join(tmpdir(), "suggestion-editor-"));
 const old = process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR = home;
 ctx.cwd = home;
 t.after(() => {
  if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
  rmSync(home, { recursive: true, force: true });
 });
 for (const data of ["\x1b[200~hello\x1b[201~", "😀", "\x15", "\x1b[97u", "\x1b[D"]) {
  const editor = new __test__.SuggestionEditor(tui, theme, { matches: () => false });
  __test__.showSuggestion("run the tests", ctx);
  editor.handleInput(data);
  editor.setText("");
  editor.handleInput("\r");
  assert.equal(editor.getText(), "");
 }
 mkdirSync(join(home, ".pi"));
 for (const display of ["ghost", "belowEditor"]) {
  writeFileSync(join(home, ".pi", "prompt-suggestions.json"), JSON.stringify({ display, acceptTab: true }));
  for (const key of ["\x1b[C", "\t", "\r"]) {
   const editor = new __test__.SuggestionEditor(tui, theme, { matches: () => false });
   let submitted: string | undefined;
   editor.onSubmit = (text) => { submitted = text; };
   __test__.showSuggestion("run the tests", ctx);
   editor.handleInput(key);
   assert.equal(submitted ?? editor.getText(), "run the tests");
   __test__.showSuggestion("run \x1b]52;c;bad\x07tests", ctx);
   editor.setText("");
   editor.handleInput(key);
   assert.equal(editor.getText(), "");
  }
 }
});

test("explicit history binding precedes conflicting application action", () => {
 const editor = new CustomEditor(tui, theme, { matches: (_data, action) => action === "tui.editor.historyPrevious" || action === "app.model.cycleForward" });
 let calls = 0;
 editor.onAction("app.model.cycleForward", () => { calls++; });
 editor.handleInput("\x10");
 assert.equal(calls, 0);
});
