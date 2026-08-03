/** F128 proposal modules must stay within the repository hard line cap. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const boundedModules = [
  '../src/domains/cats/services/stores/redis/RedisProposalStore.ts',
  '../src/routes/proposal-routes.ts',
];

for (const relativePath of boundedModules) {
  test(`${relativePath} stays within the 350-line hard cap`, () => {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    const lineCount = source.split('\n').length - Number(source.endsWith('\n'));
    assert.ok(lineCount <= 350, `${relativePath} has ${lineCount} lines`);
  });
}
