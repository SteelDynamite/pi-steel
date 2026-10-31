import { appendFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

// Inherited by both real CLI processes, before host initialization. Offline mode
// prevents automatic traffic; this guard fails any accidental transport attempt.
function deny() {
  appendFileSync(process.env.STEEL_NETWORK_ATTEMPTS, "Network attempted\n");
  throw new Error("Network is forbidden in the child integration test");
}
net.Socket.prototype.connect = deny;
tls.connect = deny;
globalThis.fetch = deny;
syncBuiltinESMExports();
