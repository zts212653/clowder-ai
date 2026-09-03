import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findForbiddenProductTerms, scanF290ProductCopy } from './check-f290-product-copy.mjs';

test('findForbiddenProductTerms catches every internal design term', () => {
  const terms = [
    '镜片',
    '判断门',
    'inspector',
    '望窗',
    '轨迹层',
    'canonical client',
    'canonical order',
    'Service truth',
    'backed by the Service event log',
    'ACK #',
  ];
  for (const term of terms) {
    assert.deepEqual(findForbiddenProductTerms(`用户界面里出现 ${term}`), [term.toLowerCase()]);
  }
});

test('the production F290 Client, Host and official Connector have no forbidden product copy', () => {
  assert.deepEqual(scanF290ProductCopy(), []);
});

test('production Client copy is part of the enforced scan boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'f290-product-copy-'));
  try {
    const source = join(root, 'packages/collective-client/src');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'ProductShell.tsx'), 'export const title = "Canonical Client";\n');
    assert.deepEqual(scanF290ProductCopy(root), [
      {
        path: 'packages/collective-client/src/ProductShell.tsx',
        line: 1,
        term: 'canonical client',
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
