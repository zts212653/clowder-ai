import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolvePublicTestFiles } from '../scripts/resolve-public-test-files.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

test('portable Redis and memory contracts survive the October resource audit', async () => {
  const resolved = await resolvePublicTestFiles({ packageRoot });
  for (const file of [
    'test/action-successor-redis-codecs.test.js',
    'test/approval-hub/redis-canonical-admission-error-boundary.test.js',
    'test/invocation-record-redis-codec.test.js',
    'test/redis-draft-store-created-at.test.js',
    'test/redis-message-parsers-z9-turn-roundtrip.test.js',
    'test/redis-rdb-first-helper.test.js',
    'test/redis-read-state-batch.test.js',
    'test/windows-portable-redis-lifecycle.test.js',
    'test/windows-portable-redis-tools.test.js',
    'test/windows-portable-redis-url.test.js',
    'test/memory/entity-alias-search.test.js',
    'test/memory/entity-mention-index.test.js',
    'test/memory/entity-registry-store.test.js',
    'test/memory/project-init.test.js',
    'test/f254-freshness-replay-provider.test.js',
    'test/f254-provider-native-freshness.test.js',
    'test/harness-eval/eval-hub-metric-glossary-coverage.test.js',
    'test/f296-session-hook-source-auth.test.js',
    'test/f296-b3b3-post-compact-hook.test.js',
  ]) {
    assert.ok(resolved.selectedFiles.includes(file), `${file} supplies portable behavior coverage`);
  }
});

test('retained exclusions identify Redis resources and source executables precisely', async () => {
  const resolved = await resolvePublicTestFiles({ packageRoot });
  const byId = new Map(resolved.registry.entries.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('memory-redis-resource-contracts').category, 'source_only');
  assert.equal(byId.get('memory-redis-resource-contracts').audit.status, 'resource_contract');
  assert.equal(byId.get('signal-fetcher-launchd').audit.status, 'source_dependency_failure');
  assert.equal(byId.get('audit-cc-system-prompt').category, 'source_only');
  assert.equal(byId.get('redis-restore-source-script').audit.status, 'source_dependency_failure');
  for (const file of ['test/redis-thread-store.test.js', 'test/redis-restore-script.test.js']) {
    assert.ok(resolved.excludedFiles.includes(file), `${file} still requires an excluded resource`);
  }
});
