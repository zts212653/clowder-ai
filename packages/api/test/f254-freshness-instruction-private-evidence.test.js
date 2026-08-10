import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(apiRoot, '../..');

describe('F254 freshness instruction private evidence contract', () => {
  it('records F289/#1303 as an explicit non-cursor exclusion in the whole-chain attribution', () => {
    const report = readFileSync(
      resolve(repoRoot, 'docs/bug-report/2026-08-05-visibility-cursor-consumer-mismatch/bug-report.md'),
      'utf8',
    );

    assert.match(report, /\| F289 \/ community #1303[^\n]*\*\*Unrelated\*\*/);
  });

  it('keeps provider prepare-read-deliver revalidation owned in the F254 open-question ledger', () => {
    const feature = readFileSync(resolve(repoRoot, 'docs/features/F254-side-effect-freshness-gate.md'), 'utf8');

    assert.match(feature, /\| OQ-15 \|[^\n]*revalidation[^\n]*@codex-sol/i);
  });
});
