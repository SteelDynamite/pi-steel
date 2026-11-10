import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sandbox = mkdtempSync(join(tmpdir(), 'steel-packed-'));
try {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', sandbox], { cwd: root, encoding: 'utf8' }));
  // Install the actual tarball without dev dependencies or automatic host peers.
  execFileSync('npm', ['install', '--prefix', sandbox, '--ignore-scripts', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund', join(sandbox, pack.filename)], { stdio: 'inherit' });
  for (const name of ['pi-ai', 'pi-agent-core', 'pi-coding-agent', 'pi-tui']) {
    assert(!existsSync(join(sandbox, 'node_modules', '@earendil-works', name)), `Host peer was installed: ${name}`);
  }
  execFileSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', 'test/host.test.ts', 'test/child.test.ts', 'test/subagent-one-off.test.ts', 'test/doc-manifests-refresh.test.ts', 'test/tui.test.ts', 'test/preset.test.ts', 'test/herdr.test.ts', 'test/paseo.test.ts'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, STEEL_TEST_PACKAGE_ROOT: join(sandbox, 'node_modules', 'pi-steel') },
  });
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
