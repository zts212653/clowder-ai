import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function stripCommentsAndStrings(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/`(?:\\.|[^`])*`/g, ' ')
    .replace(/'(?:\\.|[^'])*'/g, ' ')
    .replace(/"(?:\\.|[^"])*"/g, ' ');
}

test('AC-G12/AC-G27: CatAgentService stays vendor-neutral in code identifiers', () => {
  const source = readFileSync(
    join(__dirname, '..', 'src', 'domains', 'cats', 'services', 'agents', 'providers', 'catagent', 'CatAgentService.ts'),
    'utf-8',
  );
  const stripped = stripCommentsAndStrings(source);
  for (const pattern of [
    /\bAnthropic[A-Za-z0-9_]*\b/,
    /\bmapAnthropicError\b/,
    /\bparseAnthropicSSE\b/,
    /\bOpenai[A-Za-z0-9_]*\b/,
    /\bopenai[A-Za-z0-9_]*\b/,
  ]) {
    assert.equal(pattern.test(stripped), false, `CatAgentService must stay vendor-neutral: ${pattern}`);
  }
});
