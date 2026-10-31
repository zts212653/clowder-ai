import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('the retained F247 Host feature document stays within its accepted line budget', async () => {
  const source = await readFile(new URL('../docs/features/F247-cloud-cat-family.md', import.meta.url), 'utf8');
  const lines = source.trimEnd().split('\n').length;
  assert.ok(lines <= 915, `F247 feature document has ${lines} lines (ratcheted max 915)`);
});
