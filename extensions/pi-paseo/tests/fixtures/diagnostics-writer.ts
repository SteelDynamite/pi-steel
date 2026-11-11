import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { mock } from "node:test";
import { ActivityDiagnostics, DiagnosticStore } from "../../diagnostics.js";

// Drive storage wraparound quickly; production admission remains 32/s + 64 burst.
let clock = 0;
mock.method(performance, "now", () => clock += 1000);
const store = new DiagnosticStore(process.argv[2]);
const diagnostics = new ActivityDiagnostics(store, `terminal-${process.argv[3]}`);
for (let batch = 0; batch < 160; batch++) {
  for (let event = 0; event < 64; event++) diagnostics.emit({ phase: "lifecycle", source: "agent_start" });
  for (let wait = 0; wait < 1000 && store.pending; wait++) await delay(1);
  assert.equal(store.pending, 0);
  assert.equal(store.failure, undefined);
}
assert.equal(store.written, 10240);
assert.equal(store.dropped, 0);
console.log("done");
