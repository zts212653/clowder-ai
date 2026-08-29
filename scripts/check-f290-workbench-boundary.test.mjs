import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
