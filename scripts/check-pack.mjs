import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const registry = JSON.parse(readFileSync(new URL('../extensions.manifest.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
const files = new Set(pack.files.map(file => file.path));
for (const path of files) {
  assert(!/(^|\/)(node_modules|test|tests|\.agents|\.github)(\/|$)/.test(path), `Forbidden packed path: ${path}`);
  assert(!/\.(tgz|log|tsbuildinfo)$/.test(path), `Artifact: ${path}`);
}
for (const path of ['index.ts', 'src/manager.ts', 'extensions.manifest.json', 'LICENSE']) assert(files.has(path), `Missing ${path}`);
assert.deepEqual(manifest.pi.extensions, ['index.ts', ...registry.extensions.map(member => member.entry)]);
for (const type of ['skills', 'prompts']) assert.deepEqual(manifest.pi[type] ?? [], registry.extensions.flatMap(member => member[type] ?? []));
for (const member of registry.extensions) {
  assert(files.has(member.entry), `Missing imported entry: ${member.entry}`);
  const directory = dirname(member.entry);
  assert(files.has(`${directory}/LICENSE`), `Missing license: ${member.id}`);
  // Directory existence alone misses partial packs: check every runtime file.
  for (const name of ['src', 'dist', 'lib', 'extensions', 'skills', 'prompts', 'templates', 'examples', 'agents']) {
    const path = join(root, directory, name);
    if (!existsSync(path)) continue;
    for (const entry of readdirSync(path, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/');
      assert(files.has(file), `Missing runtime file: ${file}`);
    }
  }
  for (const directory of [...member.skills ?? [], ...member.prompts ?? [], ...member.assets ?? []]) {
    assert([...files].some(path => path.startsWith(`${directory}/`)), `Missing resource/asset directory: ${directory}`);
  }
}
console.log(`Pack verified: ${files.size} files, ${registry.extensions.length} bundled entries`);
