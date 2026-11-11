#!/usr/bin/env node
// Read a v1 fixed-slot snapshot; never interpret a torn/concurrently replaced slot.
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const bytes = 1024;
const total = bytes * 4096;
let fd;
try {
  fd = openSync(process.argv[2] ?? join(homedir(), ".pi-paseo-diagnostics", "activity.v1.log"), "r");
  const size = fstatSync(fd).size;
  if (size > total) throw new Error();
  const buffer = Buffer.alloc(total);
  const length = readSync(fd, buffer, 0, total, 0);
  const events = [];
  let invalid = 0;
  for (let offset = 0; offset < length; offset += bytes) {
    const slot = buffer.subarray(offset, offset + bytes);
    if (slot.every(byte => byte === 0)) continue;
    try {
      const { sha256, event } = JSON.parse(slot.toString("utf8").trim());
      if (sha256 !== createHash("sha256").update(JSON.stringify(event)).digest("hex")) throw new Error();
      events.push(event);
    } catch { invalid++; }
  }
  events.sort((a, b) => String(a.utc).localeCompare(String(b.utc)) || String(a.runtime).localeCompare(String(b.runtime)) || a.seq - b.seq);
  for (const event of events) console.log(JSON.stringify(event));
  console.error(`${events.length} valid records; ${invalid} torn/invalid slots skipped. Overwrites are not countable.`);
} catch {
  console.error("Cannot read v1 diagnostics (missing, inaccessible, or oversized file).");
  process.exitCode = 1;
} finally {
  if (fd !== undefined) closeSync(fd);
}
