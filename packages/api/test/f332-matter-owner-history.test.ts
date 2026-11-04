import assert from 'node:assert/strict';
import { test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { recallMetricsRoutes } from '../src/routes/recall-metrics.js';
import { recallFixture } from './memory-recall-fixture.js';

test('legacy recall history exposes matter metadata only through the signed owner session', async () => {
  const fixture = await recallFixture();
  const app = Fastify();
  const reads: string[] = [];
  try {
    fixture.invocation('parent');
    fixture.episodes.appendMatterRead({
      scope: { ownerUserId: 'owner', threadId: 'own', invocationId: 'parent' },
      consumerCatId: 'sonnet',
      details: {
        matterId: 'private-matter',
        pageRevision: 1,
        entries: [{ entryId: 'entry', sourceRevision: 'source' }],
      },
    });
    await app.register(cookie);
    await app.register(sessionAuthPlugin);
    await app.register(sessionRoute, { ownerUserId: 'owner' });
    await app.register(recallMetricsRoutes, {
      evidenceDb: fixture.db,
      ...fixture.readers,
      cueSourceReader: {
        read: async (input) => {
          reads.push(input.family);
          return { status: 'ok', payload: { matter: { matterId: 'private-matter', title: 'Private matter title' } } };
        },
      },
    });
    await app.ready();
    const url = '/api/recall/events?threadId=own';
    const forged = await app.inject({ url, headers: { 'x-cat-cafe-user': 'owner' } });
    assert.equal(
      forged.body.includes('Private matter title'),
      false,
      'self-reported owner must not resolve matter metadata',
    );
    assert.deepEqual(forged.json().cueInvocationIds, []);
    assert.deepEqual(reads, []);
    fixture.episodes.append({
      eventId: 'legacy-seed',
      idempotencyKey: 'legacy-seed',
      cueId: 'legacy-seed',
      opportunityId: 'legacy-seed',
      scope: { ownerUserId: 'owner', threadId: 'own', invocationId: 'parent' },
      consumerCatId: 'sonnet',
      resolverFamily: 'cat_owned_seed',
      sourceAnchor: 'seed',
      sourceRevision: 'r1',
      axis: 'consumption',
      consumptionOutcome: 'presented',
      catalogVersion: 1,
      resolverVersion: 1,
      occurredAt: fixture.now,
    });
    const mixed = await app.inject({ url, headers: { 'x-cat-cafe-user': 'owner' } });
    assert.deepEqual(mixed.json().cueInvocationIds, ['parent'], 'legacy history remains readable');
    assert.equal(mixed.body.includes('Private matter title'), false);
    assert.equal(mixed.body.includes('private-matter'), false);
    assert.deepEqual(reads, [], 'a readable legacy cue must not authorize matter hydration in the same invocation');
    const session = await app.inject({ url: '/api/session' });
    const rawCookie = session.headers['set-cookie'];
    assert.ok(typeof rawCookie === 'string');
    const response = await app.inject({ url, headers: { cookie: rawCookie.split(';', 1)[0] } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().cueInvocationIds, ['parent']);
    assert.ok(response.json().sourceViews.some((view: { title?: string }) => view.title === 'Private matter title'));
    assert.deepEqual(reads, ['matter']);
  } finally {
    await app.close();
    await fixture.close();
  }
});
