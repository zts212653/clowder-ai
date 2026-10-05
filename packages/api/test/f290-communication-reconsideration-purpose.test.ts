import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './f290-communication-reconsideration.fixture.js';
import { CAT } from './f290-communication-validation.host.js';

test('an owner wake exposes and consumes only its exact registered grant and kind; ordinary public classification retains all valid rules', async () => {
  const f = await fixture();
  try {
    const revision = await f.approve('automatic');
    const current = await f.world.operator.connector.readWorkPolicy(f.world.operator.connectionId);
    assert.ok(current);
    const policy = await f.world.store.registerCollectiveWorkPolicy(f.world.operator.sessionToken, {
      ...f.world.coordinates,
      connectionId: f.world.operator.connectionId,
      expectedRevision: current.revision,
      requestId: 'add-separate-legal-rule',
      decisionMode: 'manual',
      grants: [
        ...current.grants.map(({ grantRevision: _revision, status: _status, ...scope }) => scope),
        {
          grantRef: 'legal-rule',
          catIds: [CAT],
          channelIds: ['general'],
          requestingHumanIds: 'channel_members',
          requestKinds: ['legal'],
          expiresAt: null,
          decisionMode: 'automatic',
        },
      ],
    });
    await f.world.operator.connector.adoptWorkPolicy(f.world.operator.connectionId, f.host.userId, policy.revision);
    const response = await f.post(revision);
    assert.equal(response.statusCode, 200, response.body);
    const headers = await f.callbackAuth(response.json().messageId);
    const read = await f.callbacks.inject({
      method: 'POST',
      url: '/api/callbacks/collective-current-context',
      headers,
      payload: {},
    });
    assert.equal(read.statusCode, 200, read.body);
    assert.deepEqual(
      read.json().workDecision.grants.map((grant: { grantRef: string }) => grant.grantRef),
      ['grant-guides'],
    );
    assert.equal(read.body.includes('collective-reconsider:'), false, 'private purpose coordinate is machine-only');
    const denied = await f.callbacks.inject({
      method: 'POST',
      url: '/api/callbacks/collective-accept-work',
      headers,
      payload: {
        contextRef: read.json().contextRef,
        grantRef: 'legal-rule',
        grantRevision: 1,
        requestKind: 'legal',
        title: 'Borrow another permission',
        intendedOutcome: f.source.content,
      },
    });
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(denied.json().code, 'WORK_AUTHORITY_REQUIRED');
    assert.equal(
      f.world.store.listCollectiveCollaboration(f.world.operator.sessionToken, f.world.coordinates.collectiveId).works
        .length,
      0,
    );
    const ordinaryHeaders = await f.callbackAuth(f.source.id);
    const ordinary = await f.callbacks.inject({
      method: 'POST',
      url: '/api/callbacks/collective-current-context',
      headers: ordinaryHeaders,
      payload: {},
    });
    assert.equal(ordinary.statusCode, 200, ordinary.body);
    assert.equal(ordinary.json().workDecision.grants.length, 2);
  } finally {
    await f.close();
  }
});
