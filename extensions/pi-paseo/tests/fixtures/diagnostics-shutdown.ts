import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { ActivityDiagnostics, DiagnosticStore, diskWriter } from "../../diagnostics.js";

const [path, fifo, mode] = process.argv.slice(2);
const watchdog = setTimeout(() => { throw new Error("writer did not enter blocked syscall"); }, 3000);
const block = process.platform === "win32"
  ? "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"
  : `const fs = require('node:fs'); const fd = fs.openSync(${JSON.stringify(fifo)}, fs.constants.O_RDWR); fs.readSync(fd, Buffer.alloc(1), 0, 1, null)`;
const store = new DiagnosticStore(path, () => {
  const writer = spawn(process.execPath, ["-e", `require('node:fs').writeSync = () => { process.stdout.write('blocked\\n'); ${block}; }; (${diskWriter.toString()})()`], {
    detached: true, windowsHide: true, stdio: ["ignore", "pipe", "ignore", "ipc"], env: {},
  });
  console.log(`writer=${writer.pid}`);
  // Model a kernel write that cannot be canceled. The outer test owns cleanup;
  // the parent must exit without relying on this kill request taking effect.
  if (mode === "shutdown" || mode === "deadline") writer.kill = () => false;
  writer.once("exit", () => {
    if (mode !== "dispose" && mode !== "timeout") return;
    assert.equal(writer.connected, false);
    assert.equal(store.failure, mode === "timeout" ? "write_deadline" : "closed");
    clearTimeout(watchdog);
    console.log("writer exited; IPC disconnected; parent exiting");
  });
  writer.stdout!.once("data", () => {
    console.log("blocked");
    writer.stdout!.destroy();
    if (mode === "dispose") { store.close(); return; }
    if (mode === "timeout") return;
    clearTimeout(watchdog);
    if (mode === "deadline") setTimeout(() => {
      assert.equal(store.failure, "write_deadline");
      assert.equal(store.pending, 0);
      console.log("parent exiting");
    }, 1300);
    else console.log("parent exiting");
  });
  return writer;
});
const diagnostics = new ActivityDiagnostics(store);
diagnostics.emit({ phase: "lifecycle", source: "session_shutdown" });
diagnostics.close();
