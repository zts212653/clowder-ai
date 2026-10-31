import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';

let sequence = 0;
function event(outcome, overrides = {}) {
  sequence += 1;
  return {
    eventId: `event-${sequence}`,
    idempotencyKey: `key-${sequence}`,
    cueId: 'cue-1',
    opportunityId: `opportunity-${sequence}`,
    scope: { ownerUserId: 'owner', threadId: 'thread-1', invocationId: 'invocation-1' },
    consumerCatId: 'kimi',
    resolverFamily: 'taste',
    sourceAnchor: 'taste:example',
    sourceRevision: 'rev-1',
    axis: 'consumption',
    consumptionOutcome: outcome,
    catalogVersion: 1,
    resolverVersion: 1,
    occurredAt: sequence * 1000,
    ...overrides,
  };
}

describe('F321 A1b: source-anchor cue summary', () => {
  let app;
  let db;
  let store;

  beforeEach(async () => {
    sequence = 0;
    const { applyMigrations } = await import('../dist/domains/memory/schema.js');
    const { MemoryCueEpisodeStore } = await import('../dist/domains/memory/cue/MemoryCueEpisodeStore.js');
    const { memoryCueSourceSummaryRoutes } = await import('../dist/routes/memory-cue-source-summary.js');
    db = new Database(':memory:');
    applyMigrations(db);
    store = new MemoryCueEpisodeStore(db);
    app = Fastify({ logger: false });
    await app.register(memoryCueSourceSummaryRoutes, { evidenceDb: db });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  function get(anchor = 'taste:example', headers = { 'x-cat-cafe-user': 'owner' }) {
    return app.inject({
      method: 'GET',
      url: `/api/memory/cues/source-summary?resolverFamily=taste&sourceAnchor=${encodeURIComponent(anchor)}`,
      headers,
    });
  }

  it('counts only the requested owner, family and anchor, and reports latest presentation outcome', async () => {
    store.append(event('presented'));
    store.append(event('applied'));
    store.append(
      event('presented', {
        cueId: 'cue-2',
        scope: { ownerUserId: 'owner', threadId: 'thread-2', invocationId: 'invocation-2' },
      }),
    );
    store.append(
      event('drilled', {
        cueId: 'cue-2',
        scope: { ownerUserId: 'owner', threadId: 'thread-2', invocationId: 'invocation-2' },
      }),
    );
    store.append(
      event('presented', {
        cueId: 'other-owner',
        scope: { ownerUserId: 'other', threadId: 'secret-thread', invocationId: 'secret' },
      }),
    );
    store.append(event('presented', { cueId: 'other-anchor', sourceAnchor: 'taste:other' }));
    store.append(event('presented', { cueId: 'other-family', resolverFamily: 'profile' }));

    const response = await get();
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().counts, { presented: 2, drilled: 1, applied: 1, dismissed: 0 });
    assert.deepEqual(response.json().latest, {
      threadId: 'thread-2',
      invocationId: 'invocation-2',
      outcome: 'drilled',
      presentedAt: 3000,
    });
    assert.equal(JSON.stringify(response.json()).includes('secret-thread'), false);
  });

  it('keeps a terminal outcome when the latest cue is drilled again, and preserves zero state', async () => {
    assert.deepEqual((await get()).json().counts, { presented: 0, drilled: 0, applied: 0, dismissed: 0 });
    assert.equal((await get()).json().latest, null);
    store.append(event('presented'));
    store.append(event('dismissed'));
    store.append(event('drilled'));
    assert.equal((await get()).json().latest.outcome, 'dismissed');
  });

  it('fails closed on missing identity and malformed source coordinates', async () => {
    assert.equal((await get('taste:example', {})).statusCode, 401);
    assert.equal((await get('taste:example', { origin: 'http://localhost:3004' })).statusCode, 401);
    assert.equal(
      (await get('taste:example', { 'x-cat-cafe-user': 'owner', 'x-forwarded-for': '203.0.113.1' })).statusCode,
      401,
    );
    assert.equal((await get('')).statusCode, 400);
    const malformed = await app.inject({
      method: 'GET',
      url: '/api/memory/cues/source-summary?resolverFamily=unknown&sourceAnchor=taste%3Aexample',
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(malformed.statusCode, 400);
  });

  it('never returns source text or raw prompt fields', async () => {
    store.append(event('presented'));
    const payload = (await get()).json();
    assert.deepEqual(Object.keys(payload).sort(), ['counts', 'latest', 'resolverFamily', 'sourceAnchor']);
    assert.deepEqual(Object.keys(payload.latest).sort(), ['invocationId', 'outcome', 'presentedAt', 'threadId']);
    for (const forbidden of ['prompt', 'body', 'whyNow', 'summary', 'rationale']) {
      assert.equal(JSON.stringify(payload).includes(`"${forbidden}"`), false);
    }
  });

  it('shows invalidation on the latest cue without changing consumption counts', async () => {
    store.append(event('presented'));
    const obsolete = event('drilled');
    delete obsolete.consumptionOutcome;
    store.append({ ...obsolete, axis: 'invalidation', invalidationReason: 'source_corrected' });
    const payload = (await get()).json();
    assert.deepEqual(payload.counts, { presented: 1, drilled: 0, applied: 0, dismissed: 0 });
    assert.equal(payload.latest.outcome, 'invalidated');
  });
});
