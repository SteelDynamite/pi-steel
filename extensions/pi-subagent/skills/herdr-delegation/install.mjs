import { constants, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parse } from 'yaml';

const roles = ['scout', 'worker', 'worker-visual', 'reviewer'];
const usage = 'Usage: node install.mjs --agent-dir /absolute/path/to/pi/agent';

function render(role, agentDir) {
  const source = readFileSync(new URL(`../../agents/${role}/SUBAGENTS.md`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const parts = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(source);
  if (!parts) throw new Error(`Invalid bundled role: ${role}`);
  const { description, model, thinking, tools } = parse(parts[1]);
  // hc reads single-line header values, not YAML quoted scalars. Keep command
  // arguments literal; never put role text or the caller's task into a shell command.
  if (typeof description !== 'string' || /[\r\n]/.test(description) || !description.trim() || !parts[2].trim()) throw new Error(`Invalid role text: ${role}`);
  if (typeof model !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(model)) throw new Error(`Invalid bundled model: ${role}`);
  const [provider, id] = model.split('/');
  const cmd = ['env', 'PI_ORCHESTRATED_CHILD=1', `'PI_CODING_AGENT_DIR=${agentDir}'`, 'pi', '--provider', provider, '--model', id];
  if (thinking !== undefined) {
    if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) throw new Error(`Invalid thinking level: ${role}`);
    cmd.push('--thinking', thinking);
  }
  if (tools !== undefined) {
    const names = typeof tools === 'string' ? tools.split(',').map(name => name.trim()) : [];
    if (!names.length || !names.every(name => /^[\w-]+$/.test(name))) throw new Error(`Invalid tool list: ${role}`);
    cmd.push('--tools', names.join(','));
  }
  return `---\nname: steel-${role}\ndescription: ${description}\ncommand: ${cmd.join(' ')}\n---\n\n${parts[2].trim()}\n\nWork only on the assigned task. Do not start more agents. Report results or blockers to the parent terminal specified in the task.\n`;
}

const digest = value => createHash('sha256').update(value).digest('hex');
const stamp = /^---\nsteel-managed: v1 ([a-f0-9]{64}) ([a-f0-9]{64})\n/;

function readTemplate(path) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  try {
    const stat = fstatSync(fd);
    if (stat.isFile() && stat.size <= 256 * 1024) return readFileSync(fd, 'utf8');
    throw new Error(`Refusing to overwrite ${path}. Move it aside yourself before reinstalling.`);
  } finally { closeSync(fd); }
}

export function syncTemplates(agentDir) {
  if (process.platform === 'win32' || !isAbsolute(agentDir) || /['\x00-\x1f\x7f]/.test(agentDir)) throw new Error('Requires an absolute POSIX agent path without single quotes or control characters.');
  const profile = digest(agentDir);
  const templates = roles.map(role => {
    const body = render(role, agentDir);
    const text = body.replace('---\n', `---\nsteel-managed: v1 ${profile} ${digest(body)}\n`);
    return { name: `steel-${role}.md`, body, text };
  });
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  if (!isAbsolute(config)) throw new Error('XDG_CONFIG_HOME must be absolute.');
  const directory = join(config, 'herdr-core', 'templates');
  for (const dir of [config, join(config, 'herdr-core'), directory]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(dir).isDirectory()) throw new Error(`Not a real directory: ${dir}`);
  }
  // One foreground writer; no retries or stale-lock stealing. A crash leaves any
  // displaced original in the lock directory for recovery, not in a temp cleaner.
  const stage = join(directory, '.pi-steel-sync');
  mkdirSync(stage, { mode: 0o700 });
  try {
    const pending = [];
    for (const { name, body, text } of templates) {
      const path = join(directory, name);
      const old = readTemplate(path);
      if (old === text || old === body) continue; // Unmarked legacy matches stay unclaimed.
      if (old !== undefined) {
        const marker = stamp.exec(old);
        if (marker?.[1] !== profile || marker[2] !== digest(old.replace(stamp, '---\n')) || !old.includes(`\nname: ${name.slice(0, -3)}\n`)) {
          throw new Error(`Refusing to replace ${name}: personal, edited, or pinned to another Pi directory.`);
        }
      }
      pending.push({ path, old, text });
    }
    for (const { path, old, text } of pending) {
      const next = join(stage, 'next');
      const backup = join(stage, 'previous');
      writeFileSync(next, text, { flag: 'wx', mode: 0o600 });
      try {
        if (old !== undefined) renameSync(path, backup);
        try {
          if (old !== undefined && readTemplate(backup) !== old) throw new Error('Template changed during update.');
          linkSync(next, path); // Never replace a concurrently created personal file.
        } catch (error) {
          if (old !== undefined) { linkSync(backup, path); unlinkSync(backup); }
          throw error;
        }
        if (old !== undefined) unlinkSync(backup);
      } finally { unlinkSync(next); }
    }
    return pending.length;
  } finally { rmdirSync(stage); } // Fails closed if recovery material remains.
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help') console.log(usage);
    else if (args.length === 2 && args[0] === '--agent-dir') console.log(syncTemplates(args[1]) ? 'Steel templates synchronized.' : 'Already installed; no changes.');
    else throw new Error(usage);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
