import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeMicroduckFootballArchive } from '../dist/infrastructure/capability-evolution/adapters/microduck-football/package.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const evidenceRoot = join(repoRoot, 'docs/videos/f311-microduck-roadshow/pipeline/football/evidence');

async function archive(name) {
  return JSON.parse(await readFile(join(evidenceRoot, name, 'index.json'), 'utf8'));
}

function resolved(value) {
  assert.equal(value.status, 'resolved');
  return value;
}

describe('F311 Microduck source-owned football archive identity', () => {
  it('binds v3 and its 26 second extension to the frozen package ref', async () => {
    const v3 = resolved(await normalizeMicroduckFootballArchive(await archive('20260907-approach-v3')));
    const extended = resolved(await normalizeMicroduckFootballArchive(await archive('20260907-approach-v3-extended')));

    assert.deepEqual(extended.packageRef, v3.packageRef);
    assert.deepEqual(extended.package, v3.package);
    assert.equal(v3.packageRef.version, '47556532ab380799f6cb3a5bcb4cd41947dcda126f510a1027f6a6ec3ea7a89b');
  });
});
