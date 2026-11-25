// Explicit POSIX hc template installer. Never imported by extension startup.
import { constants, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function missingOrIdentical(path, text) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  try {
    const stat = fstatSync(fd);
    if (stat.isFile() && stat.size === Buffer.byteLength(text) && readFileSync(fd, 'utf8') === text) return false;
    throw new Error(`Refusing to overwrite ${path}. Move it aside yourself before reinstalling.`);
  } finally { closeSync(fd); }
}

function main(args) {
  if (args.length === 1 && args[0] === '--help') return console.log(usage);
  if (args.length !== 2 || args[0] !== '--agent-dir' || !isAbsolute(args[1])) throw new Error(usage);
  if (process.platform === 'win32' || /['\x00-\x1f\x7f]/.test(args[1])) throw new Error('Requires a POSIX agent path without single quotes or control characters.');
  const directory = join(homedir(), '.config', 'herdr-core', 'templates');
  const templates = roles.map(role => ({ name: `steel-${role}.md`, text: render(role, args[1]) }));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new Error(`Not a real directory: ${directory}`);
  // Preflight every name, then atomically publish complete files without replacing
  // anything, even if someone creates a personal template after the preflight.
  const pending = templates.filter(({ name, text }) => missingOrIdentical(join(directory, name), text));
  if (!pending.length) return console.log(`Already installed in ${directory}; no changes.`);
  const stage = mkdtempSync(join(directory, '.steel-'));
  try {
    for (const { name, text } of pending) writeFileSync(join(stage, name), text, { mode: 0o600 });
    for (const { name } of pending) {
      linkSync(join(stage, name), join(directory, name));
      console.log(`Installed ${join(directory, name)}`);
    }
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

try { main(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
