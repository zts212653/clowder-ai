import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const repoRoot = resolve(import.meta.dirname, '..');
const indexSource = readFileSync(resolve(repoRoot, 'src/index.ts'), 'utf8');
const collectSourcePath = resolve(repoRoot, 'src/domains/cats/services/duty-briefing/collectDutyBriefingInput.ts');

test('F233 index wiring uses configured owner for duty briefing collectDeps', () => {
  assert.match(
    indexSource,
    /const \{ getOwnerUserId: getDutyBriefingOwnerUserId \} = await import\('\.\/config\/cat-config-loader\.js'\)/,
  );
  assert.match(indexSource, /userId:\s*getDutyBriefingOwnerUserId\(\)/);
});

test('F233 collect source contains no literal NUL byte', () => {
  const raw = readFileSync(collectSourcePath);
  assert.equal(raw.includes(0), false, 'source file must remain plain text, not binary');
  // Positive control: the file read is the collector (F117 KD-23 removed the draft key that used a \\0 separator).
  assert.match(raw.toString('utf8'), /export async function collectZombies\(/);
});
