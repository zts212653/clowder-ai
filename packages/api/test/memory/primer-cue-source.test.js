import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrimerMemoryCueSource } from '../../dist/domains/memory/cue/sources/PrimerMemoryCueSource.js';

test('primer pointer binds owner, persona and current revision without indexing or listing', async () => {
  let relationshipKey = 'relationship';
  let current = { revision: 'v1', content: 'approved v1' };
  const source = new PrimerMemoryCueSource({
    scope: (ownerUserId, consumerCatId) => ({ ownerUserId, consumerCatId, relationshipKey }),
    readPrimer: (scope) => (scope.ownerUserId === 'owner' ? current : null),
  });
  const pointer = source.resolvePrimer('owner', 'cat');
  assert.equal(pointer.revision, 'v1');
  assert.ok(!JSON.stringify(pointer).includes('approved v1'));
  const input = {
    ownerUserId: 'owner',
    consumerCatId: 'cat',
    anchor: pointer.anchor,
    expectedRevision: pointer.revision,
  };
  assert.equal((await source.read(input)).payload.content, 'approved v1');
  current = { revision: 'v2', content: 'approved v2' };
  assert.equal((await source.read(input)).invalidationReason, 'source_corrected');
  current = null;
  assert.equal((await source.read(input)).invalidationReason, 'source_forgotten');
  relationshipKey = 'other';
  assert.equal((await source.read(input)).invalidationReason, 'scope_revoked');
  assert.equal(source.resolvePrimer('different-owner', 'cat'), null);
});
