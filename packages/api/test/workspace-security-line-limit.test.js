import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const MAX_LINES = 350;
const sourceUrl = new URL('../src/domains/workspace/workspace-security.ts', import.meta.url);

function lineCount(text) {
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

test('workspace-security.ts stays below the 350-line hard limit', () => {
  const source = readFileSync(sourceUrl, 'utf8');
  const lines = lineCount(source);
  assert.ok(lines <= MAX_LINES, `workspace-security.ts has ${lines} lines, max ${MAX_LINES}`);
});
