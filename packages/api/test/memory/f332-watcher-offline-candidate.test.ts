import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import { resolveWatcherCandidate } from '../../src/infrastructure/harness-eval/watcher-offline/candidate.js';

test('the offline comparison resolves the requested Sonnet instead of treating it as an OpenAI curator', () => {
  const base = catRegistry.tryGet('sonnet');
  assert.ok(base);
  const id = createCatId('f332-offline-sonnet-fixture');
  catRegistry.register(id, {
    ...base.config,
    id,
    clientId: 'anthropic',
    configurationSource: 'native_tool',
    accountRef: undefined,
    defaultModel: 'claude-sonnet-5-5',
  });
  const result = resolveWatcherCandidate(process.cwd(), id);
  assert.equal(result.model, 'claude-sonnet-5-5');
  assert.equal(result.catId, id);
});
