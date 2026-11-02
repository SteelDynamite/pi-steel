import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hostEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
const { discoverAndLoadExtensions, ExtensionRunner, SessionManager } = await import('@earendil-works/pi-coding-agent');
const cwd = path.join(process.env.HOME, 'project');
const reminders = path.join(cwd, '.pi', 'reminders');
fs.mkdirSync(reminders, { recursive: true });
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
fs.writeFileSync(path.join(reminders, 'fixture.ts'), `
  import { basename } from 'node:path';
  export default (pi) => {
    pi.on('tool_result', () => {});
    return { on: 'turn_end', once: true, when: async () => true, message: basename('/host/works'), triggerTurn: false };
  };
`);
fs.writeFileSync(path.join(reminders, 'unsupported.ts'), `export default () => ({ on: 'agent_before_settle', when: () => true, message: 'unsupported' });`);
fs.writeFileSync(path.join(reminders, 'host-import.ts'), `import { getAgentDir } from '@earendil-works/pi-coding-agent'; export default () => ({ on: 'turn_end', when: () => false, message: getAgentDir() });`);
const extensionPath = path.resolve(import.meta.dirname, '../index.ts');
for (const child of [false, true]) {
  if (child) process.env.PI_ORCHESTRATED_CHILD = '1';
  const loaded = await discoverAndLoadExtensions([extensionPath], cwd, process.env.PI_CODING_AGENT_DIR);
  assert.deepEqual(loaded.errors, []);
  const messages = [];
  loaded.runtime.sendMessage = (message, options) => messages.push({ message, options });
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, SessionManager.inMemory(cwd), {});
  const errors = [];
  runner.onError(error => errors.push(error));
  await runner.emit({ type: 'session_start', reason: 'startup' });
  await Promise.all([runner.emit({ type: 'turn_end', turnIndex: 0 }), runner.emit({ type: 'turn_end', turnIndex: 1 })]);
  assert.deepEqual(errors, []);
  assert.equal(messages.length, child ? 0 : 1);
  assert.equal(loaded.extensions[0].handlers.get('tool_result')?.length ?? 0, child ? 0 : 2);
  if (!child) {
    assert.equal(messages[0].options.triggerTurn, false);
    assert.match(messages[0].message.content, /works/);
    const diagnostics = [];
    const ctx = runner.createContext();
    Object.defineProperty(ctx, 'ui', { value: { notify: text => diagnostics.push(text) } });
    await loaded.extensions[0].commands.get('reminders').handler('', ctx);
    assert.match(diagnostics.join('\n'), /Invalid reminder event: agent_before_settle/);
    assert.match(diagnostics.join('\n'), /host-import \(load\)/);
    // Validate every declared event against the actual installed host declarations.
    const types = fs.readFileSync(path.join(path.dirname(hostEntry), 'core/extensions/types.d.ts'), 'utf8');
    for (const name of loaded.extensions[0].handlers.keys()) assert.ok(types.includes(`"${name}"`), name);
  }
}
