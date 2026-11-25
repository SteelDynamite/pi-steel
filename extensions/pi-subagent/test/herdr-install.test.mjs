import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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

test('help and unsupported paths never create templates', posix, t => {
  const { dir, run } = fixture(t);
  assert.equal(run('--help').status, 0);
  for (const value of ['relative', '/bad\ncommand', "/unquoted'path"]) assert.notEqual(run('--agent-dir', value).status, 0);
  assert(!existsSync(dir));
});
