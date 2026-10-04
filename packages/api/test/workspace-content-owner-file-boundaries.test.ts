import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('F309 workspace owner orchestration files stay below the repository hard line limit', async () => {
  const files = [
    '../src/domains/collaborative-content/workspace-review/service.ts',
    '../src/domains/workspace/workspace-content-source.ts',
  ];
  for (const relative of files) {
    const source = await readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
    assert.ok(source.split('\n').length <= 350, `${relative} must stay at or below 350 lines`);
  }
});
