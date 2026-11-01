import { appendFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

// Inherited by both real CLI processes, before host initialization. Offline mode
// prevents automatic traffic; this guard fails any accidental transport attempt.
function deny() {
  appendFileSync(process.env.STEEL_NETWORK_ATTEMPTS, `Network attempted\n${new Error().stack}\n`);
  throw new Error("Network is forbidden in the child integration test");
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // tsx communicates with its parent over a local Unix socket, not a network endpoint.
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if ((typeof options === "string" && options.startsWith("/")) || options?.path) return connect.apply(this, args);
  return deny();
};
tls.connect = deny;
globalThis.fetch = deny;
syncBuiltinESMExports();
