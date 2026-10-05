import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { collectiveEventSourceIdentity } from '@cat-cafe/shared';
import { catAccepts, createWorld, ownerPolicy, postNaturalRequest } from './f290-communication-validation.harness.js';

/** Production Service/Connector; labeled Human authentication and running Cat fixtures. */
test('a Human future-class automatic grant overrides only its scope while the global policy stays manual', async () => {
  const world = await createWorld();
  try {
    const revision = await world.declareCats(world.operator, ['codex-sol', 'codex-terra']);
    const policy = await world.store.registerCollectiveWorkPolicy(world.operator.sessionToken, {
      ...ownerPolicy(world, world.operator),
      decisionMode: 'manual',
      grants: [
        {
          grantRef: 'grant-guides',
          catIds: ['codex-sol'],
          channelIds: ['general'],
          requestingHumanIds: 'channel_members',
          requestKinds: ['guide'],
          expiresAt: null,
          decisionMode: 'automatic',
        },
      ],
    });
    assert.equal(policy.decisionMode, 'manual');
    await world.operator.connector.adoptWorkPolicy(
      world.operator.connectionId,
      world.operator.ownerUserId,
      policy.revision,
    );
    for (let round = 1; round <= 2; round++) {
      const request = await postNaturalRequest(
        world,
        world.wulang,
        world.operator,
        'codex-sol',
        `Guide ${round}`,
        revision,
      );
      const source = collectiveEventSourceIdentity(request);
      assert.ok(source);
      const decision = await world.operator.connector.currentWorkDecision(source);
      assert.equal(decision.decisionMode, 'manual');
      assert.equal(decision.grants[0]?.decisionMode, 'automatic');
      const accepted = await catAccepts(world, world.operator, request);
      assert.equal(accepted.lifecycle, 'committed');
      assert.equal(accepted.acceptance?.grantRevision, policy.grants[0]?.grantRevision);
    }
    const other = await postNaturalRequest(
      world,
      world.wulang,
      world.operator,
      'codex-sol',
      'Review a contract',
      revision,
    );
    await assert.rejects(catAccepts(world, world.operator, other, { requestKind: 'legal' }), /delegation|scope/i);
    const foreignCat = await postNaturalRequest(
      world,
      world.wulang,
      world.operator,
      'codex-terra',
      'Guide for another Cat',
      revision,
    );
    const source = collectiveEventSourceIdentity(foreignCat);
    assert.ok(source);
    assert.deepEqual((await world.operator.connector.currentWorkDecision(source)).grants, []);
  } finally {
    await world.close();
  }
});

test('grant default-mode changes version inherited authority while explicit class mode remains stable', async () => {
  const world = await createWorld();
  try {
    await world.declareCats(world.operator, ['codex-sol']);
    const grants = [
      {
        grantRef: 'inherited',
        catIds: ['codex-sol'],
        channelIds: ['general'],
        requestingHumanIds: 'channel_members',
        requestKinds: ['guide'],
        expiresAt: null,
      },
      {
        grantRef: 'explicit',
        catIds: ['codex-sol'],
        channelIds: ['general'],
        requestingHumanIds: 'channel_members',
        requestKinds: ['guide'],
        expiresAt: null,
        decisionMode: 'manual',
      },
    ];
    const first = await world.store.registerCollectiveWorkPolicy(world.operator.sessionToken, {
      ...ownerPolicy(world, world.operator),
      decisionMode: 'manual',
      grants,
    });
    const next = await world.store.registerCollectiveWorkPolicy(world.operator.sessionToken, {
      ...ownerPolicy(world, world.operator, { expectedRevision: first.revision, requestId: randomUUID() }),
      decisionMode: 'automatic',
      grants,
    });
    assert.equal(next.grants.find((grant) => grant.grantRef === 'inherited')?.grantRevision, 2);
    assert.equal(next.grants.find((grant) => grant.grantRef === 'explicit')?.grantRevision, 1);
  } finally {
    await world.close();
  }
});

test('a blocked prepared acceptance cannot revive, while a newly registered grant version can accept the same original proposal', async () => {
  const world = await createWorld();
  try {
    const revision = await world.declareCats(world.operator, ['codex-sol']);
    const request = await postNaturalRequest(
      world,
      world.wulang,
      world.operator,
      'codex-sol',
      'Recover the guide',
      revision,
    );
    const source = collectiveEventSourceIdentity(request);
    assert.ok(source);
    const proposal = await world.operator.connector.proposeWork(
      source,
      'original-proposal',
      world.agent('codex-sol', world.startTurn('codex-sol')),
      { title: 'Newcomer guide', intendedOutcome: request.body, requestKind: 'guide' },
    );
    const policy = await world.store.registerCollectiveWorkPolicy(
      world.operator.sessionToken,
      ownerPolicy(world, world.operator),
    );
    await world.operator.connector.adoptWorkPolicy(
      world.operator.connectionId,
      world.operator.ownerUserId,
      policy.revision,
    );
    world.injectFault({ path: '/api/collaboration/work/accept-agent', when: 'before' });
    await assert.rejects(catAccepts(world, world.operator, request), /fetch|reset|transport/i);
    await world.operator.connector.revokeWorkGrants(world.operator.connectionId, world.operator.ownerUserId, [
      'grant-guides',
    ]);
    await assert.rejects(catAccepts(world, world.operator, request, { grantRevision: 1 }), /delegation/i);
    const current = await world.operator.connector.readWorkPolicy(world.operator.connectionId);
    assert.ok(current);
    const next = await world.store.registerCollectiveWorkPolicy(
      world.operator.sessionToken,
      ownerPolicy(world, world.operator, { expectedRevision: current.revision }),
    );
    await world.operator.connector.adoptWorkPolicy(
      world.operator.connectionId,
      world.operator.ownerUserId,
      next.revision,
    );
    const accepted = await catAccepts(world, world.operator, request);
    assert.equal(accepted.workId, proposal.workId);
    assert.equal(accepted.acceptance?.grantRevision, next.grants[0]?.grantRevision);
    await world.restartConnector(world.operator);
    const recovered = await catAccepts(world, world.operator, request);
    assert.equal(recovered.workId, accepted.workId);
    assert.equal(recovered.acceptance?.operationRef, accepted.acceptance?.operationRef);
    assert.equal(
      world.store.listCollectiveCollaboration(world.operator.sessionToken, world.coordinates.collectiveId).works.length,
      1,
    );
  } finally {
    await world.close();
  }
});
