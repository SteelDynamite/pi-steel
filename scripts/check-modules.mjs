import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Test automation paths normally suppressed in orchestrated children, only in
// each isolated test process; never change the running agent's environment.
const env = { ...process.env };
delete env.PI_ORCHESTRATED_CHILD;

const registry = JSON.parse(readFileSync(new URL('../extensions.manifest.json', import.meta.url), 'utf8'));
let failed = false;
for (const member of registry.extensions) {
  const cwd = resolve(dirname(fileURLToPath(new URL('../package.json', import.meta.url))), dirname(member.entry));
  const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
  const scripts = pkg.scripts ?? {};
  const checks = scripts.check ? ['check'] : ['typecheck', 'test'].filter(name => scripts[name]);
  if (!checks.length) { console.error(`${member.id}: no validation scripts`); failed = true; }
  for (const check of checks) {
    console.log(`\n${member.id}: npm run ${check}`);
    const result = spawnSync('npm', ['run', check], { cwd, stdio: 'inherit', env });
    if (result.status !== 0) failed = true;
  }
}
process.exitCode = failed ? 1 : 0;
