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

test('the Host browser lane preserves shared navigation and C2 coverage', () => {
  const root = process.cwd();
  const webPackage = JSON.parse(readFileSync(join(root, 'packages/web/package.json'), 'utf8'));
  assert.match(webPackage.scripts['pretest:browser'], /ensure-browser-test-artifacts\.cjs/);
  assert.deepEqual(scanF290WorkbenchBoundary(root), []);
  const retainedCoverage = [
    'packages/web/test/browser/f322-human-collective.journey.mjs',
    'packages/web/test/browser/fixtures/f322-human-collective.tsx',
    'packages/web/test/browser/f290-asset-true-frontend.test.mjs',
    'packages/web/test/browser/f290-runtime-journey.harness.mjs',
    'packages/web/test/browser/default-entry-journey.harness.mjs',
    'packages/web/src/components/collective/__tests__',
    'packages/collective-client/src',
  ];
  for (const path of retainedCoverage) assert.ok(existsSync(join(root, path)), `lost C2 coverage: ${path}`);
  assert.match(webPackage.scripts['test:browser'], /chat-connection-recovery\.test\.mjs/);
  assert.match(webPackage.scripts['test:browser'], /navigation-continuity\.test\.mjs/);
});
