import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { windowsPrefix, syncTemplates } from '../skills/herdr-delegation/install.mjs';

const installer = fileURLToPath(new URL('../skills/herdr-delegation/install.mjs', import.meta.url));
const roles = ['reviewer', 'scout', 'worker', 'worker-visual'];
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'steel-hc-roles-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = join(home, '.config/herdr-core/templates');
  const agentDir = join(home, 'Pi agent $(false)');
  const env = { HOME: home, PATH: `${home}:${process.env.PATH}` };
  const run = (...args) => spawnSync(process.execPath, [installer, ...args], { cwd: home, env, encoding: 'utf8' });
  const install = () => run('--agent-dir', agentDir);
  return { home, dir, env, run, install, agentDir };
}
const posix = { skip: process.platform === 'win32' };
const winHelper = fileURLToPath(new URL('../skills/herdr-delegation/windows-child.mjs', import.meta.url));

test('Windows command prefix pins literal drive paths across spaces and refuses shell expansion', () => {
  const agentDir = String.raw`C:\Users\Test Person\.pi\agent`;
  const invocation = { command: String.raw`C:\Program Files (x86)\nodejs\node.exe`, args: [String.raw`C:\Pi\@example\cli.js`] };
  const helper = String.raw`C:\Steel Package\windows-child.mjs`;
  assert.deepEqual(windowsPrefix(agentDir, invocation, helper), ['node', '"C:/Steel Package/windows-child.mjs"', '"C:/Users/Test Person/.pi/agent"', '"C:/Program Files (x86)/nodejs/node.exe"', '"C:/Pi/@example/cli.js"']);
  for (const bad of ['relative', '/root', 'C:relative', '//server/share', 'C:/A%PATH%', 'C:/a"b', 'C:/a$b', 'C:/a\nb', 'C:/a`b', 'C:/a&b']) {
    assert.throws(() => windowsPrefix(bad, invocation, helper));
    assert.throws(() => windowsPrefix(agentDir, { ...invocation, command: bad }, helper));
  }
});

test('Windows helper starts the pinned CLI directly in the chosen cwd with inherited terminal input, profile, role args and exit status', t => {
  const home = mkdtempSync(join(tmpdir(), 'steel helper '));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cli = join(home, 'fixture cli.mjs');
  writeFileSync(cli, `import {readFileSync} from 'node:fs'; console.log(JSON.stringify([process.env.PI_ORCHESTRATED_CHILD,process.env.PI_CODING_AGENT_DIR,process.cwd(),process.argv.slice(2),readFileSync(0,'utf8')]));process.exitCode=7;`);
  const agentDir = join(home, 'pinned agent');
  const args = ['--provider', 'openai', '--model', 'test', '--tools', 'read,grep'];
  const child = spawnSync(process.execPath, [winHelper, agentDir, process.execPath, cli, ...args], { cwd: home, input: 'first message', encoding: 'utf8', env: { ...process.env, PI_ORCHESTRATED_CHILD: '0', PI_CODING_AGENT_DIR: 'wrong' } });
  assert.equal(child.status, 7, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), ['1', agentDir, home, args, 'first message']);
});

test('native Windows installs all roles under APPDATA and preserves a personal edit', { skip: process.platform !== 'win32' }, t => {
  const home = mkdtempSync(join(tmpdir(), 'steel win '));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const previous = process.env.APPDATA;
  t.after(() => { if (previous === undefined) delete process.env.APPDATA; else process.env.APPDATA = previous; });
  process.env.APPDATA = join(home, 'Roaming');
  const agentDir = join(home, 'Pi Agent');
  const invocation = { command: process.execPath, args: [join(home, 'Pi CLI.mjs')] };
  assert.equal(syncTemplates(agentDir, invocation), 4);
  const dir = join(process.env.APPDATA, 'herdr-core', 'templates');
  assert.deepEqual(readdirSync(dir).sort(), roles.map(role => `steel-${role}.md`).sort());
  assert.equal(syncTemplates(agentDir, invocation), 0);
  const path = join(dir, 'steel-scout.md');
  assert.match(readFileSync(path, 'utf8'), /windows-child\.mjs" .* --provider openai --model gpt-6-luna/);
  writeFileSync(path, 'personal');
  assert.throws(() => syncTemplates(agentDir, invocation), /Refusing/);
  assert.equal(readFileSync(path, 'utf8'), 'personal');
});

test('explicit install snapshots bundled role bodies, pins Pi child context and static CLI flags', posix, t => {
  const { home, dir, install, env, agentDir } = fixture(t);
  writeFileSync(join(home, 'pi'), `#!/bin/sh\nprintf '%s\\n' "$PI_ORCHESTRATED_CHILD" "$PI_CODING_AGENT_DIR" "$@"\n`, { mode: 0o700 });
  const installed = install();
  assert.equal(installed.status, 0, installed.stderr);
  assert.deepEqual(readdirSync(dir).sort(), roles.map(role => `steel-${role}.md`).sort());
  const expected = {
    scout: ['--model', 'gpt-6-luna', '--tools', 'read,grep,find,ls,bash'],
    worker: ['--model', 'gpt-6.1-sol'],
    'worker-visual': ['--model', 'gpt-6-astra', '--thinking', 'medium'],
    reviewer: ['--model', 'gpt-6-astra', '--tools', 'read,grep,find,ls,bash'],
  };
  for (const role of roles) {
    const template = readFileSync(join(dir, `steel-${role}.md`), 'utf8');
    const source = readFileSync(new URL(`../agents/${role}/SUBAGENTS.md`, import.meta.url), 'utf8').split('\n---\n')[1].trim();
    assert(template.includes(`\n\n${source}\n`));
    assert(!template.includes('whenCallerModelId'));
    const command = template.match(/^command: (.+)$/m)[1];
    const child = spawnSync('sh', ['-c', command], { cwd: home, env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(child.stdout.trimEnd().split('\n'), ['1', agentDir, '--provider', 'openai', ...expected[role]]);
  }
  const file = join(dir, 'steel-scout.md');
  const before = lstatSync(file, { bigint: true });
  const again = install();
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /no changes/);
  assert.equal(lstatSync(file, { bigint: true }).mtimeNs, before.mtimeNs);
});

for (const kind of ['file', 'symlink', 'dangling']) test(`a personal ${kind} stops the install without writing other roles`, posix, t => {
  const { home, dir, install } = fixture(t);
  mkdirSync(dir, { recursive: true });
  const target = join(home, 'personal');
  const name = join(dir, 'steel-reviewer.md');
  if (kind !== 'dangling') writeFileSync(target, 'my instructions');
  if (kind === 'file') writeFileSync(name, 'my role');
  else symlinkSync(target, name);
  assert.notEqual(install().status, 0);
  assert.deepEqual(readdirSync(dir), ['steel-reviewer.md']);
  if (kind === 'file') assert.equal(readFileSync(name, 'utf8'), 'my role');
  else assert(lstatSync(name).isSymbolicLink());
  if (kind !== 'dangling') assert.equal(readFileSync(target, 'utf8'), 'my instructions');
  else assert(!existsSync(target));
});

test('updates only unchanged managed roles for this profile; never claims an edited or legacy copy', posix, t => {
  const { dir, install, run, agentDir } = fixture(t);
  assert.equal(install().status, 0);
  const path = join(dir, 'steel-scout.md');
  const current = readFileSync(path, 'utf8');
  const marker = /^---\nsteel-managed: v1 (\w+) (\w+)\n/;
  const legacy = current.replace(marker, '---\n');
  const old = legacy.replace('Work only on the assigned task.', 'Previous bundled instructions.');
  writeFileSync(path, old.replace('---\n', `---\nsteel-managed: v1 ${current.match(marker)[1]} ${createHash('sha256').update(old).digest('hex')}\n`));
  assert.equal(install().status, 0); assert.equal(readFileSync(path, 'utf8'), current);
  assert.notEqual(run('--agent-dir', `${agentDir}-other`).status, 0); assert.equal(readFileSync(path, 'utf8'), current);
  writeFileSync(path, current + 'Personal edit'); assert.notEqual(install().status, 0);
  assert.equal(readFileSync(path, 'utf8'), current + 'Personal edit');
  writeFileSync(path, legacy); assert.equal(install().status, 0); assert.equal(readFileSync(path, 'utf8'), legacy);
});

test('a busy or interrupted writer is left alone', posix, t => {
  const { dir, install } = fixture(t);
  const recovery = join(dir, '.pi-steel-sync');
  mkdirSync(recovery, { recursive: true });
  writeFileSync(join(recovery, 'previous'), 'keep');
  assert.notEqual(install().status, 0); assert.equal(readFileSync(join(recovery, 'previous'), 'utf8'), 'keep');
  assert.deepEqual(readdirSync(dir), ['.pi-steel-sync']);
});

test('help and unsupported paths never create templates', posix, t => {
  const { dir, run } = fixture(t);
  assert.equal(run('--help').status, 0);
  for (const value of ['relative', '/bad\ncommand', "/unquoted'path"]) assert.notEqual(run('--agent-dir', value).status, 0);
  assert(!existsSync(dir));
});
