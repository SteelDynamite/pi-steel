import { appendFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

function deny() {
  appendFileSync(process.env.STEEL_NETWORK_ATTEMPTS, `${new Error("Unexpected network access").stack}\n`);
  throw new Error("Only the Paseo loopback fixture is allowed");
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  // tsx uses a local Unix socket; only the fixture may use TCP.
  if ((typeof options === "string" && options.startsWith("/")) || options?.path
    || (options?.host === "127.0.0.1" && String(options.port) === process.env.STEEL_PASEO_PORT)) {
    return connect.apply(this, args);
  }
  return deny();
};
tls.connect = deny;
globalThis.fetch = deny;
syncBuiltinESMExports();
