import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scanF290WorkbenchBoundary } from './check-f290-workbench-boundary.mjs';

function write(root, path, content = '') {
  const target = join(root, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
}

test('detects rejected F290 runtime surfaces, product mounts, and persistence', () => {
  const root = mkdtempSync(join(tmpdir(), 'f290-workbench-boundary-'));
  write(root, 'packages/web/src/app/dev/f290-composable-workspace/page.tsx');
  write(root, 'packages/web/src/components/collective-workspace/Surface.tsx');
  write(root, 'packages/web/src/lib/workspace-modes.ts', "export const modes = ['collective'];\n");
  write(root, 'packages/web/src/components/WorkspacePanel.tsx', "import './collective-workspace/Surface';\n");
  write(root, 'packages/web/src/legacy.ts', "const key = 'cat-cafe:f290:collective-workspace:v1';\n");

  assert.equal(scanF290WorkbenchBoundary(root).length, 5);
});

test('the repository contains no rejected F290 workbench runtime surface', () => {
  assert.deepEqual(scanF290WorkbenchBoundary(), []);
});

test('the Host browser lane retires package journeys explicitly while retaining C2 coverage', () => {
  const root = process.cwd();
  const webPackage = JSON.parse(readFileSync(join(root, 'packages/web/package.json'), 'utf8'));
  const migration = JSON.parse(
    readFileSync(join(root, 'packages/web/test/browser/collective-plugin-journey-migration.json'), 'utf8'),
  );
  assert.match(webPackage.scripts['pretest:browser'], /ensure-browser-test-artifacts\.cjs/);
  assert.equal(migration.status, 'migration_pending_installed_package_unverified');
  assert.match(migration.businessSourceCommit, /^[a-f0-9]{40}$/);
  assert.match(migration.browserSourceCommit, /^[a-f0-9]{40}$/);
  for (const entry of migration.files) {
    assert.equal(existsSync(join(root, entry.path)), false, `retired Host journey remains: ${entry.path}`);
    assert.equal(
      webPackage.scripts['test:browser'].includes(entry.path.replace('packages/web/', '')),
      false,
      `default lane still invokes the retired journey: ${entry.path}`,
    );
    assert.match(entry.sourceBlob, /^[a-f0-9]{40}$/);
    assert.ok(entry.purpose);
  }
  for (const path of migration.retainedHostCoverage)
    assert.ok(existsSync(join(root, path)), `lost C2 coverage: ${path}`);
  assert.match(webPackage.scripts['test:browser'], /chat-connection-recovery\.test\.mjs/);
  assert.match(webPackage.scripts['test:browser'], /navigation-continuity\.test\.mjs/);
});
