// Herdr supplies role instructions and the task through the terminal, not argv.
// Start the parent Pi installation directly; do not evaluate the command in a
// second shell or use a .cmd shim. Both processes share the interactive console.
import { spawnSync } from 'node:child_process';
import { isAbsolute, normalize } from 'node:path';

const [agentDir, cli, ...args] = process.argv.slice(2);
if (!agentDir || !cli || !isAbsolute(agentDir) || !isAbsolute(cli)) throw new Error('Missing absolute Steel child profile or CLI path.');
const child = spawnSync(cli, args, {
  shell: false, stdio: 'inherit',
  env: { ...process.env, PI_ORCHESTRATED_CHILD: '1', PI_CODING_AGENT_DIR: normalize(agentDir) },
});
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
