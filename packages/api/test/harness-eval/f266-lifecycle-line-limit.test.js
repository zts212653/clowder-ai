import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = fileURLToPath(new URL('.', import.meta.url));
const lifecycleTestNames = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .filter(
    (name) =>
      name.includes('lifecycle') ||
      name.includes('reeval-closure') ||
      name.includes('reeval-case') ||
      name.includes('eval-verdict-closure'),
  )
  .sort();

function lineCount(path) {
  const source = readFileSync(path, 'utf8');
  return source.split(/\r?\n/).length - (source.endsWith('\n') ? 1 : 0);
}

describe('F266 lifecycle test file limits', () => {
  for (const name of lifecycleTestNames) {
    it(`${name} stays within the 350-line hard cap`, () => {
      const lines = lineCount(fileURLToPath(new URL(name, import.meta.url)));
      assert.ok(lines <= 350, `${name} exceeds 350 lines: ${lines}`);
    });
  }
});
