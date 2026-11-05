import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { resolvePublicTestFiles } from '../scripts/resolve-public-test-files.mjs';

const packageRoot = resolve(import.meta.dirname, '..');

test('home managed Alpha integration does not enter public CI while portable Alpha behavior stays covered', async () => {
  const resolved = await resolvePublicTestFiles({ packageRoot });
  const homeIntegration = [
    'test/alpha-managed-lifecycle-integration.test.js',
    'test/alpha-managed-materialization-integration.test.js',
    'test/alpha-managed-scheduler-integration.test.js',
    'test/alpha-managed-sleep-integration.test.js',
  ];
  for (const file of homeIntegration) {
    assert.ok(resolved.excludedFiles.includes(file), `${file} requires the non-exported home Alpha runtime`);
    assert.ok(!resolved.selectedFiles.includes(file));
  }
  const entry = resolved.registry.compiledEntries.find((item) => item.id === 'alpha-managed-home-integration');
  assert.equal(entry.category, 'source_only');
  assert.equal(entry.audit.status, 'source_dependency_failure');
  assert.deepEqual(entry.matchedFiles, homeIntegration);
  for (const file of [
    'test/alpha-browser-template.test.js',
    'test/alpha-managed-job-admission.test.js',
    'test/alpha-managed-observation.test.js',
    'test/alpha-managed-recovery-identity.test.js',
    'test/route-parallel-a2a-failure-report.test.js',
  ]) {
    assert.ok(resolved.selectedFiles.includes(file), `${file} exercises portable product behavior`);
    assert.ok(!resolved.excludedFiles.includes(file));
  }
});
