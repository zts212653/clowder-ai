import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RECALL_RESOLVER_FAMILIES, type RecallResolverFamily } from '@cat-cafe/shared';
import type { MemoryCueEventInput } from '../src/domains/memory/cue/MemoryCueEpisodeStore.js';
import { recallFixture } from './memory-recall-fixture.js';

function cue(
  now: number,
  id: string,
  family: RecallResolverFamily = 'taste',
  invocationId = 'parent',
): MemoryCueEventInput {
  return {
    eventId: `event-${id}`,
    idempotencyKey: `key-${id}`,
    cueId: id,
    opportunityId: `opportunity-${id}`,
    scope: { ownerUserId: 'owner', threadId: 'own', invocationId },
    consumerCatId: 'kimi',
    resolverFamily: family,
    sourceAnchor: family === 'person_entity' ? 'person:person_visible' : `source-${id}`,
    sourceRevision: 'revision-1',
    axis: 'consumption',
    consumptionOutcome: 'presented',
    catalogVersion: 1,
    resolverVersion: 1,
    occurredAt: now - 1000,
  };
}

test('all declared exact-delivery families preserve producer status and source owner scope without drilling seeds', async () => {
  const reads: Array<{ family: string; owner: string; invocationId: string; revision: string }> = [];
  const f = await recallFixture((readers) => {
    readers.personMemoryStore = {
      getPerson: async () => ({ ownerUserId: 'owner', displayName: '主人已批准人物', status: 'active' }),
    };
    readers.cueSourceReader = {
      read: async (input) => {
        reads.push({
          family: input.family,
          owner: input.scope.ownerUserId,
          invocationId: input.scope.invocationId,
          revision: input.expectedRevision,
        });
        return {
          status: 'ok',
          payload: {
            vignette: { when: '真实品味标题' },
            summary: '真实事件标题',
            profileUri: 'cat-cafe-profile://corpus/current',
          },
        };
      },
    };
  });
  try {
    f.invocation('parent');
    for (const family of RECALL_RESOLVER_FAMILIES) f.episodes.append(cue(f.now, family, family));
    const response = await f.get('?source=push');
    const body = response.json();
    assert.equal(body.records.length, RECALL_RESOLVER_FAMILIES.length);
    assert.deepEqual(
      body.records.map((row: { event: { resolverFamily: string } }) => row.event.resolverFamily).sort(),
      [...RECALL_RESOLVER_FAMILIES].sort(),
    );
    assert.ok(
      body.records.every((row: { event: { cueStatus: string } }) => row.event.cueStatus === 'presented_unreported'),
    );
    assert.ok(
      reads.every((read) => read.owner === 'owner' && read.invocationId === 'parent' && read.revision === 'revision-1'),
    );
    assert.equal(
      reads.some((read) => read.family === 'owned_seed'),
      false,
    );
    assert.equal(response.body.includes('drillHandle'), false);
    assert.equal(response.body.includes('payload'), false);
    assert.equal((await f.get('?source=pull')).json().records.length, 0);
  } finally {
    await f.close();
  }
});

test('latest consumption and invalidation remain distinct and first presented time owns the window', async () => {
  const f = await recallFixture();
  try {
    f.invocation('parent');
    for (const outcome of ['drilled', 'applied', 'dismissed'] as const) {
      const presented = cue(f.now, outcome);
      f.episodes.append(presented);
      f.episodes.append({
        ...presented,
        eventId: `${outcome}-terminal`,
        idempotencyKey: `${outcome}-terminal`,
        consumptionOutcome: outcome,
        occurredAt: f.now - 500,
      });
    }
    const presented = cue(f.now, 'invalidated');
    f.episodes.append(presented);
    const { consumptionOutcome: _outcome, ...base } = presented;
    f.episodes.append({
      ...base,
      eventId: 'invalidation',
      idempotencyKey: 'invalidation',
      axis: 'invalidation',
      invalidationReason: 'source_forgotten',
      occurredAt: f.now - 100,
    });
    const old = cue(f.now, 'old');
    f.episodes.append({ ...old, occurredAt: f.now - 10 * 86400000 });
    f.episodes.append({
      ...old,
      eventId: 'old-represented',
      idempotencyKey: 'old-represented',
      occurredAt: f.now - 100,
    });
    const body = (await f.get()).json();
    assert.deepEqual(body.records.map((row: { event: { cueStatus: string } }) => row.event.cueStatus).sort(), [
      'applied',
      'dismissed',
      'drilled',
      'invalidated',
    ]);
    assert.equal((await f.get('?days=14')).json().records.length, 5);
  } finally {
    await f.close();
  }
});

test('child invocation access revalidates parent owner and thread; denied cues cannot leak source titles', async () => {
  let reads = 0;
  const f = await recallFixture((readers) => {
    readers.cueSourceReader = {
      read: async () => {
        reads++;
        return { status: 'ok', payload: { vignette: { when: '可读标题' } } };
      },
    };
  });
  try {
    f.invocation('parent');
    f.invocation('foreign', 'other-owner');
    f.invocation('wrong-thread', 'owner', 'other');
    f.turn('child-ok', 'parent');
    f.turn('child-foreign', 'foreign');
    f.turn('child-thread', 'wrong-thread');
    f.turn('orphan', 'absent');
    for (const id of ['child-ok', 'child-foreign', 'child-thread', 'orphan', 'absent', 'foreign'])
      f.episodes.append(cue(f.now, id, 'taste', id));
    const body = (await f.get()).json();
    assert.equal(body.readStatus, 'partial');
    assert.equal(body.records.length, 1);
    assert.equal(body.records[0].event.invocationId, 'child-ok');
    assert.equal(reads, 1);
  } finally {
    await f.close();
  }
});

test('foreign private person and source revision drift expose unavailable metadata, never another owner body', async () => {
  const f = await recallFixture((readers) => {
    readers.personMemoryStore = {
      getPerson: async () => ({ ownerUserId: 'other-owner', displayName: '其他主人的秘密名字', status: 'active' }),
    };
    readers.cueSourceReader = {
      read: async () => ({ status: 'not_available', invalidationReason: 'source_corrected' }),
    };
  });
  try {
    f.invocation('parent');
    f.episodes.append(cue(f.now, 'person', 'person_entity'));
    f.episodes.append(cue(f.now, 'taste'));
    const response = await f.get();
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().readStatus, 'partial');
    assert.equal(response.body.includes('秘密名字'), false);
    assert.equal(response.json().records.length, 2);
    assert.ok(
      response
        .json()
        .records.every((row: { event: { results: Array<{ href: unknown }> } }) => row.event.results[0].href === null),
    );
  } finally {
    await f.close();
  }
});
