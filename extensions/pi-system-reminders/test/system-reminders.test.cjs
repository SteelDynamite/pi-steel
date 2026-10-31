const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJiti } = require('jiti');

const jiti = createJiti(__filename);
const mod = jiti('../index.ts');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-system-reminders-'));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function withAgentDir(fn) {
  const prev = process.env.PI_CODING_AGENT_DIR;
  const dir = tempDir();
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
}

function fakePi() {
  const handlers = new Map();
  const messages = [];
  const commands = new Map();
  return {
    handlers,
    messages,
    commands,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    sendMessage(message, options) {
      messages.push({ message, options });
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
  };
}

function fakeCtx(cwd, branch = []) {
  const notifications = [];
  return {
    cwd,
    notifications,
    sessionManager: { getBranch: () => branch },
    ui: { notify: (message, level) => notifications.push({ message, level }) },
  };
}

function writeProjectReminder(cwd, source, name = 'example.ts') {
  write(path.join(cwd, '.pi', 'reminders', name), source);
}

function reminderEvents(reminder) {
  return new Set(Array.isArray(reminder.on) ? reminder.on : [reminder.on]);
}

test('discovers global reminders', () => withAgentDir(async (agentDir) => {
  const cwd = tempDir();
  write(path.join(agentDir, 'reminders', 'global.ts'), 'export default () => ({ on: "turn_end", when: () => false, message: "global" });');

  const result = await mod.loadReminders(fakePi(), cwd);

  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(result.reminders.map((r) => r.name), ['global']);
}));

test('discovers project reminders', () => withAgentDir(async () => {
  const cwd = tempDir();
  write(path.join(cwd, '.pi', 'reminders', 'project.ts'), 'export default () => ({ on: "turn_end", when: () => false, message: "project" });');

  const result = await mod.loadReminders(fakePi(), cwd);

  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(result.reminders.map((r) => r.name), ['project']);
}));

test('skips reminder discovery paths that are files', () => withAgentDir(async (agentDir) => {
  const cwd = tempDir();
  fs.writeFileSync(path.join(agentDir, 'reminders'), 'not a directory');
  write(path.join(cwd, '.pi', 'reminders', 'project.ts'), 'export default () => ({ on: "turn_end", when: () => false, message: "project" });');

  const result = await mod.loadReminders(fakePi(), cwd);

  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(result.reminders.map((r) => r.name), ['project']);
}));

test('project reminder overrides global reminder with same name', () => withAgentDir(async (agentDir) => {
  const cwd = tempDir();
  write(path.join(agentDir, 'reminders', 'same.ts'), 'export default () => ({ on: "turn_end", when: () => true, message: "global" });');
  write(path.join(cwd, '.pi', 'reminders', 'same.ts'), 'export default () => ({ on: "turn_end", when: () => true, message: "project" });');

  const result = await mod.loadReminders(fakePi(), cwd);

  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.reminders.length, 1);
  assert.match(result.reminders[0].path.replace(/\\/g, '/'), /\.pi\/reminders\/same\.ts$/);
}));

for (const trusted of [false, true, undefined]) {
  test(`project reminder execution respects host trust (${trusted ?? 'legacy host'})`, () => withAgentDir(async (agentDir) => {
    const cwd = tempDir();
    const globalSource = 'export default () => ({ on: "session_start", when: () => true, message: "global", triggerTurn: false });';
    write(path.join(agentDir, 'reminders', 'same.ts'), globalSource);
    for (const name of ['same.ts', 'nested/index.ts']) {
      const marker = path.join(cwd, name.replace('/', '-'));
      writeProjectReminder(cwd, `
        import { writeFileSync } from 'node:fs';
        writeFileSync(${JSON.stringify(marker)}, 'module executed');
        export default () => ({ on: "session_start", when: () => true, message: "project", triggerTurn: false });
      `, name);
    }
    const pi = fakePi();
    const ctx = fakeCtx(cwd);
    if (trusted !== undefined) ctx.isProjectTrusted = () => trusted;
    mod.default(pi);

    await pi.handlers.get('session_start')[0]({ type: 'session_start', reason: 'startup' }, ctx);

    assert.equal(fs.existsSync(path.join(cwd, 'same.ts')), trusted !== false, 'top-level module execution');
    assert.equal(fs.existsSync(path.join(cwd, 'nested-index.ts')), trusted !== false, 'directory module execution');
    assert.deepEqual(pi.messages.map(({ message }) => message.details.message),
      trusted === false ? ['global'] : ['project', 'project']);
    assert.equal(ctx.notifications.some(({ level }) => level === 'warning'), false);
  }));
}

test('cooldown and once suppress repeated firing', async () => {
  const pi = fakePi();
  const ctx = fakeCtx(tempDir(), [{}]);
  const diagnostics = [];
  const reminders = [{
    name: 'cool',
    reminder: { on: 'turn_end', when: () => true, message: 'hello', cooldown: 2, once: true },
    events: new Set(['turn_end']),
    evalCount: 0,
    lastFiredAt: -Infinity,
    fired: false,
    path: '/tmp/cool.ts',
  }];

  await mod.evaluate('turn_end', reminders, diagnostics, {}, ctx, pi);
  await mod.evaluate('turn_end', reminders, diagnostics, {}, ctx, pi);
  await mod.evaluate('turn_end', reminders, diagnostics, {}, ctx, pi);
  await mod.evaluate('turn_end', reminders, diagnostics, {}, ctx, pi);

  assert.equal(pi.messages.length, 1);
});

test('stale ctx.sessionManager.getBranch does not throw', async () => {
  const pi = fakePi();
  const ctx = { sessionManager: { getBranch: () => { throw new Error('stale'); } } };
  const diagnostics = [];
  const reminders = [{
    name: 'stale',
    reminder: { on: 'turn_end', when: () => true, message: 'hello' },
    events: new Set(['turn_end']),
    evalCount: 0,
    lastFiredAt: -Infinity,
    fired: false,
    path: '/tmp/stale.ts',
  }];

  await assert.doesNotReject(() => mod.evaluate('turn_end', reminders, diagnostics, {}, ctx, pi));
  assert.equal(pi.messages.length, 0);
});

test('fired reminder sends steer message with triggerTurn and escaped XML', async () => {
  const pi = fakePi();
  const ctx = fakeCtx(tempDir(), [{}]);
  const diagnostics = [];
  const reminders = [{
    name: 'bad"<name>',
    reminder: { on: 'turn_end', when: () => true, message: 'hello <world> & bye' },
    events: new Set(['turn_end']),
    evalCount: 0,
    lastFiredAt: -Infinity,
    fired: false,
    path: '/tmp/bad.ts',
  }];

  await mod.evaluate('turn_end', reminders, diagnostics, {}, ctx, pi);

  assert.equal(pi.messages.length, 1);
  assert.deepEqual(pi.messages[0].options, { deliverAs: 'steer', triggerTurn: true });
  assert.match(pi.messages[0].message.content, /name="bad&quot;&lt;name&gt;"/);
  assert.match(pi.messages[0].message.content, /hello &lt;world&gt; &amp; bye/);
  assert.deepEqual(pi.messages[0].message.details, { name: 'bad"<name>', message: 'hello <world> & bye' });
});

test('reminder can opt out of triggering a follow-up turn', async () => {
  const pi = fakePi();
  const ctx = fakeCtx(tempDir(), [{}]);
  const diagnostics = [];
  const reminders = [{
    name: 'quiet',
    reminder: { on: 'agent_start', when: () => true, message: 'quiet', triggerTurn: false },
    events: new Set(['agent_start']),
    evalCount: 0,
    lastFiredAt: -Infinity,
    fired: false,
    path: '/tmp/quiet.ts',
  }];

  await mod.evaluate('agent_start', reminders, diagnostics, {}, ctx, pi);

  assert.equal(pi.messages.length, 1);
  assert.deepEqual(pi.messages[0].options, { deliverAs: 'steer', triggerTurn: false });
});

test('concise-output reminds without triggering a follow-up turn', async () => {
  const pi = fakePi();
  const factory = jiti('../examples/concise-output.ts').default;
  const reminder = factory(pi);
  const loaded = {
    name: 'concise-output',
    reminder,
    events: new Set([reminder.on]),
    evalCount: 0,
    lastFiredAt: -Infinity,
    fired: false,
    path: '/tmp/concise-output.ts',
  };
  const ctx = fakeCtx(tempDir(), [{}]);
  const diagnostics = [];

  await mod.evaluate('agent_start', [loaded], diagnostics, {}, ctx, pi);

  assert.equal(pi.messages.length, 1);
  assert.deepEqual(pi.messages[0].options, { deliverAs: 'steer', triggerTurn: false });
  assert.match(pi.messages[0].message.content, /Use as few words as possible/);
});

test('advisory examples opt out of triggering follow-up turns', () => {
  const examples = [
    'token-usage',
    'context-large',
    'task-tools-reminder',
    'model-changed',
    'session-resumed',
    'post-compaction',
    'file-empty',
    'malware-awareness',
  ];

  for (const example of examples) {
    const pi = fakePi();
    const factory = jiti(`../examples/${example}.ts`).default;
    const result = factory(pi);
    const reminders = Array.isArray(result) ? result : [result];
    assert.ok(reminders.some((reminder) => reminder.triggerTurn === false), example);
  }
});

test('session-location reports session file at startup without triggering a turn', async () => {
  const pi = fakePi();
  const factory = jiti('../examples/session-location.ts').default;
  const reminder = factory(pi);
  const loaded = {
    name: 'session-location',
    reminder,
    events: reminderEvents(reminder),
    evalCount: 0,
    lastFiredAt: -Infinity,
    fired: false,
    path: '/tmp/session-location.ts',
  };
  const ctx = fakeCtx(tempDir(), [{}]);
  ctx.sessionManager.getSessionFile = () => '/tmp/session.jsonl';
  const diagnostics = [];

  await mod.evaluate('session_start', [loaded], diagnostics, {}, ctx, pi);
  await mod.evaluate('agent_start', [loaded], diagnostics, {}, ctx, pi);

  assert.equal(pi.messages.length, 1);
  assert.deepEqual(pi.messages[0].options, { deliverAs: 'steer', triggerTurn: false });
  assert.match(pi.messages[0].message.content, /Current Pi session file: \/tmp\/session\.jsonl/);
});

test('session-location falls back to agent_start when session file is unavailable at startup', async () => {
  const pi = fakePi();
  const factory = jiti('../examples/session-location.ts').default;
  const reminder = factory(pi);
  const loaded = {
    name: 'session-location',
    reminder,
    events: reminderEvents(reminder),
    evalCount: 0,
    lastFiredAt: -Infinity,
    fired: false,
    path: '/tmp/session-location.ts',
  };
  const ctx = fakeCtx(tempDir(), [{}]);
  let sessionFile;
  ctx.sessionManager.getSessionFile = () => sessionFile;
  const diagnostics = [];

  await mod.evaluate('session_start', [loaded], diagnostics, { reason: 'startup' }, ctx, pi);
  sessionFile = '/tmp/session.jsonl';
  await mod.evaluate('agent_start', [loaded], diagnostics, {}, ctx, pi);

  assert.equal(pi.messages.length, 1);
  assert.deepEqual(pi.messages[0].options, { deliverAs: 'steer', triggerTurn: false });
  assert.match(pi.messages[0].message.content, /Current Pi session file: \/tmp\/session\.jsonl/);
});

test('session-location stays quiet on reload and resume, including agent_start fallback', async () => {
  const factory = jiti('../examples/session-location.ts').default;

  for (const reason of ['reload', 'resume']) {
    const pi = fakePi();
    const reminder = factory(pi);
    const loaded = {
      name: 'session-location',
      reminder,
      events: reminderEvents(reminder),
      evalCount: 0,
      lastFiredAt: -Infinity,
      fired: false,
      path: '/tmp/session-location.ts',
    };
    const ctx = fakeCtx(tempDir(), [{}]);
    ctx.sessionManager.getSessionFile = () => '/tmp/session.jsonl';
    const diagnostics = [];

    await mod.evaluate('session_start', [loaded], diagnostics, { reason }, ctx, pi);
    await mod.evaluate('agent_start', [loaded], diagnostics, {}, ctx, pi);

    assert.equal(pi.messages.length, 0, reason);
  }
});

test('malware-awareness is one reminder with startup and read triggers', async () => {
  const pi = fakePi();
  const factory = jiti('../examples/malware-awareness.ts').default;
  const reminder = factory(pi);
  const loaded = {
    name: 'malware-awareness',
    reminder,
    events: reminderEvents(reminder),
    evalCount: 0,
    lastFiredAt: -Infinity,
    fired: false,
    path: '/tmp/malware-awareness.ts',
  };
  const ctx = fakeCtx(tempDir(), [{}]);
  const diagnostics = [];

  await mod.evaluate('session_start', [loaded], diagnostics, {}, ctx, pi);

  assert.deepEqual(reminder.on, ['session_start', 'tool_execution_end']);
  assert.equal(reminder.cooldown, 20);
  assert.equal(pi.messages.length, 1);
  assert.deepEqual(pi.messages[0].options, { deliverAs: 'steer', triggerTurn: false });
  assert.match(pi.messages[0].message.content, /consider whether it could be malware/);
});

test('malware-awareness picks up cooldown from existing session reminder', async () => {
  const pi = fakePi();
  const factory = jiti('../examples/malware-awareness.ts').default;
  const reminder = factory(pi);
  const branch = [{
    type: 'custom_message',
    customType: 'system-reminder',
    details: { name: 'malware-awareness' },
  }];
  const loaded = {
    name: 'malware-awareness',
    reminder,
    events: reminderEvents(reminder),
    evalCount: 0,
    lastFiredAt: -Infinity,
    fired: false,
    path: '/tmp/malware-awareness.ts',
  };
  const ctx = fakeCtx(tempDir(), branch);
  const diagnostics = [];

  await mod.evaluate('session_start', [loaded], diagnostics, { reason: 'resume' }, ctx, pi);

  assert.equal(pi.messages.length, 0);
  assert.equal(loaded.fired, true);
});

test('malware-awareness skips empty reads and shares cooldown with startup', async () => {
  const factory = jiti('../examples/malware-awareness.ts').default;

  const pi = fakePi();
  const reminder = factory(pi);
  const loaded = {
    name: 'malware-awareness',
    reminder,
    events: reminderEvents(reminder),
    evalCount: 0,
    lastFiredAt: -Infinity,
    fired: false,
    path: '/tmp/malware-awareness.ts',
  };
  const ctx = fakeCtx(tempDir(), [{}]);
  const diagnostics = [];
  const emitRead = async (content) => {
    for (const handler of pi.handlers.get('tool_result') ?? []) {
      await handler({ toolName: 'read', isError: false, content }, ctx);
    }
    await mod.evaluate('tool_execution_end', [loaded], diagnostics, { toolName: 'read' }, ctx, pi);
  };

  await emitRead([{ type: 'text', text: '   ' }]);
  assert.equal(pi.messages.length, 0);
  await emitRead([{ type: 'text', text: 'code' }]);
  assert.equal(pi.messages.length, 1);

  const pi2 = fakePi();
  const reminder2 = factory(pi2);
  const loaded2 = { ...loaded, reminder: reminder2, events: reminderEvents(reminder2), evalCount: 0, lastFiredAt: -Infinity, fired: false };
  const emitRead2 = async (content) => {
    for (const handler of pi2.handlers.get('tool_result') ?? []) {
      await handler({ toolName: 'read', isError: false, content }, ctx);
    }
    await mod.evaluate('tool_execution_end', [loaded2], diagnostics, { toolName: 'read' }, ctx, pi2);
  };

  await mod.evaluate('session_start', [loaded2], diagnostics, {}, ctx, pi2);
  await emitRead2([{ type: 'text', text: 'more code' }]);
  assert.equal(pi2.messages.length, 1);
});

test('malformed reminder reports diagnostics', () => withAgentDir(async (agentDir) => {
  const cwd = tempDir();
  write(path.join(agentDir, 'reminders', 'broken.ts'), 'export default () => ({ on: "not_an_event", when: () => true, message: "x" });');

  const result = await mod.loadReminders(fakePi(), cwd);

  assert.equal(result.reminders.length, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].phase, 'validate');
}));

test('async reminder factories are supported', () => withAgentDir(async () => {
  const cwd = tempDir();
  writeProjectReminder(cwd, 'export default async () => ({ on: "turn_end", when: () => true, message: "async" });');

  const result = await mod.loadReminders(fakePi(), cwd);

  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.reminders.length, 1);
  assert.equal(result.reminders[0].reminder.message, 'async');
}));

test('validates reminder options', () => withAgentDir(async () => {
  const cwd = tempDir();
  writeProjectReminder(cwd, `
    export default () => [
      { on: "turn_end", when: () => true, message: "x", cooldown: -1 },
      { on: "turn_end", when: () => true, message: "x", once: "yes" },
      { on: "turn_end", when: () => true, message: "x", triggerTurn: "no" },
    ];
  `);

  const result = await mod.loadReminders(fakePi(), cwd);

  assert.equal(result.reminders.length, 0);
  assert.equal(result.diagnostics.length, 3);
  assert.match(result.diagnostics[0].message, /cooldown/);
  assert.match(result.diagnostics[1].message, /once/);
  assert.match(result.diagnostics[2].message, /triggerTurn/);
}));

test('supports newer pi events', () => withAgentDir(async () => {
  const cwd = tempDir();
  writeProjectReminder(cwd, 'export default () => ({ on: "tool_execution_update", when: () => true, message: "update" });');
  const pi = fakePi();
  const ctx = fakeCtx(cwd, [{}]);

  mod.default(pi);
  await pi.handlers.get('session_start')[0]({ type: 'session_start', reason: 'startup' }, ctx);
  await pi.handlers.get('tool_execution_update')[0]({ type: 'tool_execution_update', toolName: 'bash' }, ctx);

  assert.equal(pi.messages.length, 1);
  assert.match(pi.messages[0].message.content, /update/);
}));

test('invalid runtime return values report deduped diagnostics', async () => {
  const pi = fakePi();
  const ctx = fakeCtx(tempDir(), [{}]);
  const diagnostics = [];
  const reminders = [{
    name: 'bad-return',
    reminder: { on: 'turn_end', when: () => 'yes', message: () => 123 },
    events: new Set(['turn_end']),
    evalCount: 0,
    lastFiredAt: -Infinity,
    fired: false,
    path: '/tmp/bad-return.ts',
  }];

  await mod.evaluate('turn_end', reminders, diagnostics, {}, ctx, pi);
  await mod.evaluate('turn_end', reminders, diagnostics, {}, ctx, pi);

  assert.equal(pi.messages.length, 0);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].phase, 'when');
  assert.equal(diagnostics[0].count, 2);
});

test('runtime diagnostics are capped', async () => {
  const pi = fakePi();
  const ctx = fakeCtx(tempDir(), [{}]);
  const diagnostics = [];
  const reminders = Array.from({ length: 60 }, (_, i) => ({
    name: `throws-${i}`,
    reminder: { on: 'turn_end', when: () => { throw new Error(`bad-${i}`); }, message: 'hello' },
    events: new Set(['turn_end']),
    evalCount: 0,
    lastFiredAt: -Infinity,
    fired: false,
    path: `/tmp/throws-${i}.ts`,
  }));

  await mod.evaluate('turn_end', reminders, diagnostics, {}, ctx, pi);

  assert.equal(diagnostics.length, 50);
});

test('message functions must return strings', async () => {
  const pi = fakePi();
  const ctx = fakeCtx(tempDir(), [{}]);
  const diagnostics = [];
  const reminders = [{
    name: 'bad-message',
    reminder: { on: 'turn_end', when: () => true, message: () => 123 },
    events: new Set(['turn_end']),
    evalCount: 0,
    lastFiredAt: -Infinity,
    fired: false,
    path: '/tmp/bad-message.ts',
  }];

  await mod.evaluate('turn_end', reminders, diagnostics, {}, ctx, pi);

  assert.equal(pi.messages.length, 0);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].phase, 'message');
});

test('runtime reminder errors report diagnostics', async () => {
  const pi = fakePi();
  const ctx = fakeCtx(tempDir(), [{}]);
  const diagnostics = [];
  const reminders = [{
    name: 'throws',
    reminder: { on: 'turn_end', when: () => { throw new Error('bad when'); }, message: 'hello' },
    events: new Set(['turn_end']),
    evalCount: 0,
    lastFiredAt: -Infinity,
    fired: false,
    path: '/tmp/throws.ts',
  }];

  await mod.evaluate('turn_end', reminders, diagnostics, {}, ctx, pi);

  assert.equal(pi.messages.length, 0);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].phase, 'when');
});

test('reminder factories are not loaded before session_start', async () => {
  await withAgentDir(async (agentDir) => {
    const cwd = tempDir();
    write(path.join(agentDir, 'reminders', 'hook.ts'), 'export default (pi) => { pi.on("tool_result", () => {}); return { on: "turn_end", when: () => false, message: "x" }; };');
    const pi = fakePi();
    const ctx = fakeCtx(cwd, [{}]);

    mod.default(pi);

    assert.equal(pi.handlers.get('tool_result')?.length ?? 0, 1, 'only extension handler exists before session_start');
    await pi.handlers.get('session_start')[0]({}, ctx);
    assert.equal(pi.handlers.get('tool_result').length, 2, 'reminder hook is added once during session_start');
  });
});

test('does not read the branch when no reminders match the event', () => withAgentDir(async () => {
  const cwd = tempDir();
  writeProjectReminder(cwd, `
    export default () => ({
      on: "tool_call",
      when: () => true,
      message: "tool reminder",
    });
  `);
  const pi = fakePi();
  mod.default(pi);

  const ctx = {
    cwd,
    ui: { notify() {} },
    sessionManager: {
      getBranch() {
        throw new Error('getBranch should not be called');
      },
    },
  };

  await pi.handlers.get('session_start')[0]({}, ctx);
  await pi.handlers.get('message_end')[0]({}, ctx);

  assert.equal(pi.messages.length, 0);
}));

test('skips matching reminders when branch lookup is unavailable', () => withAgentDir(async () => {
  const cwd = tempDir();
  writeProjectReminder(cwd, `
    export default () => ({
      on: "message_end",
      when: () => true,
      message: "message reminder",
    });
  `);
  const pi = fakePi();
  mod.default(pi);

  const ctx = {
    cwd,
    ui: { notify() {} },
    sessionManager: {
      getBranch() {
        throw new Error('branch unavailable');
      },
    },
  };

  await pi.handlers.get('session_start')[0]({}, ctx);
  await pi.handlers.get('message_end')[0]({}, ctx);

  assert.equal(pi.messages.length, 0);
}));

test('fires a matching reminder when branch lookup succeeds', () => withAgentDir(async () => {
  const cwd = tempDir();
  writeProjectReminder(cwd, `
    export default () => ({
      on: "message_end",
      when: ({ branch, event }) => branch[0].role === "user" && event.done === true,
      message: ({ branch }) => "branch length " + branch.length,
    });
  `);
  const pi = fakePi();
  mod.default(pi);

  let getBranchCalls = 0;
  const ctx = {
    cwd,
    ui: { notify() {} },
    sessionManager: {
      getBranch() {
        getBranchCalls++;
        return [{ role: 'user', content: 'hello' }];
      },
    },
  };

  await pi.handlers.get('session_start')[0]({}, ctx);
  await pi.handlers.get('message_end')[0]({ done: true }, ctx);

  assert.equal(getBranchCalls, 1);
  assert.equal(pi.messages.length, 1);
  assert.match(pi.messages[0].message.content, /<system-reminder name="example">\nbranch length 1\n<\/system-reminder>/);
  assert.deepEqual(pi.messages[0].options, { deliverAs: 'steer', triggerTurn: true });
}));

test('evaluates only reminders matching the current event', () => withAgentDir(async () => {
  const cwd = tempDir();
  writeProjectReminder(cwd, `
    export default () => [
      {
        on: "message_end",
        when: () => true,
        message: "matching reminder",
      },
      {
        on: "tool_call",
        when: () => { throw new Error("non-matching reminder should not run"); },
        message: "non-matching reminder",
      },
    ];
  `);
  const pi = fakePi();
  mod.default(pi);

  const ctx = {
    cwd,
    ui: { notify() {} },
    sessionManager: {
      getBranch() {
        return [];
      },
    },
  };

  await pi.handlers.get('session_start')[0]({}, ctx);
  await pi.handlers.get('message_end')[0]({}, ctx);

  assert.equal(pi.messages.length, 1);
  assert.match(pi.messages[0].message.content, /matching reminder/);
  assert.doesNotMatch(pi.messages[0].message.content, /non-matching reminder/);
}));

async function runExampleReminder(exampleName, toolResultEvent) {
  const pi = fakePi();
  const factory = jiti(`../examples/${exampleName}.ts`).default;
  const reminder = factory(pi);
  const loaded = {
    name: exampleName,
    reminder,
    events: new Set([reminder.on]),
    evalCount: 0,
    lastFiredAt: -Infinity,
    fired: false,
    path: `/tmp/${exampleName}.ts`,
  };
  const ctx = fakeCtx(tempDir(), [{}]);
  const diagnostics = [];

  for (const handler of pi.handlers.get('tool_result') ?? []) {
    await handler(toolResultEvent, ctx);
  }
  await mod.evaluate('tool_execution_end', [loaded], diagnostics, { toolName: toolResultEvent.toolName }, ctx, pi);

  return { pi, diagnostics };
}

test('prefer-edit counts writes per agent round and fires once', async () => {
  const pi = fakePi();
  const factory = jiti('../examples/prefer-edit.ts').default;
  const reminder = factory(pi);
  const loaded = {
    name: 'prefer-edit',
    reminder,
    events: new Set([reminder.on]),
    evalCount: 0,
    lastFiredAt: -Infinity,
    fired: false,
    path: '/tmp/prefer-edit.ts',
  };
  const ctx = fakeCtx(tempDir(), [{}]);
  const diagnostics = [];
  const writeResult = { type: 'tool_result', toolName: 'write', isError: false };

  const emit = async (event, data) => {
    for (const handler of pi.handlers.get(event) ?? []) {
      await handler(data, ctx);
    }
  };
  const evaluate = async () => {
    await mod.evaluate('tool_execution_end', [loaded], diagnostics, { toolName: 'write' }, ctx, pi);
  };

  await emit('agent_start', {});
  await emit('tool_result', writeResult);
  await evaluate();
  await emit('tool_result', writeResult);
  await evaluate();
  assert.equal(pi.messages.length, 0);

  await emit('tool_result', writeResult);
  await evaluate();
  assert.equal(pi.messages.length, 1);
  assert.match(pi.messages[0].message.content, /3\+ times this round/);

  await emit('tool_result', writeResult);
  await evaluate();
  assert.equal(pi.messages.length, 1);

  await emit('agent_start', {});
  await emit('tool_result', writeResult);
  await evaluate();
  await emit('tool_result', writeResult);
  await evaluate();
  await emit('tool_result', writeResult);
  await evaluate();
  assert.equal(pi.messages.length, 2);
  assert.equal(diagnostics.length, 0);
});

test('background-subagents fires after successful background Agent spawn', async () => {
  const { pi, diagnostics } = await runExampleReminder('background-subagents', {
    type: 'tool_result',
    toolName: 'Agent',
    toolCallId: '1',
    input: { prompt: 'Find auth files', description: 'Find auth', subagent_type: 'Explore', run_in_background: true },
    content: [{ type: 'text', text: 'Agent started in background.' }],
    details: { status: 'background', agentId: 'agent-1' },
    isError: false,
  });

  assert.equal(diagnostics.length, 0);
  assert.equal(pi.messages.length, 1);
  assert.match(pi.messages[0].message.content, /background subagents/);
  assert.match(pi.messages[0].message.content, /Avoid duplicating their work/);
  assert.match(pi.messages[0].message.content, /get_subagent_result/);
});

test('background-subagents ignores foreground Agent spawn', async () => {
  const { pi } = await runExampleReminder('background-subagents', {
    type: 'tool_result',
    toolName: 'Agent',
    toolCallId: '1',
    input: { prompt: 'Find auth files', description: 'Find auth', subagent_type: 'Explore', run_in_background: false },
    content: [{ type: 'text', text: 'Agent completed.' }],
    details: { status: 'completed' },
    isError: false,
  });

  assert.equal(pi.messages.length, 0);
});

test('background-subagents ignores failed background Agent spawn', async () => {
  const { pi } = await runExampleReminder('background-subagents', {
    type: 'tool_result',
    toolName: 'Agent',
    toolCallId: '1',
    input: { prompt: 'Find auth files', description: 'Find auth', subagent_type: 'Explore', run_in_background: true },
    content: [{ type: 'text', text: 'Agent failed.' }],
    details: undefined,
    isError: true,
  });

  assert.equal(pi.messages.length, 0);
});

test('bash-failed-truncated fires on failed bash with truncation details', async () => {
  const { pi, diagnostics } = await runExampleReminder('bash-failed-truncated', {
    type: 'tool_result',
    toolName: 'bash',
    toolCallId: '1',
    input: { command: 'npm test' },
    content: [{ type: 'text', text: 'tail output' }],
    details: { truncation: { truncated: true }, fullOutputPath: '/tmp/pi-bash.log' },
    isError: true,
  });

  assert.equal(diagnostics.length, 0);
  assert.equal(pi.messages.length, 1);
  assert.match(pi.messages[0].message.content, /Bash output was truncated and the command failed/);
  assert.match(pi.messages[0].message.content, /Full output: \/tmp\/pi-bash\.log/);
});

test('bash-failed-truncated fires on failed bash with full output marker', async () => {
  const { pi } = await runExampleReminder('bash-failed-truncated', {
    type: 'tool_result',
    toolName: 'bash',
    toolCallId: '1',
    input: { command: 'npm test' },
    content: [{ type: 'text', text: 'tail\n[Showing lines 1-2 of 3. Full output: C:\\Temp\\pi-bash.log]' }],
    details: undefined,
    isError: true,
  });

  assert.equal(pi.messages.length, 1);
  assert.match(pi.messages[0].message.content, /C:\\Temp\\pi-bash\.log/);
});

test('bash-failed-truncated ignores successful truncated bash', async () => {
  const { pi } = await runExampleReminder('bash-failed-truncated', {
    type: 'tool_result',
    toolName: 'bash',
    toolCallId: '1',
    input: { command: 'printf lots' },
    content: [{ type: 'text', text: '[Showing lines 1-2 of 3. Full output: /tmp/pi-bash.log]' }],
    details: { truncation: { truncated: true }, fullOutputPath: '/tmp/pi-bash.log' },
    isError: false,
  });

  assert.equal(pi.messages.length, 0);
});

test('bash-failed-truncated ignores normal failed bash', async () => {
  const { pi } = await runExampleReminder('bash-failed-truncated', {
    type: 'tool_result',
    toolName: 'bash',
    toolCallId: '1',
    input: { command: 'false' },
    content: [{ type: 'text', text: 'Command exited with code 1' }],
    details: undefined,
    isError: true,
  });

  assert.equal(pi.messages.length, 0);
});
