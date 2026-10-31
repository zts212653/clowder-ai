import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareCanonicalWorkspaceReview } from '../src/domains/collaborative-content/workspace-review/workspace-review-preparation.js';
import { cleanupFixtureRoots, fixture, principal } from './workspace-content-review-service.fixture.js';

test('two authenticated Humans resolve one scoped F309 ledger and legacy private APIs cannot read it', async (t) => {
  const f = await fixture();
  t.after(() => {
    f.store.close();
    return cleanupFixtureRoots();
  });
  const source = {
    kind: 'collective-artifact',
    revision: `sha256:${'a'.repeat(64)}`,
    ownerRevision: 1,
    mime: 'text/markdown',
    byteLength: 50,
  } as const;
  const collaborationScope = {
    kind: 'collective-artifact',
    scopeRef: 'collective-owner:shared',
    serviceInstanceId: 'service-shared',
    collectiveId: 'collective-shared',
    artifactId: 'artifact-shared',
  } as const;
  const prepare = (humanId: string) =>
    prepareCanonicalWorkspaceReview(
      f.store,
      { contentRef: 'collective-content:shared', source },
      {
        principal: { userId: 'operator', actor: { kind: 'human', actorId: humanId } },
        operationId: `prepare:${humanId}`,
        request: { source },
        collaborationScope,
      },
      '2026-10-16T13:00:00.000Z',
    );
  const alice = prepare('human-alice');
  const bob = prepare('human-bob');
  assert.equal(alice.reviewId, bob.reviewId);
  assert.equal(alice.ownerUserId, 'operator', 'legacy provenance remains a real local owner');
  assert.deepEqual(alice.collaborationScope, collaborationScope);
  assert.equal(
    f.store.getByContent('operator', alice.contentRef),
    null,
    'a private content lookup cannot find a shared ledger',
  );
  await assert.rejects(f.reviews.read({ principal, reviewId: alice.reviewId }), { code: 'access_denied' });
  f.store.retained.retain(alice.reviewId, alice.revision);
  await assert.rejects(f.reviews.retainedRevision({ principal, reviewId: alice.reviewId, revision: alice.revision }), {
    code: 'access_denied',
  });
});
