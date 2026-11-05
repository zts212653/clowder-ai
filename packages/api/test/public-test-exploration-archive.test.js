import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolvePublicTestFiles } from '../scripts/resolve-public-test-files.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const archiveConsumers = [
  'capability-evolution-exploration-archive-projection.test.js',
  'capability-evolution-exploration-football.test.js',
  'capability-evolution-exploration-integrity.test.js',
  'capability-evolution-exploration-record-failures.test.js',
];

test('public selection retains fixture-backed archive consumers and portable exploration behavior', async () => {
  const resolved = await resolvePublicTestFiles({ packageRoot });
  for (const file of [
    'test/capability-evolution-exploration-projection-failure.test.js',
    'test/capability-evolution-exploration-source-isolation.test.js',
    'test/capability-evolution-exploration-routes.test.js',
    'test/capability-evolution-exploration-failure-routes.test.js',
    'test/capability-evolution-exploration-message-routing.test.js',
  ]) {
    assert(resolved.selectedFiles.includes(file), `${file} must keep protecting the public product`);
    assert(!resolved.excludedFiles.includes(file), `${file} no longer needs the private archive`);
  }
});

// F330 moved the original historical assertions to the mandatory home source
// lane. Public runtime fixtures must remain selected without exporting proofs.
test('original archive proofs remain home-only while fixture consumers are exported', () => {
  const exported = existsSync(resolve(packageRoot, '../../.sync-provenance.json'));
  if (exported) {
    assert.equal(existsSync(resolve(packageRoot, 'source-tests')), false, 'public export must omit the source tier');
  } else {
    for (const name of archiveConsumers) {
      assert(existsSync(resolve(packageRoot, 'source-tests', name)), `${name} must retain its home source proof`);
    }
  }
});
