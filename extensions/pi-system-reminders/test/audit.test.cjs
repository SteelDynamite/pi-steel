const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const jiti = require('jiti').createJiti(__filename);
const mod = jiti('../index.ts');
// Unit tests exercise parent behavior even when launched by an orchestrated worker.
delete process.env.PI_ORCHESTRATED_CHILD;

function pi() {
  const handlers = new Map();
  const messages = [];
  return { handlers, messages, on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    registerCommand() {}, sendMessage(message, options) { messages.push({ message, options }); } };
}
function context(cwd) { return { cwd, sessionManager: { getBranch: () => [] }, ui: { notify() {} } }; }
function loaded(reminder) {
  return { name: 'test', path: '/test.ts', reminder, events: new Set([reminder.on]), evalCount: 0, lastFiredAt: -Infinity, fired: false };
}
async function emit(api, name, event, ctx) {
  for (const fn of api.handlers.get(name) ?? []) await fn(event, ctx);
}

for (const options of [{ once: true }, { cooldown: 2 }]) {
  test(`concurrent predicates recheck eligibility ${JSON.stringify(options)}`, async () => {
    const api = pi();
    const releases = [];
    const reminder = loaded({ on: 'turn_end', when: () => new Promise(resolve => releases.push(resolve)), message: 'x', ...options });
    const run = () => mod.evaluate('turn_end', [reminder], [], {}, context('/tmp'), api);
    const first = run(), second = run();
    releases[1](true);
    await second;
    releases[0](true);
    await first;
    assert.equal(api.messages.length, 1);
  });
}

test('cooldown alone fires at evaluations 1, 4, 7; hydrated once stays quiet', async () => {
  const api = pi();
  const r = loaded({ on: 'turn_end', when: () => true, message: 'x', cooldown: 2 });
  const fired = [];
  for (let i = 1; i <= 7; i++) {
    const before = api.messages.length;
    await mod.evaluate('turn_end', [r], [], {}, context('/tmp'), api);
    if (api.messages.length !== before) fired.push(i);
  }
  assert.deepEqual(fired, [1, 4, 7]);
  const once = loaded({ on: 'turn_end', when: () => true, message: 'x', once: true });
  const ctx = context('/tmp');
  ctx.sessionManager.getBranch = () => [{ type: 'custom_message', customType: 'system-reminder', details: { name: 'test' } }];
  await mod.evaluate('turn_end', [once], [], {}, ctx, api);
  assert.equal(api.messages.length, 3);
});

test('false and rejected predicates do not consume once', async () => {
  const api = pi();
  let count = 0;
  const diagnostics = [];
  const r = loaded({ on: 'turn_end', when: () => { if (++count === 1) return false; if (count === 2) throw Error('predicate'); return true; }, message: 'x', once: true });
  for (let i = 0; i < 4; i++) await mod.evaluate('turn_end', [r], diagnostics, {}, context('/tmp'), api);
  assert.equal(api.messages.length, 1);
  assert.equal(diagnostics.length, 1);
});

test('discovery isolates unreadable scopes and disappearing directories', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-discovery-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
  try {
    for (const directory of [path.join(root, 'agent', 'reminders'), path.join(root, '.pi', 'reminders')]) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'ok.ts'), 'export default () => ({ on: "turn_end", when: () => false, message: "ok" })');
    }
    const original = fs.readdirSync;
    let failingScope, failureCode;
    t.mock.method(fs, 'readdirSync', function (directory, ...args) {
      if (directory === failingScope) throw Object.assign(Error(failureCode), { code: failureCode });
      return original.call(this, directory, ...args);
    });
    try {
      for (const scope of [path.join(root, 'agent', 'reminders'), path.join(root, '.pi', 'reminders')]) {
        failingScope = scope;
        for (const code of ['EACCES', 'ENOENT']) {
          failureCode = code;
          const result = await mod.loadReminders(pi(), root);
          assert.equal(result.reminders.length, 1);
          assert.equal(result.diagnostics.length, 1, JSON.stringify(result.diagnostics));
          assert.equal(result.diagnostics[0].path, scope);
        }
      }
    } finally { failingScope = undefined; }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('blank range example never labels a whole file empty or images blank', async () => {
  for (const [content, expected] of [[[{ type: 'text', text: '' }], true], [[{ type: 'text', text: '  ' }], true], [[{ type: 'image', data: 'x' }], false], [[], false]]) {
    const api = pi();
    const r = loaded(jiti('../examples/file-empty.ts').default(api));
    const ctx = context('/tmp');
    await emit(api, 'tool_result', { toolName: 'read', input: { path: 'file', offset: 2, limit: 1 }, content }, ctx);
    await mod.evaluate(r.reminder.on, [r], [], {}, ctx, api);
    assert.equal(api.messages.length, Number(expected));
    if (expected) assert.match(api.messages[0].message.content, /does not establish that the whole file is empty/);
  }
});

test('file-state examples unify relative, absolute and tilde paths', async () => {
  const ctx = context(os.homedir());
  const target = path.join(ctx.cwd, 'reminder-fixture');
  const aliases = ['reminder-fixture', target, '~/reminder-fixture'];
  const api = pi();
  const r = loaded(jiti('../examples/read-before-edit.ts').default(api));
  await emit(api, 'tool_result', { toolName: 'read', input: { path: aliases[0] } }, ctx);
  for (const alias of aliases) await emit(api, 'tool_result', { toolName: 'edit', input: { path: alias } }, ctx);
  await mod.evaluate(r.reminder.on, [r], [], {}, ctx, api);
  assert.equal(api.messages.length, 0);
  const churnApi = pi();
  const churn = loaded(jiti('../examples/file-churn.ts').default(churnApi));
  for (let i = 0; i < 5; i++) await emit(churnApi, 'tool_result', { toolName: 'edit', input: { path: aliases[i % 3] } }, ctx);
  await mod.evaluate(churn.reminder.on, [churn], [], {}, ctx, churnApi);
  assert.equal(churnApi.messages.length, 1);
});

test('external-change example checks before mutations, not after its own writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-file-'));
  try {
    const target = path.join(root, 'file');
    fs.writeFileSync(target, 'read');
    const api = pi(), ctx = context(root);
    const r = loaded(jiti('../examples/external-file-modified.ts').default(api));
    await emit(api, 'tool_result', { toolName: 'read', input: { path: 'file' } }, ctx);
    for (const toolName of ['edit', 'write']) {
      await emit(api, 'tool_call', { toolName, input: { path: target } }, ctx);
      fs.writeFileSync(target, toolName);
      fs.utimesSync(target, 100, 100);
      await emit(api, 'tool_result', { toolName, input: { path: target } }, ctx);
      await mod.evaluate(r.reminder.on, [r], [], {}, ctx, api);
    }
    assert.equal(api.messages.length, 0);
    fs.utimesSync(target, 200, 200);
    await emit(api, 'tool_call', { toolName: 'edit', input: { path: 'file' } }, ctx);
    await mod.evaluate(r.reminder.on, [r], [], {}, ctx, api);
    assert.equal(api.messages.length, 1);
    assert.match(api.messages[0].message.content, /cannot identify who changed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verification example documents a heuristic, including incidental command matches', async () => {
  for (const command of ['echo test', 'git diff -- test/file.ts', 'npm test']) {
    const api = pi();
    const reminder = jiti('../examples/verify-plan.ts').default(api);
    const ctx = context('/tmp');
    await emit(api, 'tool_result', { toolName: 'TaskUpdate', input: { status: 'completed' } }, ctx);
    assert.equal(reminder.when({ ctx }), true);
    await emit(api, 'tool_result', { toolName: 'bash', input: { command } }, ctx);
    assert.equal(reminder.when({ ctx }), false, command);
  }
});

test('real installed host loads, dispatches, diagnoses unsupported imports, and suppresses children', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-host-'));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'host-fixture.mjs')], {
      env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent') },
      encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
