import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSettings } from "../index.js";

test("missing config is off; malformed config never silently enables tools", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-paseo-settings-"));
  const path = join(dir, "paseo.json");
  try {
    assert.deepEqual(readSettings(path), {});
    for (const raw of ["null", "[]", "true", "{broken", '{"tools":"true"}', '{"tools":1}']) {
      writeFileSync(path, raw);
      assert.throws(() => readSettings(path), /Invalid pi-paseo settings/);
    }
    writeFileSync(path, JSON.stringify({ tools: true, unrelated: "preserved" }));
    assert.deepEqual(readSettings(path), { tools: true, unrelated: "preserved" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
