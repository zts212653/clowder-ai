import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { publicTestExclusionMatchHash, resolvePublicTestFiles } from '../scripts/resolve-public-test-files.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

test('public selection excludes only audited raw archive consumers and retains portable exploration behavior', async () => {
  const resolved = await resolvePublicTestFiles({ packageRoot });
  const privateFiles = [
    'test/capability-evolution-exploration-archive-projection.test.js',
    'test/capability-evolution-exploration-football.test.js',
    'test/capability-evolution-exploration-integrity.test.js',
    'test/capability-evolution-exploration-record-failures.test.js',
  ];
  for (const file of privateFiles) {
    assert(resolved.excludedFiles.includes(file), `${file} requires the non-exported raw archive bundle`);
    assert(!resolved.selectedFiles.includes(file));
  }
  for (const file of [
    'test/capability-evolution-exploration-projection-failure.test.js',
    'test/capability-evolution-exploration-source-isolation.test.js',
    'test/capability-evolution-exploration-routes.test.js',
    'test/capability-evolution-exploration-failure-routes.test.js',
    'test/capability-evolution-exploration-message-routing.test.js',
  ]) {
    assert(resolved.selectedFiles.includes(file), `${file} must keep protecting the public product`);
    assert(!resolved.excludedFiles.includes(file));
  }
  const entry = resolved.registry.entries.find((candidate) => candidate.id === 'exploration-private-football-archive');
  assert(entry, 'the exact private-resource boundary must have a real audited exclusion');
  assert.equal(entry.category, 'private_fixture');
  assert.equal(entry.audit.status, 'private_fixture_failure');
  assert.equal(entry.audit.matchedFileCount, privateFiles.length);
  assert.equal(entry.audit.matchedFilesHash, publicTestExclusionMatchHash(privateFiles));
  const matchedFiles = [...resolved.selectedFiles, ...resolved.excludedFiles]
    .filter((file) => new RegExp(entry.match).test(file))
    .sort();
  assert.deepEqual(matchedFiles, privateFiles);
});
